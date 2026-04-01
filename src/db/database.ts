import { type Client } from "@libsql/client";
import { initializeDatabase } from "./schema";
import * as Q from "./queries";

/**
 * Sanitize user input for FTS5 MATCH queries.
 * Wraps each token in double quotes so special characters
 * (., *, +, -, :, ^, etc.) are treated as literals.
 */
export function sanitizeFtsQuery(raw: string): string {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '""';
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

export interface MessageRow {
  id: number;
  source: string;
  source_id: string;
  channel_name: string | null;
  thread_id: string | null;
  author_name: string | null;
  content: string;
  sent_at: number;
  metadata: string | null;
  rank?: number;
}

export interface EmbeddingStats {
  total_messages: number;
  embedded_messages: number;
}

export interface ChunkEmbeddingStats {
  total_chunks: number;
  embedded_chunks: number;
}

export interface Stats {
  total_messages: number;
  total_channels: number;
  total_contacts: number;
}

/** Convert Float32Array to Uint8Array for @libsql/client args. */
function f32ToBytes(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

export class TraulDB {
  private constructor(private db: Client) {}

  static async create(path: string): Promise<TraulDB> {
    const db = await initializeDatabase(path);
    return new TraulDB(db);
  }

  async upsertMessage(msg: {
    source: string;
    source_id: string;
    channel_id?: string;
    channel_name?: string;
    thread_id?: string;
    author_id?: string;
    author_name?: string;
    content: string;
    sent_at: number;
    metadata?: string;
  }): Promise<void> {
    await this.db.execute({
      sql: Q.UPSERT_MESSAGE,
      args: [
        msg.source,
        msg.source_id,
        msg.channel_id ?? null,
        msg.channel_name ?? null,
        msg.thread_id ?? null,
        msg.author_id ?? null,
        msg.author_name ?? null,
        msg.content,
        msg.sent_at,
        msg.metadata ?? null,
      ],
    });
  }

  async upsertContact(displayName: string): Promise<number> {
    const result = await this.db.execute({
      sql: Q.UPSERT_CONTACT,
      args: [displayName],
    });
    return (result.rows[0] as any).id;
  }

  async upsertContactIdentity(identity: {
    contactId: number;
    source: string;
    sourceUserId: string;
    username?: string;
    displayName?: string;
  }): Promise<void> {
    await this.db.execute({
      sql: Q.UPSERT_CONTACT_IDENTITY,
      args: [
        identity.contactId,
        identity.source,
        identity.sourceUserId,
        identity.username ?? null,
        identity.displayName ?? null,
      ],
    });
  }

  async getContactBySourceId(
    source: string,
    sourceUserId: string
  ): Promise<{ id: number; display_name: string } | null> {
    const result = await this.db.execute({
      sql: Q.GET_CONTACT_BY_SOURCE_ID,
      args: [source, sourceUserId],
    });
    if (result.rows.length === 0) return null;
    return result.rows[0] as unknown as { id: number; display_name: string };
  }

  async hasMessage(source: string, sourceId: string): Promise<boolean> {
    const result = await this.db.execute({
      sql: Q.HAS_MESSAGE,
      args: [source, sourceId],
    });
    return result.rows.length > 0;
  }

  async getSyncCursor(source: string, key: string): Promise<string | null> {
    const result = await this.db.execute({
      sql: Q.GET_SYNC_CURSOR,
      args: [source, key],
    });
    if (result.rows.length === 0) return null;
    return (result.rows[0] as any).cursor_value ?? null;
  }

  async setSyncCursor(source: string, key: string, value: string): Promise<void> {
    await this.db.execute({
      sql: Q.SET_SYNC_CURSOR,
      args: [source, key, value],
    });
  }

  async searchMessages(
    query: string,
    options?: {
      source?: string;
      channel?: string;
      after?: number;
      before?: number;
      limit?: number;
    }
  ): Promise<MessageRow[]> {
    const limit = options?.limit ?? 20;
    const conditions: string[] = [];
    const params: (string | number)[] = [sanitizeFtsQuery(query)];

    if (options?.source) {
      conditions.push("m.source = ?");
      params.push(options.source);
    }
    if (options?.channel) {
      conditions.push("m.channel_name LIKE ?");
      params.push(`%${options.channel}%`);
    }
    if (options?.after) {
      conditions.push("m.sent_at > ?");
      params.push(options.after);
    }
    if (options?.before) {
      conditions.push("m.sent_at < ?");
      params.push(options.before);
    }

    let sql = Q.SEARCH_MESSAGES_FILTERED;
    if (conditions.length > 0) {
      sql += " AND " + conditions.join(" AND ");
    }
    sql += " ORDER BY rank LIMIT ?";
    params.push(limit);

    const result = await this.db.execute({ sql, args: params });
    return result.rows as unknown as MessageRow[];
  }

  async getStats(): Promise<Stats> {
    const result = await this.db.execute(Q.GET_STATS);
    return result.rows[0] as unknown as Stats;
  }

  async getMessages(options?: {
    channel?: string;
    channelLike?: string;
    author?: string;
    source?: string;
    after?: number;
    before?: number;
    limit?: number;
    asc?: boolean;
  }): Promise<MessageRow[]> {
    const limit = options?.limit ?? 50;
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options?.channel) {
      conditions.push("m.channel_name = ?");
      params.push(options.channel);
    }
    if (options?.channelLike) {
      conditions.push("m.channel_name LIKE ?");
      params.push(`%${options.channelLike}%`);
    }
    if (options?.author) {
      conditions.push("m.author_name LIKE ?");
      params.push(`%${options.author}%`);
    }
    if (options?.source) {
      conditions.push("m.source = ?");
      params.push(options.source);
    }
    if (options?.after) {
      conditions.push("m.sent_at >= ?");
      params.push(options.after);
    }
    if (options?.before) {
      conditions.push("m.sent_at <= ?");
      params.push(options.before);
    }

    let sql = Q.GET_MESSAGES;
    if (conditions.length > 0) {
      sql += " AND " + conditions.join(" AND ");
    }
    sql += ` ORDER BY m.sent_at ${options?.asc ? "ASC" : "DESC"} LIMIT ?`;
    params.push(limit);

    const result = await this.db.execute({ sql, args: params });
    return result.rows as unknown as MessageRow[];
  }

  async getChannels(options?: {
    source?: string;
    search?: string;
  }): Promise<Array<{ source: string; channel_name: string; msg_count: number; last_message: number }>> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options?.source) {
      conditions.push("source = ?");
      params.push(options.source);
    }
    if (options?.search) {
      conditions.push("channel_name LIKE ?");
      params.push(`%${options.search}%`);
    }

    let sql = Q.GET_CHANNELS;
    if (conditions.length > 0) {
      sql = sql.replace("WHERE 1=1", "WHERE 1=1 AND " + conditions.join(" AND "));
    }

    const result = await this.db.execute({ sql, args: params });
    return result.rows as unknown as Array<{ source: string; channel_name: string; msg_count: number; last_message: number }>;
  }

  async insertEmbedding(messageId: number, embedding: Float32Array): Promise<void> {
    await this.db.execute({
      sql: Q.INSERT_EMBEDDING,
      args: [f32ToBytes(embedding), messageId],
    });
  }

  async getUnembeddedMessages(limit: number = 100): Promise<Array<{ id: number; content: string }>> {
    const result = await this.db.execute({
      sql: Q.GET_UNEMBEDDED_MESSAGES,
      args: [limit],
    });
    return result.rows as unknown as Array<{ id: number; content: string }>;
  }

  async vectorSearch(
    embedding: Float32Array,
    options?: {
      source?: string;
      channel?: string;
      after?: number;
      before?: number;
      limit?: number;
    }
  ): Promise<MessageRow[]> {
    const k = options?.limit ?? 20;
    const conditions: string[] = [];
    const params: (Uint8Array | string | number)[] = [f32ToBytes(embedding)];

    if (options?.source) {
      conditions.push("m.source = ?");
      params.push(options.source);
    }
    if (options?.channel) {
      conditions.push("m.channel_name LIKE ?");
      params.push(`%${options.channel}%`);
    }
    if (options?.after) {
      conditions.push("m.sent_at > ?");
      params.push(options.after);
    }
    if (options?.before) {
      conditions.push("m.sent_at < ?");
      params.push(options.before);
    }

    let sql = Q.VECTOR_SEARCH;
    if (conditions.length > 0) {
      sql += " AND " + conditions.join(" AND ");
    }
    sql += " ORDER BY distance ASC LIMIT ?";
    params.push(k);

    const result = await this.db.execute({ sql, args: params as any });
    return result.rows as unknown as MessageRow[];
  }

  async vectorSearchAll(
    embedding: Float32Array,
    options?: {
      source?: string;
      channel?: string;
      after?: number;
      before?: number;
      limit?: number;
    }
  ): Promise<MessageRow[]> {
    const limit = options?.limit ?? 20;
    const k = limit * 3;

    const vecMessages = await this.vectorSearch(embedding, { ...options, limit: k });
    const vecChunks = await this.vectorSearchChunks(embedding, { ...options, limit: k });

    return this.rrfMerge([vecMessages, vecChunks], limit);
  }

  async ftsSearchAll(
    query: string,
    options?: {
      source?: string;
      channel?: string;
      after?: number;
      before?: number;
      limit?: number;
    }
  ): Promise<MessageRow[]> {
    const limit = options?.limit ?? 20;
    const k = limit * 3;

    const ftsMessages = await this.searchMessages(query, { ...options, limit: k });
    const ftsChunks = await this.searchChunks(query, { ...options, limit: k });

    return this.rrfMerge([ftsMessages, ftsChunks], limit);
  }

  /** FTS search only unembedded messages (backfill for cold start) */
  private async ftsBackfillMessages(
    query: string,
    options?: {
      source?: string;
      channel?: string;
      after?: number;
      before?: number;
      limit?: number;
    }
  ): Promise<MessageRow[]> {
    const limit = options?.limit ?? 20;
    const conditions: string[] = [];
    const params: (string | number)[] = [sanitizeFtsQuery(query)];

    if (options?.source) {
      conditions.push("m.source = ?");
      params.push(options.source);
    }
    if (options?.channel) {
      conditions.push("m.channel_name LIKE ?");
      params.push(`%${options.channel}%`);
    }
    if (options?.after) {
      conditions.push("m.sent_at > ?");
      params.push(options.after);
    }
    if (options?.before) {
      conditions.push("m.sent_at < ?");
      params.push(options.before);
    }

    let sql = Q.FTS_BACKFILL_MESSAGES;
    if (conditions.length > 0) {
      sql += " AND " + conditions.join(" AND ");
    }
    sql += " ORDER BY rank LIMIT ?";
    params.push(limit);

    const result = await this.db.execute({ sql, args: params });
    return result.rows as unknown as MessageRow[];
  }

  /** FTS search only unembedded chunks (backfill for cold start) */
  private async ftsBackfillChunks(
    query: string,
    options?: {
      source?: string;
      channel?: string;
      after?: number;
      before?: number;
      limit?: number;
    }
  ): Promise<MessageRow[]> {
    const limit = options?.limit ?? 20;
    const conditions: string[] = [];
    const params: (string | number)[] = [sanitizeFtsQuery(query)];

    if (options?.source) {
      conditions.push("m.source = ?");
      params.push(options.source);
    }
    if (options?.channel) {
      conditions.push("m.channel_name LIKE ?");
      params.push(`%${options.channel}%`);
    }
    if (options?.after) {
      conditions.push("m.sent_at > ?");
      params.push(options.after);
    }
    if (options?.before) {
      conditions.push("m.sent_at < ?");
      params.push(options.before);
    }

    let sql = Q.FTS_BACKFILL_CHUNKS;
    if (conditions.length > 0) {
      sql += " AND " + conditions.join(" AND ");
    }
    sql += " ORDER BY rank LIMIT ?";
    params.push(limit);

    const result = await this.db.execute({ sql, args: params });
    return result.rows as unknown as MessageRow[];
  }

  /** Hybrid search: vector for embedded messages, FTS backfill for the rest */
  async hybridSearchAll(
    embedding: Float32Array,
    query: string,
    options?: {
      source?: string;
      channel?: string;
      after?: number;
      before?: number;
      limit?: number;
    }
  ): Promise<MessageRow[]> {
    const limit = options?.limit ?? 20;
    const k = limit * 3;

    // Vector search over embedded content
    const vecMessages = await this.vectorSearch(embedding, { ...options, limit: k });
    const vecChunks = await this.vectorSearchChunks(embedding, { ...options, limit: k });
    const vectorResults = this.rrfMerge([vecMessages, vecChunks], limit);

    // FTS backfill over unembedded content only
    const backfillMessages = await this.ftsBackfillMessages(query, { ...options, limit: k });
    const backfillChunks = await this.ftsBackfillChunks(query, { ...options, limit: k });
    const backfillResults = this.rrfMerge([backfillMessages, backfillChunks], limit);

    // Vector results first, then backfill (deduped by message id)
    const seen = new Set<number>();
    const combined: MessageRow[] = [];

    for (const msg of vectorResults) {
      seen.add(msg.id);
      combined.push(msg);
    }
    for (const msg of backfillResults) {
      if (!seen.has(msg.id) && combined.length < limit) {
        seen.add(msg.id);
        combined.push(msg);
      }
    }

    return combined;
  }

  async likeSearchAll(
    query: string,
    options?: {
      source?: string;
      channel?: string;
      after?: number;
      before?: number;
      limit?: number;
    }
  ): Promise<MessageRow[]> {
    const limit = options?.limit ?? 20;
    const k = limit * 3;

    const likeMessages = await this.likeSearchMessages(query, { ...options, limit: k });
    const likeChunks = await this.likeSearchChunks(query, { ...options, limit: k });

    return this.rrfMerge([likeMessages, likeChunks], limit);
  }

  private async likeSearchMessages(
    query: string,
    options?: {
      source?: string;
      channel?: string;
      after?: number;
      before?: number;
      limit?: number;
    }
  ): Promise<MessageRow[]> {
    const limit = options?.limit ?? 20;
    const conditions: string[] = [];
    const params: (string | number)[] = [query];

    if (options?.source) {
      conditions.push("m.source = ?");
      params.push(options.source);
    }
    if (options?.channel) {
      conditions.push("m.channel_name LIKE ?");
      params.push(`%${options.channel}%`);
    }
    if (options?.after) {
      conditions.push("m.sent_at > ?");
      params.push(options.after);
    }
    if (options?.before) {
      conditions.push("m.sent_at < ?");
      params.push(options.before);
    }

    let sql = Q.LIKE_SEARCH_MESSAGES;
    if (conditions.length > 0) {
      sql += " AND " + conditions.join(" AND ");
    }
    sql += " ORDER BY m.sent_at DESC LIMIT ?";
    params.push(limit);

    const result = await this.db.execute({ sql, args: params });
    return result.rows as unknown as MessageRow[];
  }

  private async likeSearchChunks(
    query: string,
    options?: {
      source?: string;
      channel?: string;
      after?: number;
      before?: number;
      limit?: number;
    }
  ): Promise<MessageRow[]> {
    const limit = options?.limit ?? 20;
    const conditions: string[] = [];
    const params: (string | number)[] = [query];

    if (options?.source) {
      conditions.push("m.source = ?");
      params.push(options.source);
    }
    if (options?.channel) {
      conditions.push("m.channel_name LIKE ?");
      params.push(`%${options.channel}%`);
    }
    if (options?.after) {
      conditions.push("m.sent_at > ?");
      params.push(options.after);
    }
    if (options?.before) {
      conditions.push("m.sent_at < ?");
      params.push(options.before);
    }

    let sql = Q.LIKE_SEARCH_CHUNKS;
    if (conditions.length > 0) {
      sql += " AND " + conditions.join(" AND ");
    }
    sql += " ORDER BY m.sent_at DESC LIMIT ?";
    params.push(limit);

    const result = await this.db.execute({ sql, args: params });
    return result.rows as unknown as MessageRow[];
  }

  private rrfMerge(resultSets: MessageRow[][], limit: number): MessageRow[] {
    const RRF_K = 60;
    const scores = new Map<string, { score: number; msg: MessageRow }>();

    for (const results of resultSets) {
      results.forEach((msg, i) => {
        const rrf = 1.0 / (RRF_K + i + 1);
        const key = `${msg.id}:${msg.content.slice(0, 50)}`;
        const existing = scores.get(key);
        if (existing) {
          existing.score += rrf;
        } else {
          scores.set(key, { score: rrf, msg });
        }
      });
    }

    return [...scores.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.msg);
  }

  async getEmbeddingStats(): Promise<EmbeddingStats> {
    const result = await this.db.execute(Q.EMBEDDING_STATS);
    return result.rows[0] as unknown as EmbeddingStats;
  }

  async deleteOrphanedEmbeddings(): Promise<number> {
    const result = await this.db.execute(Q.DELETE_ORPHANED_EMBEDDINGS);
    return result.rowsAffected;
  }

  async deleteOrphanedChunkEmbeddings(): Promise<number> {
    const result = await this.db.execute(Q.DELETE_ORPHANED_CHUNK_EMBEDDINGS);
    return result.rowsAffected;
  }

  async deleteOrphanedChunks(): Promise<number> {
    const result = await this.db.execute(Q.DELETE_ORPHANED_CHUNKS);
    return result.rowsAffected;
  }

  async replaceChunks(messageId: number, chunks: Array<{ index: number; content: string; embeddingInput: string }>): Promise<void> {
    await this.db.execute({ sql: Q.REPLACE_CHUNKS_DELETE, args: [messageId] });
    for (const chunk of chunks) {
      await this.db.execute({ sql: Q.INSERT_CHUNK, args: [messageId, chunk.index, chunk.content, chunk.embeddingInput] });
    }
  }

  async getUnchunkedLongMessages(threshold: number, limit: number): Promise<Array<{ id: number; content: string }>> {
    const result = await this.db.execute({
      sql: Q.GET_UNCHUNKED_LONG_MESSAGES,
      args: [threshold, limit],
    });
    return result.rows as unknown as Array<{ id: number; content: string }>;
  }

  async deleteMessageEmbedding(messageId: number): Promise<void> {
    await this.db.execute({
      sql: "UPDATE messages SET embedding = NULL WHERE id = ?",
      args: [messageId],
    });
  }

  async getUnembeddedChunks(limit: number = 100): Promise<Array<{ id: number; content: string }>> {
    const result = await this.db.execute({
      sql: Q.GET_UNEMBEDDED_CHUNKS,
      args: [limit],
    });
    return result.rows as unknown as Array<{ id: number; content: string }>;
  }

  async insertChunkEmbedding(chunkId: number, embedding: Float32Array): Promise<void> {
    await this.db.execute({
      sql: Q.INSERT_CHUNK_EMBEDDING,
      args: [f32ToBytes(embedding), chunkId],
    });
  }

  async getChunkEmbeddingStats(): Promise<ChunkEmbeddingStats> {
    const result = await this.db.execute(Q.CHUNK_EMBEDDING_STATS);
    return result.rows[0] as unknown as ChunkEmbeddingStats;
  }

  async resetEmbeddings(): Promise<void> {
    await this.db.execute("UPDATE messages SET embedding = NULL");
    await this.db.execute("UPDATE chunks SET embedding = NULL");
  }

  async searchChunks(
    query: string,
    options?: {
      source?: string;
      channel?: string;
      after?: number;
      before?: number;
      limit?: number;
    }
  ): Promise<MessageRow[]> {
    const limit = options?.limit ?? 20;
    const conditions: string[] = [];
    const params: (string | number)[] = [sanitizeFtsQuery(query)];

    if (options?.source) {
      conditions.push("m.source = ?");
      params.push(options.source);
    }
    if (options?.channel) {
      conditions.push("m.channel_name LIKE ?");
      params.push(`%${options.channel}%`);
    }
    if (options?.after) {
      conditions.push("m.sent_at > ?");
      params.push(options.after);
    }
    if (options?.before) {
      conditions.push("m.sent_at < ?");
      params.push(options.before);
    }

    let sql = Q.SEARCH_CHUNKS_FILTERED;
    if (conditions.length > 0) {
      sql += " AND " + conditions.join(" AND ");
    }
    sql += " ORDER BY rank LIMIT ?";
    params.push(limit);

    const result = await this.db.execute({ sql, args: params });
    return result.rows as unknown as MessageRow[];
  }

  async vectorSearchChunks(
    embedding: Float32Array,
    options?: {
      source?: string;
      channel?: string;
      after?: number;
      before?: number;
      limit?: number;
    }
  ): Promise<MessageRow[]> {
    const k = options?.limit ?? 20;
    const conditions: string[] = [];
    const params: (Uint8Array | string | number)[] = [f32ToBytes(embedding)];

    if (options?.source) {
      conditions.push("m.source = ?");
      params.push(options.source);
    }
    if (options?.channel) {
      conditions.push("m.channel_name LIKE ?");
      params.push(`%${options.channel}%`);
    }
    if (options?.after) {
      conditions.push("m.sent_at > ?");
      params.push(options.after);
    }
    if (options?.before) {
      conditions.push("m.sent_at < ?");
      params.push(options.before);
    }

    let sql = Q.VECTOR_SEARCH_CHUNKS;
    if (conditions.length > 0) {
      sql += " AND " + conditions.join(" AND ");
    }
    sql += " ORDER BY distance ASC LIMIT ?";
    params.push(k);

    const result = await this.db.execute({ sql, args: params as any });
    return result.rows as unknown as MessageRow[];
  }

  async getThread(threadId: string): Promise<MessageRow[]> {
    const result = await this.db.execute({
      sql: Q.GET_THREAD,
      args: [threadId],
    });
    return result.rows as unknown as MessageRow[];
  }

  async getThreadsByDate(dayStart: number, dayEnd: number): Promise<MessageRow[]> {
    const result = await this.db.execute({
      sql: Q.GET_THREADS_BY_DATE,
      args: [dayStart, dayEnd],
    });
    return result.rows as unknown as MessageRow[];
  }

  async getDetailedStats(): Promise<{
    db_size: number;
    total_messages: number;
    total_channels: number;
    total_contacts: number;
    embeddable_messages: number;
    embedded_messages: number;
    total_chunks: number;
    embedded_chunks: number;
  }> {
    const stats = await this.getStats();
    const embStats = await this.getEmbeddingStats();
    const chunkStats = await this.getChunkEmbeddingStats();

    const sizeResult = await this.db.execute(
      "SELECT (SELECT page_count FROM pragma_page_count) AS page_count, (SELECT page_size FROM pragma_page_size) AS page_size"
    );
    const sizeRow = sizeResult.rows[0] as any;
    const db_size = sizeRow.page_count * sizeRow.page_size;

    return {
      db_size,
      ...stats,
      embeddable_messages: embStats.total_messages,
      embedded_messages: embStats.embedded_messages,
      total_chunks: chunkStats.total_chunks,
      embedded_chunks: chunkStats.embedded_chunks,
    };
  }

  async getStatsBySource(): Promise<Array<{
    source: string;
    messages: number;
    channels: number;
    chunks: number;
  }>> {
    const result = await this.db.execute(
      `SELECT m.source,
              COUNT(DISTINCT m.id) AS messages,
              COUNT(DISTINCT m.channel_name) AS channels,
              (SELECT COUNT(*) FROM chunks c WHERE c.message_id IN (SELECT id FROM messages WHERE source = m.source)) AS chunks
       FROM messages m
       GROUP BY m.source
       ORDER BY messages DESC`
    );
    return result.rows as unknown as Array<{ source: string; messages: number; channels: number; chunks: number }>;
  }

  async getMessagesBySource(source: string): Promise<Array<{ id: number; source_id: string; metadata: string | null }>> {
    const result = await this.db.execute({
      sql: "SELECT id, source_id, metadata FROM messages WHERE source = ?",
      args: [source],
    });
    return result.rows as unknown as Array<{ id: number; source_id: string; metadata: string | null }>;
  }

  async deleteMessage(id: number): Promise<void> {
    await this.db.execute({ sql: "DELETE FROM chunks WHERE message_id = ?", args: [id] });
    await this.db.execute({ sql: "DELETE FROM messages WHERE id = ?", args: [id] });
  }

  async deleteSyncCursor(source: string, key: string): Promise<void> {
    await this.db.execute({
      sql: "DELETE FROM sync_cursors WHERE source = ? AND key = ?",
      args: [source, key],
    });
  }

  async resetSyncCursors(source?: string): Promise<void> {
    if (source) {
      await this.db.execute({ sql: "DELETE FROM sync_cursors WHERE source = ?", args: [source] });
    } else {
      await this.db.execute("DELETE FROM sync_cursors");
    }
  }

  async resetChunks(): Promise<void> {
    await this.db.execute("DELETE FROM chunks");
  }

  async getMeta(key: string): Promise<string | null> {
    const result = await this.db.execute({
      sql: "SELECT value FROM traul_meta WHERE key = ?",
      args: [key],
    });
    if (result.rows.length === 0) return null;
    return (result.rows[0] as any).value ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.db.execute({
      sql: "INSERT INTO traul_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      args: [key, value],
    });
  }

  async execute(sql: string): Promise<any> {
    return this.db.execute(sql);
  }

  close(): void {
    this.db.close();
  }
}

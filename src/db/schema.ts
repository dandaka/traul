import { createClient, type Client } from "@libsql/client";

export const EMBED_DIMS = 1024;

export const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    source_id TEXT NOT NULL,
    channel_id TEXT,
    channel_name TEXT,
    thread_id TEXT,
    author_id TEXT,
    author_name TEXT,
    content TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    metadata TEXT,
    embedding F32_BLOB(1024),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(source, source_id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_source ON messages(source);
  CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_name);
  CREATE INDEX IF NOT EXISTS idx_messages_sent_at ON messages(sent_at);
  CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(source, thread_id);

  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    author_name,
    channel_name,
    content='messages',
    content_rowid='id',
    tokenize='porter unicode61'
  );

  CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content, author_name, channel_name)
    VALUES (new.id, new.content, new.author_name, new.channel_name);
  END;

  CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content, author_name, channel_name)
    VALUES ('delete', old.id, old.content, old.author_name, old.channel_name);
  END;

  CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content, author_name, channel_name)
    VALUES ('delete', old.id, old.content, old.author_name, old.channel_name);
    INSERT INTO messages_fts(rowid, content, author_name, channel_name)
    VALUES (new.id, new.content, new.author_name, new.channel_name);
  END;

  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    display_name TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS contact_identities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER NOT NULL REFERENCES contacts(id),
    source TEXT NOT NULL,
    source_user_id TEXT NOT NULL,
    username TEXT,
    display_name TEXT,
    UNIQUE(source, source_user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_contact_identities_contact ON contact_identities(contact_id);

  CREATE TABLE IF NOT EXISTS sync_cursors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    key TEXT NOT NULL,
    cursor_value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(source, key)
  );

  CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    embedding_input TEXT NOT NULL,
    embedding F32_BLOB(1024),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(message_id, chunk_index)
  );

  CREATE INDEX IF NOT EXISTS idx_chunks_message ON chunks(message_id);

  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    content,
    content='chunks',
    content_rowid='id',
    tokenize='porter unicode61'
  );

  CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES ('delete', old.id, old.content);
  END;

  CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES ('delete', old.id, old.content);
    INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
  END;

  CREATE TABLE IF NOT EXISTS traul_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

export async function initializeDatabase(path: string): Promise<Client> {
  const url = path === ":memory:" ? ":memory:" : `file:${path}`;
  const db = createClient({ url });
  await db.executeMultiple("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  await db.executeMultiple(SCHEMA_SQL);

  // Add embedding columns to existing tables (no-op on fresh DBs)
  for (const [table, col] of [["messages", "embedding"], ["chunks", "embedding"]] as const) {
    const cols = (await db.execute(`PRAGMA table_info(${table})`)).rows;
    if (!cols.some((r: any) => r.name === col)) {
      await db.execute(`ALTER TABLE ${table} ADD COLUMN ${col} F32_BLOB(${EMBED_DIMS})`);
    }
  }

  // DiskANN vector indexes
  const indexes = (
    await db.execute(
      "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_msg_vec', 'idx_chunk_vec')"
    )
  ).rows.map((r: any) => r.name);

  if (!indexes.includes("idx_msg_vec")) {
    await db.execute(
      "CREATE INDEX idx_msg_vec ON messages(libsql_vector_idx(embedding, 'metric=cosine'))"
    );
  }
  if (!indexes.includes("idx_chunk_vec")) {
    await db.execute(
      "CREATE INDEX idx_chunk_vec ON chunks(libsql_vector_idx(embedding, 'metric=cosine'))"
    );
  }

  return db;
}

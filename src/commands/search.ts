import type { TraulDB } from "../db/database";
import { formatMessage, writeJSON } from "../lib/formatter";
import { embed, vecToBytes } from "../lib/embeddings";

export async function runSearch(
  db: TraulDB,
  query: string,
  options: {
    source?: string;
    channel?: string;
    after?: string;
    before?: string;
    limit?: string;
    json?: boolean;
    fts?: boolean;
    or?: boolean;
    like?: boolean;
  }
): Promise<void> {
  const limit = options.limit ? parseInt(options.limit, 10) : 20;
  const after = options.after
    ? Math.floor(new Date(options.after).getTime() / 1000)
    : undefined;
  const before = options.before
    ? Math.floor(new Date(options.before).getTime() / 1000)
    : undefined;

  const searchOpts = {
    source: options.source,
    channel: options.channel,
    after,
    before,
    limit,
  };

  // Build FTS query: join terms with OR when --or flag is set
  const ftsQuery = options.or
    ? query.split(/\s+/).filter(Boolean).join(" OR ")
    : query;

  let results;
  if (options.like) {
    results = db.likeSearchAll(query, searchOpts);
  } else if (options.fts) {
    results = db.ftsSearchAll(ftsQuery, searchOpts);
  } else {
    try {
      const vec = await embed(query);
      results = db.hybridSearchAll(vecToBytes(vec), ftsQuery, searchOpts);
      const { total_messages, embedded_messages } = db.getEmbeddingStats();
      const pct = total_messages > 0 ? Math.round((embedded_messages / total_messages) * 100) : 0;
      if (pct < 100) {
        console.warn(`search: hybrid mode — ${pct}% vector, ${100 - pct}% FTS`);
      }
    } catch {
      console.warn("search: Ollama unavailable, falling back to FTS-only");
      results = db.ftsSearchAll(ftsQuery, searchOpts);
    }
  }

  if (results.length === 0) {
    if (options.json) {
      console.log("[]");
    } else {
      console.log("No results found.");
    }
    return;
  }

  if (options.json) {
    const jsonData = results.map((msg) => ({
      sent_at: new Date(msg.sent_at * 1000).toISOString(),
      author: msg.author_name,
      content: msg.content,
      channel: msg.channel_name,
      source: msg.source,
      ...(msg.rank != null ? { rank: msg.rank } : {}),
    }));
    await writeJSON(jsonData);
  } else {
    for (const msg of results) {
      console.log(formatMessage(msg));
    }
  }
}

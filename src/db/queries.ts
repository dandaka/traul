export const UPSERT_MESSAGE = `
  INSERT INTO messages (source, source_id, channel_id, channel_name, thread_id, author_id, author_name, content, sent_at, metadata)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source, source_id) DO UPDATE SET
    content = excluded.content,
    metadata = excluded.metadata,
    updated_at = unixepoch()
`;

export const UPSERT_CONTACT = `
  INSERT INTO contacts (display_name)
  VALUES (?)
  ON CONFLICT(display_name) DO UPDATE SET
    updated_at = unixepoch()
  RETURNING id
`;

export const UPSERT_CONTACT_IDENTITY = `
  INSERT INTO contact_identities (contact_id, source, source_user_id, username, display_name)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(source, source_user_id) DO UPDATE SET
    username = excluded.username,
    display_name = excluded.display_name
`;

export const GET_CONTACT_BY_SOURCE_ID = `
  SELECT c.id, c.display_name
  FROM contacts c
  JOIN contact_identities ci ON ci.contact_id = c.id
  WHERE ci.source = ? AND ci.source_user_id = ?
`;

export const GET_SYNC_CURSOR = `
  SELECT cursor_value FROM sync_cursors WHERE source = ? AND key = ?
`;

export const SET_SYNC_CURSOR = `
  INSERT INTO sync_cursors (source, key, cursor_value)
  VALUES (?, ?, ?)
  ON CONFLICT(source, key) DO UPDATE SET
    cursor_value = excluded.cursor_value,
    updated_at = unixepoch()
`;

export const SEARCH_MESSAGES = `
  SELECT m.id, m.source, m.source_id, m.channel_name, m.thread_id,
         m.author_name, m.content, m.sent_at, m.metadata,
         bm25(messages_fts) AS rank
  FROM messages_fts
  JOIN messages m ON messages_fts.rowid = m.id
  WHERE messages_fts MATCH ?
  ORDER BY rank
`;

export const SEARCH_MESSAGES_FILTERED = `
  SELECT m.id, m.source, m.source_id, m.channel_name, m.thread_id,
         m.author_name, m.content, m.sent_at, m.metadata,
         bm25(messages_fts) AS rank
  FROM messages_fts
  JOIN messages m ON messages_fts.rowid = m.id
  WHERE messages_fts MATCH ?
`;

export const GET_STATS = `
  SELECT
    (SELECT COUNT(*) FROM messages) AS total_messages,
    (SELECT COUNT(DISTINCT channel_name) FROM messages) AS total_channels,
    (SELECT COUNT(*) FROM contacts) AS total_contacts
`;

export const GET_MESSAGES = `
  SELECT m.id, m.source, m.source_id, m.channel_name, m.thread_id,
         m.author_name, m.content, m.sent_at, m.metadata
  FROM messages m
  WHERE 1=1
`;

export const HAS_MESSAGE = `
  SELECT 1 FROM messages WHERE source = ? AND source_id = ? LIMIT 1
`;

export const INSERT_EMBEDDING = `
  UPDATE messages SET embedding = vector32(?) WHERE id = ?
`;

export const GET_UNEMBEDDED_MESSAGES = `
  SELECT m.id, m.content
  FROM messages m
  WHERE m.content != ''
    AND m.embedding IS NULL
    AND m.id NOT IN (SELECT DISTINCT message_id FROM chunks)
  ORDER BY m.id DESC
  LIMIT ?
`;

export const VECTOR_SEARCH = `
  SELECT m.id, m.source, m.source_id, m.channel_name, m.thread_id,
         m.author_name, m.content, m.sent_at, m.metadata
  FROM vector_top_k('idx_msg_vec', vector32(?), ?) AS v
  JOIN messages m ON m.rowid = v.id
`;

export const EMBEDDING_STATS = `
  SELECT
    (SELECT COUNT(*) FROM messages WHERE id NOT IN (SELECT DISTINCT message_id FROM chunks)) AS total_messages,
    (SELECT COUNT(*) FROM messages WHERE embedding IS NOT NULL) AS embedded_messages
`;

export const DELETE_ORPHANED_EMBEDDINGS = `
  UPDATE messages SET embedding = NULL
  WHERE embedding IS NOT NULL
    AND id IN (SELECT DISTINCT message_id FROM chunks)
`;

// Chunk queries
export const REPLACE_CHUNKS_DELETE = `
  DELETE FROM chunks WHERE message_id = ?
`;

export const INSERT_CHUNK = `
  INSERT INTO chunks (message_id, chunk_index, content, embedding_input)
  VALUES (?, ?, ?, ?)
`;

export const GET_UNEMBEDDED_CHUNKS = `
  SELECT c.id, c.embedding_input AS content
  FROM chunks c
  WHERE c.content != ''
    AND c.embedding IS NULL
  ORDER BY c.id DESC
  LIMIT ?
`;

export const INSERT_CHUNK_EMBEDDING = `
  UPDATE chunks SET embedding = vector32(?) WHERE id = ?
`;

export const DELETE_ORPHANED_CHUNK_EMBEDDINGS = `
  UPDATE chunks SET embedding = NULL
  WHERE embedding IS NOT NULL
    AND message_id NOT IN (SELECT id FROM messages)
`;

export const DELETE_ORPHANED_CHUNKS = `
  DELETE FROM chunks
  WHERE message_id NOT IN (SELECT id FROM messages)
`;

export const SEARCH_CHUNKS_FILTERED = `
  SELECT m.id, m.source, m.source_id, m.channel_name, m.thread_id,
         m.author_name, c.content, m.sent_at, m.metadata,
         bm25(chunks_fts) AS rank
  FROM chunks_fts
  JOIN chunks c ON chunks_fts.rowid = c.id
  JOIN messages m ON m.id = c.message_id
  WHERE chunks_fts MATCH ?
`;

export const VECTOR_SEARCH_CHUNKS = `
  SELECT m.id, m.source, m.source_id, m.channel_name, m.thread_id,
         m.author_name, c.content, m.sent_at, m.metadata
  FROM vector_top_k('idx_chunk_vec', vector32(?), ?) AS v
  JOIN chunks c ON c.rowid = v.id
  JOIN messages m ON m.id = c.message_id
`;

export const CHUNK_EMBEDDING_STATS = `
  SELECT
    (SELECT COUNT(*) FROM chunks) AS total_chunks,
    (SELECT COUNT(*) FROM chunks WHERE embedding IS NOT NULL) AS embedded_chunks
`;

export const GET_MESSAGE_CHUNK_IDS = `
  SELECT id FROM chunks WHERE message_id = ?
`;

// FTS backfill: search only messages that have NOT been embedded yet
export const FTS_BACKFILL_MESSAGES = `
  SELECT m.id, m.source, m.source_id, m.channel_name, m.thread_id,
         m.author_name, m.content, m.sent_at, m.metadata,
         bm25(messages_fts) AS rank
  FROM messages_fts
  JOIN messages m ON messages_fts.rowid = m.id
  WHERE messages_fts MATCH ?
    AND m.embedding IS NULL
    AND m.id NOT IN (SELECT DISTINCT message_id FROM chunks)
`;

// FTS backfill: search only chunks that have NOT been embedded yet
export const FTS_BACKFILL_CHUNKS = `
  SELECT m.id, m.source, m.source_id, m.channel_name, m.thread_id,
         m.author_name, c.content, m.sent_at, m.metadata,
         bm25(chunks_fts) AS rank
  FROM chunks_fts
  JOIN chunks c ON chunks_fts.rowid = c.id
  JOIN messages m ON m.id = c.message_id
  WHERE chunks_fts MATCH ?
    AND c.embedding IS NULL
`;

export const LIKE_SEARCH_MESSAGES = `
  SELECT m.id, m.source, m.source_id, m.channel_name, m.thread_id,
         m.author_name, m.content, m.sent_at, m.metadata
  FROM messages m
  WHERE m.content LIKE '%' || ? || '%'
`;

export const LIKE_SEARCH_CHUNKS = `
  SELECT m.id, m.source, m.source_id, m.channel_name, m.thread_id,
         m.author_name, c.content, m.sent_at, m.metadata
  FROM chunks c
  JOIN messages m ON m.id = c.message_id
  WHERE c.content LIKE '%' || ? || '%'
`;

export const GET_UNCHUNKED_LONG_MESSAGES = `
  SELECT m.id, m.content
  FROM messages m
  WHERE length(m.content) > ?
    AND m.embedding IS NOT NULL
    AND m.id NOT IN (SELECT DISTINCT message_id FROM chunks)
  ORDER BY m.id DESC
  LIMIT ?
`;

export const GET_THREAD = `
  SELECT m.source, m.channel_name, m.thread_id,
         m.author_name, m.content, m.sent_at, m.metadata
  FROM messages m
  WHERE m.thread_id = ?
  ORDER BY m.sent_at ASC
`;

export const GET_THREADS_BY_DATE = `
  SELECT m.source, m.channel_name, m.thread_id,
         m.author_name, m.content, m.sent_at, m.metadata,
         COUNT(*) OVER (PARTITION BY m.thread_id) AS thread_size
  FROM messages m
  WHERE m.thread_id IS NOT NULL
    AND m.sent_at >= ? AND m.sent_at < ?
  ORDER BY m.sent_at ASC
`;

export const GET_CHANNELS = `
  SELECT source, channel_name,
         COUNT(*) AS msg_count,
         MAX(sent_at) AS last_message
  FROM messages
  WHERE 1=1
  GROUP BY source, channel_name
  ORDER BY last_message DESC
`;

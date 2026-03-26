# LibSQL Vector Migration

Replace `bun:sqlite` + `sqlite-vec` with `@libsql/client` (embedded/local mode) to get DiskANN-indexed vector search with filtered queries.

## Problem

Current `sqlite-vec` v0.1.7 uses brute-force linear scan for k-NN search. With 142K messages and 1024-dim vectors, `vectorSearch` takes ~4s and `vectorSearchChunks` takes ~21s. Combined hybrid search: ~25s. FTS is 18ms.

Additionally, `vec0` virtual tables can't filter on metadata columns (source, channel, date) — the current code JOINs with vec0 which QMD has documented as causing hangs/severe slowdowns.

## Decisions

- **Local-only** — `@libsql/client` in file mode, no Turso cloud
- **Re-embed from scratch** — drop old vectors, re-run embed pipeline with current model
- **Keep 1024 dims** — Qwen3-Embedding-0.6B stays, ANN index makes dimension count irrelevant for speed
- **Remove Ollama fallback** — node-llama-cpp is the only embedding backend

## Design

### 1. Database Layer

Replace `bun:sqlite` + `sqlite-vec` with `@libsql/client` in local file mode.

**schema.ts changes:**
- Remove Homebrew SQLite hack (`Database.setCustomSQLite(...)`)
- Remove `sqlite-vec` extension loading
- Store vectors directly on `messages` and `chunks` tables as `F32_BLOB(1024)` columns (nullable — NULL means not yet embedded)
- No separate `vec_messages` / `vec_chunks` virtual tables
- Create DiskANN indexes:
  ```sql
  CREATE INDEX idx_msg_vec ON messages(libsql_vector_idx(embedding, 'metric=cosine'));
  CREATE INDEX idx_chunk_vec ON chunks(libsql_vector_idx(embedding, 'metric=cosine'));
  ```
- Partial indexes per source are possible but deferred — sources are dynamic (slack, discord, telegram, gmail, etc.) so creating them statically is fragile. Start with the global index and over-fetch with post-filter. Add partial indexes later if post-filtering proves insufficient.
- FTS5 tables remain unchanged — libSQL supports them

**TraulDB becomes fully async.** Every method returns a Promise. All callers (commands, connectors, tests) updated accordingly.

### 2. Vector Search

Replace `vec0 MATCH` queries with `vector_top_k()`.

```sql
SELECT m.id, m.source, m.source_id, m.channel_name, m.thread_id,
       m.author_name, m.content, m.sent_at, m.metadata
FROM vector_top_k('idx_msg_vec', vector32(?), ?) AS v
JOIN messages m ON m.rowid = v.id
WHERE m.source = ? AND m.channel_name LIKE ?
```

- Filtered search works in a single query
- For source-specific searches, post-filter after over-fetching (partial indexes deferred — see section 1)
- Same pattern for chunks: `vector_top_k('idx_chunk_vec', ...)` joined to `chunks` + `messages`
- `hybridSearchAll()` still does RRF merge of vector + FTS backfill, but vector part is now milliseconds

**Remove Ollama fallback entirely from `embeddings.ts`:**
- Remove `tryEmbedBatch`, `ollamaEmbed`, `ollamaEmbedBatch`
- Remove `OLLAMA_URL`, `OLLAMA_MODEL`, `useLlama` flag
- `embeddings.ts` becomes a thin wrapper around `llama.ts` only

### 3. Migration & Data

Destructive re-embed with automatic trigger.

On first run with new code:
1. Detect old schema (check for `vec_messages` virtual table existence)
2. Drop `vec_messages`, `vec_chunks` virtual tables
3. Add `embedding F32_BLOB(1024)` column to `messages` and `chunks` tables
4. Create DiskANN indexes
5. Reset the embed sync cursor (so embed pipeline sees all messages as unembedded)
6. Set `schema_version = 2`
7. Auto-trigger embed — run the embed pipeline immediately after migration completes

Search works in FTS-only mode during the embed run, switches to hybrid as embeddings populate.

### 4. Dependencies & Cleanup

**Add:**
- `@libsql/client` — embedded libSQL with native vector support

**Remove:**
- `sqlite-vec` — replaced by libSQL built-in vectors
- Homebrew SQLite hack in `schema.ts`
- All Ollama code from `embeddings.ts`

**Update:**
- CLI description: remove "requires Ollama" from search command help text
- `skill.md` — document the libSQL change

### 5. Testing

All existing DB tests rewritten to use `@libsql/client` in-memory mode (`url: ":memory:"`).

- Vector search tests: verify `vector_top_k()` returns results, filtered search works with source/channel/date params
- Migration test: create old-schema DB with `vec_messages`, run migration, verify columns added and old tables dropped
- Embed pipeline test: verify embeddings written as `F32_BLOB` to message/chunk rows
- FTS tests: unchanged (libSQL supports same FTS5 syntax)
- Hybrid search test: verify RRF merge works with new vector backend
- No Ollama tests — removed with the fallback code

## Performance Target

| Operation | Before | After |
|-----------|--------|-------|
| vectorSearch (messages) | ~4,000ms | <50ms |
| vectorSearchChunks | ~21,000ms | <50ms |
| Hybrid search total | ~25,000ms | <100ms |
| FTS search | 18ms | 18ms |

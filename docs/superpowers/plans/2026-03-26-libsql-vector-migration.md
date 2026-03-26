# LibSQL Vector Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `bun:sqlite` + `sqlite-vec` with `@libsql/client` (local embedded) to get DiskANN-indexed vector search (~25s → <100ms).

**Architecture:** Swap the sync `bun:sqlite` Database API for async `@libsql/client`. Store embeddings as `F32_BLOB(1024)` columns directly on `messages` and `chunks` tables. Create DiskANN indexes for ANN search via `vector_top_k()`. Remove Ollama fallback.

**Tech Stack:** `@libsql/client` (local file mode), `node-llama-cpp` (embeddings), libSQL built-in vector search (DiskANN), FTS5.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/db/schema.ts` | Rewrite | libSQL init, schema with F32_BLOB columns, DiskANN indexes |
| `src/db/database.ts` | Rewrite | Async TraulDB using `@libsql/client` API |
| `src/db/queries.ts` | Modify | Replace vec0 queries with `vector_top_k()`, update embedding queries |
| `src/db/migrations.ts` | Modify | Add schema v2 migration (drop vec tables, add embedding columns) |
| `src/lib/embeddings.ts` | Simplify | Remove Ollama fallback, thin wrapper around llama.ts |
| `src/commands/search.ts` | Modify | Await async DB methods |
| `src/commands/embed.ts` | Modify | Await async DB methods, use new insert pattern |
| `src/commands/stats.ts` | Modify | Await async DB methods |
| `src/commands/messages.ts` | Modify | Await async DB methods |
| `src/commands/channels.ts` | Modify | Await async DB methods |
| `src/commands/sync.ts` | Modify | Await async DB methods |
| `src/commands/sql.ts` | Modify | Await async DB methods |
| `src/commands/get.ts` | Modify | Await async DB methods |
| `src/commands/reset.ts` | Modify | Await async DB methods |
| `src/commands/daemon.ts` | Modify | Await async DB methods |
| `src/index.ts` | Modify | Async DB init, update search description |
| `src/connectors/*.ts` | Modify | Await async DB methods (all connectors) |
| `package.json` | Modify | Add `@libsql/client`, remove `sqlite-vec` |
| `test/db/schema.test.ts` | Rewrite | Test libSQL schema init |
| `test/db/database.test.ts` | Rewrite | Test async TraulDB methods |
| `test/db/migrations.test.ts` | Rewrite | Test schema v2 migration |
| `test/commands/search.test.ts` | Modify | Await async methods |

---

### Task 1: Install `@libsql/client` and remove `sqlite-vec`

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install @libsql/client**

```bash
bun add @libsql/client
```

- [ ] **Step 2: Remove sqlite-vec**

```bash
bun remove sqlite-vec
```

- [ ] **Step 3: Verify package.json**

`package.json` should have `@libsql/client` in dependencies and no `sqlite-vec`.

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lockb
git commit -m "chore: swap sqlite-vec for @libsql/client"
```

---

### Task 2: Rewrite `schema.ts` for libSQL

**Files:**
- Rewrite: `src/db/schema.ts`
- Test: `test/db/schema.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/db/schema.test.ts
import { describe, it, expect } from "bun:test";
import { initializeDatabase } from "../../src/db/schema";

describe("schema", () => {
  it("creates all tables including embedding columns", async () => {
    const db = await initializeDatabase(":memory:");

    // Check messages table has embedding column
    const msgCols = (await db.execute(
      "PRAGMA table_info(messages)"
    )).rows;
    const embCol = msgCols.find((r: any) => r.name === "embedding");
    expect(embCol).toBeTruthy();

    // Check chunks table has embedding column
    const chunkCols = (await db.execute(
      "PRAGMA table_info(chunks)"
    )).rows;
    const chunkEmbCol = chunkCols.find((r: any) => r.name === "embedding");
    expect(chunkEmbCol).toBeTruthy();

    // Check FTS tables exist
    const tables = (await db.execute(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    )).rows.map((r: any) => r.name);
    expect(tables).toContain("messages_fts");
    expect(tables).toContain("chunks_fts");
    expect(tables).toContain("traul_meta");

    db.close();
  });

  it("creates DiskANN vector indexes", async () => {
    const db = await initializeDatabase(":memory:");

    const indexes = (await db.execute(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%vec%'"
    )).rows.map((r: any) => r.name);
    expect(indexes).toContain("idx_msg_vec");
    expect(indexes).toContain("idx_chunk_vec");

    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/db/schema.test.ts`
Expected: FAIL — `initializeDatabase` still uses old API.

- [ ] **Step 3: Rewrite schema.ts**

```typescript
// src/db/schema.ts
import { createClient, type Client } from "@libsql/client";

const EMBED_DIMS = 1024;

const SCHEMA_SQL = `
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
    embedding F32_BLOB(${EMBED_DIMS}),
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
    embedding F32_BLOB(${EMBED_DIMS}),
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

export { EMBED_DIMS, SCHEMA_SQL };

export async function initializeDatabase(path: string): Promise<Client> {
  const url = path === ":memory:" ? ":memory:" : `file:${path}`;
  const db = createClient({ url });
  await db.executeMultiple("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  await db.executeMultiple(SCHEMA_SQL);

  // DiskANN vector indexes — CREATE INDEX IF NOT EXISTS not supported for vector indexes,
  // so check first and create if missing
  const indexes = (await db.execute(
    "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_msg_vec', 'idx_chunk_vec')"
  )).rows.map((r: any) => r.name);

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/db/schema.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts test/db/schema.test.ts
git commit -m "feat: rewrite schema.ts for libSQL with F32_BLOB and DiskANN indexes"
```

---

### Task 3: Rewrite `queries.ts` for libSQL vector search

**Files:**
- Modify: `src/db/queries.ts`

- [ ] **Step 1: Update vector search queries**

Replace `VECTOR_SEARCH` (lines 97-104):
```typescript
export const VECTOR_SEARCH = `
  SELECT m.id, m.source, m.source_id, m.channel_name, m.thread_id,
         m.author_name, m.content, m.sent_at, m.metadata
  FROM vector_top_k('idx_msg_vec', vector32(?), ?) AS v
  JOIN messages m ON m.rowid = v.id
`;
```

Replace `VECTOR_SEARCH_CHUNKS` (lines 162-170):
```typescript
export const VECTOR_SEARCH_CHUNKS = `
  SELECT m.id, m.source, m.source_id, m.channel_name, m.thread_id,
         m.author_name, c.content, m.sent_at, m.metadata
  FROM vector_top_k('idx_chunk_vec', vector32(?), ?) AS v
  JOIN chunks c ON c.rowid = v.id
  JOIN messages m ON m.id = c.message_id
`;
```

- [ ] **Step 2: Update embedding insert queries**

Replace `INSERT_EMBEDDING` (lines 82-84):
```typescript
export const INSERT_EMBEDDING = `
  UPDATE messages SET embedding = vector32(?) WHERE id = ?
`;
```

Replace `INSERT_CHUNK_EMBEDDING` (lines 137-139):
```typescript
export const INSERT_CHUNK_EMBEDDING = `
  UPDATE chunks SET embedding = vector32(?) WHERE id = ?
`;
```

Note: parameter order changes — embedding first, id second (matching UPDATE SET syntax).

- [ ] **Step 3: Update unembedded queries**

Replace `GET_UNEMBEDDED_MESSAGES` (lines 87-95):
```typescript
export const GET_UNEMBEDDED_MESSAGES = `
  SELECT m.id, m.content
  FROM messages m
  WHERE m.content != ''
    AND m.embedding IS NULL
    AND m.id NOT IN (SELECT DISTINCT message_id FROM chunks)
  ORDER BY m.id DESC
  LIMIT ?
`;
```

Replace `GET_UNEMBEDDED_CHUNKS` (lines 128-135):
```typescript
export const GET_UNEMBEDDED_CHUNKS = `
  SELECT c.id, c.embedding_input AS content
  FROM chunks c
  WHERE c.content != ''
    AND c.embedding IS NULL
  ORDER BY c.id DESC
  LIMIT ?
`;
```

- [ ] **Step 4: Update stats queries**

Replace `EMBEDDING_STATS` (lines 106-110):
```typescript
export const EMBEDDING_STATS = `
  SELECT
    (SELECT COUNT(*) FROM messages WHERE id NOT IN (SELECT DISTINCT message_id FROM chunks)) AS total_messages,
    (SELECT COUNT(*) FROM messages WHERE embedding IS NOT NULL) AS embedded_messages
`;
```

Replace `CHUNK_EMBEDDING_STATS` (lines 172-176):
```typescript
export const CHUNK_EMBEDDING_STATS = `
  SELECT
    (SELECT COUNT(*) FROM chunks) AS total_chunks,
    (SELECT COUNT(*) FROM chunks WHERE embedding IS NOT NULL) AS embedded_chunks
`;
```

- [ ] **Step 5: Update orphan cleanup queries**

Replace `DELETE_ORPHANED_EMBEDDINGS` (lines 112-116):
```typescript
export const DELETE_ORPHANED_EMBEDDINGS = `
  UPDATE messages SET embedding = NULL
  WHERE embedding IS NOT NULL
    AND id IN (SELECT DISTINCT message_id FROM chunks)
`;
```

Replace `DELETE_ORPHANED_CHUNK_EMBEDDINGS` (lines 142-145):
```typescript
export const DELETE_ORPHANED_CHUNK_EMBEDDINGS = `
  UPDATE chunks SET embedding = NULL
  WHERE embedding IS NOT NULL
    AND message_id NOT IN (SELECT id FROM messages)
`;
```

- [ ] **Step 6: Update FTS backfill queries**

Replace `FTS_BACKFILL_MESSAGES` (lines 183-192):
```typescript
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
```

Replace `FTS_BACKFILL_CHUNKS` (lines 195-204):
```typescript
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
```

- [ ] **Step 7: Update unchunked long messages query**

Replace `GET_UNCHUNKED_LONG_MESSAGES` (lines 221-229):
```typescript
export const GET_UNCHUNKED_LONG_MESSAGES = `
  SELECT m.id, m.content
  FROM messages m
  WHERE length(m.content) > ?
    AND m.embedding IS NOT NULL
    AND m.id NOT IN (SELECT DISTINCT message_id FROM chunks)
  ORDER BY m.id DESC
  LIMIT ?
`;
```

- [ ] **Step 8: Commit**

```bash
git add src/db/queries.ts
git commit -m "feat: update queries for libSQL vector_top_k and F32_BLOB columns"
```

---

### Task 4: Rewrite `database.ts` to async with `@libsql/client`

**Files:**
- Rewrite: `src/db/database.ts`
- Test: `test/db/database.test.ts`

This is the largest task. Every method becomes async. The `bun:sqlite` `Database` API (`db.query<T,P>().get()`, `.all()`, `db.run()`) is replaced with `@libsql/client` `Client` API (`db.execute({ sql, args })`).

- [ ] **Step 1: Write failing test for core async operations**

```typescript
// test/db/database.test.ts
import { describe, it, expect, beforeEach } from "bun:test";
import { TraulDB } from "../../src/db/database";

describe("TraulDB async", () => {
  let db: TraulDB;

  beforeEach(async () => {
    db = await TraulDB.create(":memory:");
  });

  it("upserts and retrieves a message", async () => {
    await db.upsertMessage({
      source: "test",
      source_id: "1",
      content: "hello world",
      sent_at: 1000,
    });
    const has = await db.hasMessage("test", "1");
    expect(has).toBe(true);
  });

  it("FTS search returns results", async () => {
    await db.upsertMessage({
      source: "test",
      source_id: "1",
      channel_name: "general",
      content: "hello world from test",
      sent_at: 1000,
    });
    const results = await db.ftsSearchAll("hello", { limit: 10 });
    expect(results.length).toBe(1);
    expect(results[0].content).toBe("hello world from test");
  });

  it("vector search with vector_top_k", async () => {
    await db.upsertMessage({
      source: "test",
      source_id: "1",
      content: "hello world",
      sent_at: 1000,
    });

    // Create a dummy 1024-dim vector
    const vec = new Float32Array(1024);
    vec[0] = 1.0;

    // Insert embedding
    const msgs = await db.getMessages({ limit: 1 });
    await db.insertEmbedding(msgs[0].id, vec);

    // Search
    const results = await db.vectorSearch(vec, { limit: 5 });
    expect(results.length).toBe(1);
    expect(results[0].content).toBe("hello world");
  });

  it("embedding stats reflect inserted embeddings", async () => {
    await db.upsertMessage({
      source: "test",
      source_id: "1",
      content: "embedded message",
      sent_at: 1000,
    });
    const before = await db.getEmbeddingStats();
    expect(before.embedded_messages).toBe(0);

    const msgs = await db.getMessages({ limit: 1 });
    const vec = new Float32Array(1024);
    vec[0] = 1.0;
    await db.insertEmbedding(msgs[0].id, vec);

    const after = await db.getEmbeddingStats();
    expect(after.embedded_messages).toBe(1);
  });

  it("filtered vector search", async () => {
    await db.upsertMessage({ source: "slack", source_id: "1", channel_name: "general", content: "slack message", sent_at: 1000 });
    await db.upsertMessage({ source: "discord", source_id: "2", channel_name: "random", content: "discord message", sent_at: 1001 });

    const vec = new Float32Array(1024);
    vec[0] = 1.0;

    const msgs = await db.getMessages({ limit: 10 });
    for (const m of msgs) {
      await db.insertEmbedding(m.id, vec);
    }

    const results = await db.vectorSearch(vec, { source: "slack", limit: 5 });
    expect(results.length).toBe(1);
    expect(results[0].source).toBe("slack");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/db/database.test.ts`
Expected: FAIL — TraulDB.create doesn't exist yet.

- [ ] **Step 3: Rewrite database.ts**

Key changes from current implementation:

1. `constructor(path)` → `static async create(path)` factory (async init)
2. Internal `this.db` changes from `Database` (bun:sqlite) to `Client` (@libsql/client)
3. Every `this.db.query<T,P>(sql).get(...args)` → `await this.db.execute({ sql, args })` then extract `.rows[0]`
4. Every `this.db.query<T,P>(sql).all(...args)` → `await this.db.execute({ sql, args })` then extract `.rows`
5. Every `this.db.run(sql, args)` → `await this.db.execute({ sql, args })`
6. `insertEmbedding(id, embedding: Uint8Array)` → `insertEmbedding(id, embedding: Float32Array)` — pass the Float32Array directly, the query uses `vector32(?)`
7. `vectorSearch` / `vectorSearchChunks` — use `vector_top_k()` queries, pass Float32Array, post-filter with WHERE clauses
8. `deleteMessage` — remove `vec_messages`/`vec_chunks` deletes, just set `embedding = NULL` or rely on CASCADE
9. `resetEmbeddings` — `UPDATE messages SET embedding = NULL; UPDATE chunks SET embedding = NULL;` instead of dropping/recreating vec tables
10. `resetChunks` — remove `DELETE FROM vec_chunks`, just `DELETE FROM chunks`
11. `replaceChunks` — remove `DELETE FROM vec_chunks WHERE chunk_id = ?`, just delete chunks (CASCADE or embedding column goes with it)

The `sanitizeFtsQuery` helper and `rrfMerge` private method stay unchanged (pure functions).

All dynamic SQL building (conditions, params) stays the same pattern, but uses `@libsql/client`'s `args` array.

**Important `@libsql/client` API differences:**
- `execute({ sql, args })` returns `{ rows, columns, rowsAffected }`
- Rows are plain objects (not typed generics) — cast with `as MessageRow`
- Use `args: [...]` instead of spreading params
- `executeMultiple(sql)` for multi-statement strings (schema init)
- No `.changes` property on run — use `result.rowsAffected`

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/db/database.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/database.ts test/db/database.test.ts
git commit -m "feat: rewrite TraulDB to async @libsql/client API"
```

---

### Task 5: Update `migrations.ts` for schema v2

**Files:**
- Modify: `src/db/migrations.ts`
- Test: `test/db/migrations.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/db/migrations.test.ts
import { describe, it, expect } from "bun:test";
import { TraulDB } from "../../src/db/database";
import { runMigrations } from "../../src/db/migrations";

describe("migrations", () => {
  it("schema v2: detects old vec tables and migrates", async () => {
    const db = await TraulDB.create(":memory:");

    // Simulate old schema by creating vec_messages table
    await db.execute("CREATE TABLE vec_messages (message_id INTEGER, embedding BLOB)");

    const result = await runMigrations(db);

    // vec_messages should be dropped
    const tables = await db.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = 'vec_messages'"
    );
    expect(tables.rows.length).toBe(0);
    expect(result.embeddingsReset).toBe(true);
  });

  it("stores and checks meta values", async () => {
    const db = await TraulDB.create(":memory:");
    await runMigrations(db);

    const model = await db.getMeta("embed_model");
    expect(model).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/db/migrations.test.ts`
Expected: FAIL

- [ ] **Step 3: Update migrations.ts**

Make `runMigrations` async. Add schema v2 detection:

```typescript
export async function runMigrations(db: TraulDB): Promise<MigrationResult> {
  const result: MigrationResult = {
    chunksReset: false,
    embeddingsReset: false,
    syncCursorsReset: false,
  };

  // Schema v2 migration: detect old sqlite-vec tables
  const oldVecTable = await db.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name = 'vec_messages'"
  );
  if (oldVecTable.rows.length > 0) {
    log.info("Migrating from sqlite-vec to libSQL native vectors...");
    await db.execute("DROP TABLE IF EXISTS vec_messages");
    await db.execute("DROP TABLE IF EXISTS vec_chunks");
    // Embeddings column already exists on new schema — just need to re-embed
    await db.resetEmbeddings();
    result.embeddingsReset = true;
    await db.setMeta("schema_version", "2");
    log.info("Migration complete. Auto-embedding will start...");
  }

  // Existing migration logic (chunker version, embed model/dims)...
  // (same as current but all calls awaited)

  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/db/migrations.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations.ts test/db/migrations.test.ts
git commit -m "feat: add schema v2 migration from sqlite-vec to libSQL vectors"
```

---

### Task 6: Simplify `embeddings.ts` — remove Ollama fallback

**Files:**
- Modify: `src/lib/embeddings.ts`

- [ ] **Step 1: Rewrite embeddings.ts**

Remove all Ollama code. The file becomes:

```typescript
import * as llama from "./llama";

const EMBED_DIMS = 1024;
const BATCH_SIZE = 50;
const MAX_TEXT_LENGTH = 4000;

export { EMBED_DIMS, BATCH_SIZE, MAX_TEXT_LENGTH };
export const EMBED_MODEL = llama.LLAMA_EMBED_MODEL;

function truncate(text: string): string {
  return text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text;
}

export async function embed(text: string): Promise<Float32Array> {
  return llama.embedDoc(truncate(text));
}

export async function embedQuery(text: string): Promise<Float32Array> {
  return llama.embedQuery(truncate(text));
}

export async function embedBatch(
  texts: string[],
  onSkip?: (index: number, error: string) => void
): Promise<(Float32Array | null)[]> {
  return llama.embedDocBatch(texts.map(truncate), onSkip);
}
```

Note: `vecToBytes` is no longer needed — we pass `Float32Array` directly to libSQL's `vector32()`.

- [ ] **Step 2: Update imports across codebase**

Remove `vecToBytes` imports from:
- `src/commands/search.ts`
- `src/commands/embed.ts`
- Any other file importing it

Update `embed.ts` command to pass `Float32Array` directly to `db.insertEmbedding()`.

- [ ] **Step 3: Run existing embedding tests**

Run: `bun test test/lib/`
Expected: PASS (llama tests still work, Ollama tests removed)

- [ ] **Step 4: Commit**

```bash
git add src/lib/embeddings.ts src/commands/search.ts src/commands/embed.ts
git commit -m "refactor: remove Ollama fallback, simplify embeddings to llama-only"
```

---

### Task 7: Update all commands for async DB

**Files:**
- Modify: `src/commands/search.ts`
- Modify: `src/commands/embed.ts`
- Modify: `src/commands/messages.ts`
- Modify: `src/commands/channels.ts`
- Modify: `src/commands/stats.ts`
- Modify: `src/commands/sync.ts`
- Modify: `src/commands/sql.ts`
- Modify: `src/commands/get.ts`
- Modify: `src/commands/reset.ts`
- Modify: `src/commands/daemon.ts`

This is mechanical — every `db.someMethod()` becomes `await db.someMethod()`.

- [ ] **Step 1: Update search.ts**

Key change in `runSearch`:
```typescript
const vec = await embedQuery(query);
// Pass Float32Array directly — no vecToBytes needed
const results = await db.hybridSearchAll(vec, ftsQuery, searchOpts);
```

- [ ] **Step 2: Update embed.ts**

Key change in `embedItems`:
```typescript
// insertFn becomes async
insertFn: (id: number, embedding: Float32Array) => Promise<void>,
// ...
await insertFn(batch[j].id, vecs[j]!);
```

In `runEmbed`:
```typescript
(id, emb) => db.insertEmbedding(id, emb),  // already returns Promise
```

- [ ] **Step 3: Update remaining commands**

Each command file: add `await` before every `db.*()` call. The function signatures already return `Promise<void>`.

For `sql.ts`: `db.execute()` replaces `db.db.query().all()`.

- [ ] **Step 4: Run all command tests**

Run: `bun test test/commands/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/
git commit -m "refactor: update all commands for async TraulDB API"
```

---

### Task 8: Update connectors for async DB

**Files:**
- Modify: `src/connectors/*.ts` (slack, discord, telegram, gmail, whatsapp, linear, claudecode, markdown)

- [ ] **Step 1: Update each connector**

Mechanical change — add `await` before every `db.*()` call:
- `db.upsertMessage(...)` → `await db.upsertMessage(...)`
- `db.upsertContact(...)` → `await db.upsertContact(...)`
- `db.upsertContactIdentity(...)` → `await db.upsertContactIdentity(...)`
- `db.hasMessage(...)` → `await db.hasMessage(...)`
- `db.getSyncCursor(...)` → `await db.getSyncCursor(...)`
- `db.setSyncCursor(...)` → `await db.setSyncCursor(...)`
- `db.getMessagesBySource(...)` → `await db.getMessagesBySource(...)`

- [ ] **Step 2: Run connector tests if any**

Run: `bun test`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/connectors/
git commit -m "refactor: update all connectors for async TraulDB API"
```

---

### Task 9: Update `index.ts` — async init and description fix

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Make DB init async**

```typescript
// Before:
const db = new TraulDB(config.database.path);
runMigrations(db);

// After:
const db = await TraulDB.create(config.database.path);
await runMigrations(db);
```

Wrap in an async IIFE or top-level await (Bun supports it).

- [ ] **Step 2: Fix search command description**

```typescript
// Before:
.description("Search messages (hybrid vector+keyword by default, requires Ollama)")

// After:
.description("Search messages (hybrid vector+keyword by default)")
```

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: async DB init, remove 'requires Ollama' from search description"
```

---

### Task 10: Auto-embed on migration

**Files:**
- Modify: `src/db/migrations.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Add auto-embed trigger to migration result**

In `migrations.ts`, the `MigrationResult` already has `embeddingsReset: boolean`. No change needed to the interface.

- [ ] **Step 2: Trigger embed in index.ts after migration**

```typescript
const db = await TraulDB.create(config.database.path);
const migrationResult = await runMigrations(db);

if (migrationResult.embeddingsReset) {
  console.log("Re-embedding all messages after migration...");
  await runEmbed(db, { limit: "0", quiet: false });
}
```

This runs the full embed pipeline (limit: "0" means no limit) automatically when the migration resets embeddings.

- [ ] **Step 3: Test manually**

Run: `bun run src/index.ts stats`
Expected: starts up, runs migration if needed, shows stats.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts src/db/migrations.ts
git commit -m "feat: auto-embed all messages after schema v2 migration"
```

---

### Task 11: Update `package.json` and clean up

**Files:**
- Modify: `package.json`
- Modify: `src/db/schema.ts` (if `EMBED_DIMS` import chain needs fixing)

- [ ] **Step 1: Verify no remaining sqlite-vec or bun:sqlite references**

```bash
grep -r "sqlite-vec\|bun:sqlite\|OLLAMA" src/ --include="*.ts" -l
```

Expected: no results (all removed).

- [ ] **Step 2: Verify no remaining vecToBytes references**

```bash
grep -r "vecToBytes" src/ --include="*.ts" -l
```

Expected: no results.

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: all PASS

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: clean up remaining sqlite-vec and Ollama references"
```

---

### Task 12: Performance verification

- [ ] **Step 1: Build and run search benchmark**

```bash
bun -e "
const { TraulDB } = await import('./src/db/database');
const { embedQuery } = await import('./src/lib/embeddings');

const db = await TraulDB.create(process.env.HOME + '/.local/share/traul/traul.db');

const t0 = Date.now();
const vec = await embedQuery('hetzner');
console.log('embedQuery:', Date.now() - t0, 'ms');

const t1 = Date.now();
const results = await db.vectorSearch(vec, { limit: 20 });
console.log('vectorSearch:', Date.now() - t1, 'ms, results:', results.length);

const t2 = Date.now();
const chunks = await db.vectorSearchChunks(vec, { limit: 20 });
console.log('vectorSearchChunks:', Date.now() - t2, 'ms, results:', chunks.length);

const t3 = Date.now();
const hybrid = await db.hybridSearchAll(vec, 'hetzner', { limit: 20 });
console.log('hybridSearchAll:', Date.now() - t3, 'ms, results:', hybrid.length);

const t4 = Date.now();
const fts = await db.ftsSearchAll('hetzner', { limit: 20 });
console.log('ftsSearch:', Date.now() - t4, 'ms, results:', fts.length);

db.close();
process.exit(0);
"
```

Expected: vectorSearch and vectorSearchChunks < 50ms each, hybridSearchAll < 100ms.

- [ ] **Step 2: Run full CLI search**

```bash
bun run src/index.ts search "hetzner"
```

Expected: results in < 2 seconds total (including model load).

- [ ] **Step 3: Commit any fixes**

If performance targets aren't met, investigate and fix before committing.

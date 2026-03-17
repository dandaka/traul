# Personal Intelligence System: Architecture Research

Deep research on architecture patterns for personal-scale knowledge/intelligence systems.
Compiled 2026-03-14.

---

## 1. Storage: SQLite as the Foundation

### Why SQLite for Personal Scale

"Personal scale" means roughly:
- 100K-1M messages across all sources
- 10K contacts
- 5 years of accumulated data
- ~1-10 GB total storage

SQLite handles this trivially. For context:
- Signal stores all messages in SQLite (billions of installs)
- Apple uses SQLite for Messages, Photos metadata, Contacts, Safari history
- Android uses SQLite for SMS, contacts, call logs
- Obsidian's hybrid retriever stores 49,746 chunks from 16,894 files in 83 MB

**SQLite advantages for this use case:**
- Local-first, single file, zero config, no server process
- FTS5 built-in for full-text search
- WAL mode handles concurrent reads well
- Backup = copy one file
- Works on every platform (mobile, desktop, server, WASM)
- Enormous ecosystem of extensions

**SQLite limitations to be aware of:**
- Single-writer (WAL mode helps but one write at a time)
- No native vector search (solved by sqlite-vec extension)
- No built-in replication (but not needed at personal scale)
- No stored procedures (use application code)

### SQLite vs Postgres vs Graph DBs

| Criteria | SQLite | Postgres | Neo4j |
|----------|--------|----------|-------|
| Setup | Zero | Server needed | Server needed |
| Backup | Copy file | pg_dump | Export |
| FTS | FTS5 built-in | tsvector | Lucene index |
| Vectors | sqlite-vec | pgvector | Plugin |
| Local-first | Native | No | No |
| Mobile | Yes | No | No |
| Scale ceiling | ~1TB practical | Unlimited | Unlimited |

**Recommendation:** SQLite is the clear winner for personal scale. Postgres adds operational overhead with no benefit at this scale. Graph databases (Neo4j) are interesting for relationship traversal but add massive complexity — you can model graphs in SQLite with junction tables and recursive CTEs.

### Core Schema Design

```sql
-- Unified message/event store
CREATE TABLE messages (
    id TEXT PRIMARY KEY,           -- UUID
    source TEXT NOT NULL,          -- 'slack', 'email', 'telegram', 'linear', 'calendar'
    source_id TEXT NOT NULL,       -- Original ID in source system
    source_channel TEXT,           -- Channel/thread/folder in source
    author_id TEXT,                -- FK to contacts
    content TEXT,                  -- Raw text content
    content_html TEXT,             -- Rich content if available
    metadata JSON,                 -- Source-specific fields
    created_at TEXT NOT NULL,      -- ISO 8601
    ingested_at TEXT NOT NULL,     -- When we pulled it in
    updated_at TEXT,
    UNIQUE(source, source_id)     -- Dedup constraint
);

CREATE INDEX idx_messages_source ON messages(source, source_channel);
CREATE INDEX idx_messages_author ON messages(author_id);
CREATE INDEX idx_messages_created ON messages(created_at);

-- Contact/entity store
CREATE TABLE contacts (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    metadata JSON,                 -- Emails, handles, phone numbers
    first_seen_at TEXT,
    last_seen_at TEXT
);

-- Contact identity mapping (one contact, many identities)
CREATE TABLE contact_identities (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL REFERENCES contacts(id),
    source TEXT NOT NULL,           -- 'slack', 'email', 'telegram'
    identity_value TEXT NOT NULL,   -- Email, Slack user ID, Telegram handle
    UNIQUE(source, identity_value)
);

-- Thread/conversation grouping
CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    source_thread_id TEXT,
    subject TEXT,
    started_at TEXT,
    last_activity_at TEXT,
    participant_count INTEGER,
    message_count INTEGER,
    metadata JSON
);

CREATE TABLE thread_messages (
    thread_id TEXT REFERENCES threads(id),
    message_id TEXT REFERENCES messages(id),
    position INTEGER,
    PRIMARY KEY (thread_id, message_id)
);

-- Sync state tracking
CREATE TABLE sync_cursors (
    source TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT '',
    cursor_value TEXT,              -- Timestamp, page token, offset
    cursor_type TEXT DEFAULT 'timestamp', -- 'timestamp', 'token', 'offset'
    last_sync_at TEXT,
    sync_count INTEGER DEFAULT 0,
    PRIMARY KEY (source, channel)
);

-- Signals/alerts generated
CREATE TABLE signals (
    id TEXT PRIMARY KEY,
    signal_type TEXT NOT NULL,      -- 'stale_thread', 'missed_followup', 'deadline'
    entity_type TEXT,               -- 'thread', 'contact', 'message'
    entity_id TEXT,
    priority REAL DEFAULT 0.5,      -- 0.0 to 1.0
    title TEXT NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL,
    dismissed_at TEXT,
    acted_on_at TEXT
);
```

---

## 2. Search: FTS5 + sqlite-vec Hybrid

### FTS5 Capabilities

SQLite FTS5 is battle-tested (billions of devices) and provides:
- Full-text indexing with BM25 ranking
- Prefix queries, phrase queries, boolean operators (AND/OR/NOT)
- Column filters, proximity queries
- Auxiliary functions (snippet, highlight, bm25)
- Sub-millisecond query time at personal scale

```sql
-- FTS5 index for messages
CREATE VIRTUAL TABLE fts_messages USING fts5(
    content,
    source,
    source_channel,
    content='messages',
    content_rowid='rowid',
    tokenize='porter unicode61'     -- Stemming + unicode support
);

-- Triggers to keep FTS in sync
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO fts_messages(rowid, content, source, source_channel)
    VALUES (new.rowid, new.content, new.source, new.source_channel);
END;

CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO fts_messages(fts_messages, rowid, content, source, source_channel)
    VALUES ('delete', old.rowid, old.content, old.source, old.source_channel);
END;

CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO fts_messages(fts_messages, rowid, content, source, source_channel)
    VALUES ('delete', old.rowid, old.content, old.source, old.source_channel);
    INSERT INTO fts_messages(rowid, content, source, source_channel)
    VALUES (new.rowid, new.content, new.source, new.source_channel);
END;
```

### Do You Need a Dedicated Search Engine?

**No, not at personal scale.** FTS5 handles 1M documents with sub-millisecond latency. Typesense and Meilisearch add:
- Typo tolerance (nice-to-have, not critical for personal data you wrote)
- Faceted search (can be done with SQL GROUP BY)
- Another service to run and maintain

The only reason to consider Meilisearch/Typesense: if you want a polished search UI with instant results, facets, and typo correction out of the box. For an MCP server backend, FTS5 is more than sufficient.

### Hybrid Search with sqlite-vec

sqlite-vec (by Alex Garcia) is the successor to sqlite-vss. Key facts:
- **Status:** Stable (v0.1.0+), actively maintained, Mozilla Builders funded
- **Written in:** Pure C, zero dependencies
- **Runs on:** Linux, macOS, Windows, WASM, Raspberry Pi, mobile
- **Bindings:** Python, Node.js, Deno, Bun, Rust, Go, Ruby
- **Performance:** 100K vectors of dim 384 (float32) uses ~37 MB RAM, fast enough for brute-force KNN at personal scale
- **sqlite-vss is deprecated** — use sqlite-vec

**Hybrid search with Reciprocal Rank Fusion (RRF):**

```sql
-- Hybrid search: FTS5 keyword + sqlite-vec semantic, merged with RRF
WITH params AS (
    SELECT
        :query AS query,
        :k AS k,
        60 AS rrf_k,
        1.0 AS weight_fts,
        1.0 AS weight_vec
),
vec_matches AS (
    SELECT
        rowid AS message_rowid,
        row_number() OVER (ORDER BY distance) AS rank_number,
        distance
    FROM vec_messages
    WHERE content_embedding MATCH lembed(:query)
      AND k = :k
),
fts_matches AS (
    SELECT
        rowid AS message_rowid,
        row_number() OVER (ORDER BY rank) AS rank_number,
        rank AS score
    FROM fts_messages
    WHERE content MATCH :query
    LIMIT :k
),
final AS (
    SELECT
        COALESCE(v.message_rowid, f.message_rowid) AS message_rowid,
        (
            COALESCE(1.0 / (60 + f.rank_number), 0.0) * 1.0 +
            COALESCE(1.0 / (60 + v.rank_number), 0.0) * 1.0
        ) AS combined_rank
    FROM vec_matches v
    FULL OUTER JOIN fts_matches f ON v.message_rowid = f.message_rowid
)
SELECT m.*, final.combined_rank
FROM final
JOIN messages m ON m.rowid = final.message_rowid
ORDER BY final.combined_rank DESC
LIMIT :k;
```

**Note:** SQLite does not natively support FULL OUTER JOIN. Use a UNION approach instead:

```sql
-- Practical SQLite version using UNION
WITH vec_matches AS (
    SELECT rowid, row_number() OVER (ORDER BY distance) AS rank_num
    FROM vec_messages
    WHERE content_embedding MATCH lembed(:query) AND k = :k
),
fts_matches AS (
    SELECT rowid, row_number() OVER (ORDER BY rank) AS rank_num
    FROM fts_messages WHERE content MATCH :query LIMIT :k
),
all_matches AS (
    SELECT rowid FROM vec_matches
    UNION
    SELECT rowid FROM fts_matches
)
SELECT m.id, m.content, m.source, m.created_at,
    COALESCE(1.0 / (60 + f.rank_num), 0.0) +
    COALESCE(1.0 / (60 + v.rank_num), 0.0) AS rrf_score
FROM all_matches a
JOIN messages m ON m.rowid = a.rowid
LEFT JOIN vec_matches v ON v.rowid = a.rowid
LEFT JOIN fts_matches f ON f.rowid = a.rowid
ORDER BY rrf_score DESC
LIMIT :k;
```

---

## 3. Vector Search Details

### sqlite-vec Setup

```sql
-- Load the extension
.load ./vec0

-- Create vector table for message embeddings
CREATE VIRTUAL TABLE vec_messages USING vec0(
    message_rowid INTEGER PRIMARY KEY,
    content_embedding float[384]    -- 384 dims for MiniLM/gte-small
);

-- Populate from existing messages
INSERT INTO vec_messages(message_rowid, content_embedding)
SELECT rowid, embed(content) FROM messages;

-- KNN query
SELECT message_rowid, distance
FROM vec_messages
WHERE content_embedding MATCH embed('project deadline next week')
ORDER BY distance
LIMIT 20;
```

### Embedding Model Recommendations for Personal Data

For personal/communication data, prioritize speed and local execution over benchmark scores.

**Recommended: nomic-embed-text (via Ollama)**
- 137M params, 768 dims
- 86.2% top-5 accuracy (best in class for its size)
- Runs locally via Ollama: `ollama pull nomic-embed-text`
- 8192 token context (handles long emails/documents)
- Fully offline, no API keys

**Budget/speed option: all-MiniLM-L6-v2**
- 22M params, 384 dims
- 14.7ms per 1K tokens (blazing fast)
- Lower accuracy (~56% top-5) but adequate for personal recall
- Tiny model, runs anywhere

**Best accuracy: gte-small or e5-small-v2**
- Good balance of speed (16ms latency) and accuracy
- 33M params, 384 dims

**Practical setup with Ollama:**

```typescript
import { Ollama } from 'ollama';

const ollama = new Ollama();

async function embed(text: string): Promise<number[]> {
    const response = await ollama.embeddings({
        model: 'nomic-embed-text',
        prompt: text,
    });
    return response.embedding;
}
```

### sqlite-vec vs Separate Vector DB

At personal scale (< 1M vectors), sqlite-vec is sufficient. A separate vector DB (Qdrant, ChromaDB) adds:
- Approximate nearest neighbor (ANN) for faster search at scale — unnecessary under 1M vectors
- Another service to run
- Data synchronization complexity

**Recommendation:** Start with sqlite-vec. Only graduate to Qdrant if you exceed ~5M vectors or need filtered vector search that sqlite-vec cannot express efficiently.

---

## 4. Multi-Source Ingestion

### Connector Architecture

```typescript
// Core connector interface
interface Connector {
    readonly source: string;        // 'slack', 'email', 'telegram', etc.

    // Incremental sync: fetch new items since last cursor
    sync(cursor: SyncCursor | null): AsyncGenerator<IngestItem>;

    // Get current sync state
    getCursor(): Promise<SyncCursor>;
}

interface SyncCursor {
    source: string;
    channel: string;
    cursorValue: string;            // Timestamp, page token, etc.
    cursorType: 'timestamp' | 'token' | 'offset';
}

interface IngestItem {
    source: string;
    sourceId: string;
    sourceChannel?: string;
    authorIdentity?: { source: string; value: string };
    content: string;
    contentHtml?: string;
    metadata?: Record<string, unknown>;
    createdAt: string;              // ISO 8601
    threadId?: string;
}

// Connector registry
class ConnectorRegistry {
    private connectors: Map<string, Connector> = new Map();

    register(connector: Connector) {
        this.connectors.set(connector.source, connector);
    }

    async syncAll(db: Database) {
        for (const [source, connector] of this.connectors) {
            const cursor = await db.getSyncCursor(source);
            for await (const item of connector.sync(cursor)) {
                await db.upsertMessage(item);   // INSERT OR IGNORE via UNIQUE constraint
            }
            await db.updateSyncCursor(source, await connector.getCursor());
        }
    }
}
```

### Incremental Sync Patterns by Source

| Source | Best Pattern | Cursor Type | Notes |
|--------|-------------|-------------|-------|
| Slack | conversations.history + cursor | timestamp | Use `oldest` param, paginate with `cursor` |
| Email (IMAP) | IMAP SEARCH SINCE | UID | Track highest UID per folder |
| Telegram | MTProto getHistory | message ID | Use `min_id` for incremental |
| Linear | GraphQL + `updatedAt` filter | timestamp | Has webhook support too |
| Calendar (CalDAV) | REPORT with time-range | sync-token | Google Calendar has sync tokens |
| Git | git log --after | commit hash | Simple and reliable |

### Deduplication Strategy

Cross-source deduplication is hard. Practical approaches:

1. **Source-level dedup** (easy, do this first): `UNIQUE(source, source_id)` prevents duplicate ingestion from same source.

2. **Content fingerprinting** (medium difficulty): Hash normalized content to detect exact duplicates across sources.

```sql
-- Add content hash for cross-source dedup
ALTER TABLE messages ADD COLUMN content_hash TEXT;
CREATE INDEX idx_messages_hash ON messages(content_hash);

-- On insert, compute: SHA256(normalize(content))
-- normalize = lowercase, strip whitespace, remove signatures
```

3. **Semantic dedup** (hard, usually overkill): Use vector similarity to find near-duplicates. Only worth it if you have significant cross-posting (e.g., same update sent to Slack AND email).

**Recommendation:** Start with source-level dedup. Add content hashing if you notice duplicates. Skip semantic dedup unless it becomes a real problem.

---

## 5. Proactive Signal Engine

### SQL-Driven Signal Detection

The key insight: most useful signals can be expressed as SQL queries that run on a schedule (cron). No LLM needed for detection — only for summarization/presentation.

### Signal Query Examples

```sql
-- Signal: Stale threads (no activity in N days, I was a participant)
INSERT INTO signals (id, signal_type, entity_type, entity_id, priority, title, created_at)
SELECT
    'stale-' || t.id,
    'stale_thread',
    'thread',
    t.id,
    CASE
        WHEN julianday('now') - julianday(t.last_activity_at) > 14 THEN 0.9
        WHEN julianday('now') - julianday(t.last_activity_at) > 7 THEN 0.7
        ELSE 0.5
    END AS priority,
    'Thread "' || COALESCE(t.subject, 'Untitled') || '" has been quiet for ' ||
        CAST(julianday('now') - julianday(t.last_activity_at) AS INTEGER) || ' days',
    datetime('now')
FROM threads t
JOIN thread_messages tm ON tm.thread_id = t.id
JOIN messages m ON m.id = tm.message_id
WHERE t.last_activity_at < datetime('now', '-3 days')
  AND m.author_id = :my_contact_id
  AND t.id NOT IN (SELECT entity_id FROM signals WHERE signal_type = 'stale_thread' AND dismissed_at IS NULL)
GROUP BY t.id;

-- Signal: Unanswered questions (messages ending with ? where I'm mentioned, no reply)
INSERT INTO signals (id, signal_type, entity_type, entity_id, priority, title, created_at)
SELECT
    'unanswered-' || m.id,
    'missed_followup',
    'message',
    m.id,
    0.8,
    'Unanswered question from ' || c.display_name || ' (' ||
        CAST(julianday('now') - julianday(m.created_at) AS INTEGER) || ' days ago)',
    datetime('now')
FROM messages m
JOIN contacts c ON c.id = m.author_id
WHERE m.content LIKE '%?%'
  AND m.created_at > datetime('now', '-14 days')
  AND m.author_id != :my_contact_id
  AND m.id NOT IN (
      SELECT tm2.message_id FROM thread_messages tm2
      JOIN thread_messages tm3 ON tm3.thread_id = tm2.thread_id AND tm3.position > tm2.position
      JOIN messages reply ON reply.id = tm3.message_id AND reply.author_id = :my_contact_id
  )
  AND m.id NOT IN (SELECT entity_id FROM signals WHERE signal_type = 'missed_followup');

-- Signal: Deadline approaching (messages mentioning dates within next 7 days)
-- This is harder with pure SQL; better handled by extracting dates during ingestion
-- and storing them in a dedicated table:
CREATE TABLE extracted_dates (
    message_id TEXT REFERENCES messages(id),
    mentioned_date TEXT,            -- ISO 8601
    context_snippet TEXT,           -- Surrounding text
    PRIMARY KEY (message_id, mentioned_date)
);

-- Then the signal query is simple:
INSERT INTO signals (id, signal_type, entity_type, entity_id, priority, title, created_at)
SELECT
    'deadline-' || ed.message_id || '-' || ed.mentioned_date,
    'deadline_approaching',
    'message',
    ed.message_id,
    CASE
        WHEN ed.mentioned_date <= date('now', '+1 day') THEN 1.0
        WHEN ed.mentioned_date <= date('now', '+3 days') THEN 0.8
        ELSE 0.6
    END,
    'Deadline: ' || ed.context_snippet || ' (' || ed.mentioned_date || ')',
    datetime('now')
FROM extracted_dates ed
WHERE ed.mentioned_date BETWEEN date('now') AND date('now', '+7 days')
  AND ed.message_id NOT IN (SELECT entity_id FROM signals WHERE signal_type = 'deadline_approaching');

-- Signal: Contact going cold (frequent contact who stopped communicating)
WITH contact_activity AS (
    SELECT
        author_id,
        COUNT(*) FILTER (WHERE created_at > datetime('now', '-30 days')) AS recent_count,
        COUNT(*) FILTER (WHERE created_at BETWEEN datetime('now', '-90 days') AND datetime('now', '-30 days')) AS previous_count,
        MAX(created_at) AS last_message
    FROM messages
    WHERE author_id IS NOT NULL
    GROUP BY author_id
)
SELECT
    ca.author_id,
    c.display_name,
    ca.recent_count,
    ca.previous_count,
    ca.last_message
FROM contact_activity ca
JOIN contacts c ON c.id = ca.author_id
WHERE ca.previous_count >= 10          -- Was active before
  AND ca.recent_count <= 1             -- Went quiet
  AND ca.author_id != :my_contact_id;
```

### Evaluation Architecture

```
Cron (every 15min or hourly)
    |
    v
Run signal queries against SQLite
    |
    v
INSERT new signals (idempotent via conflict detection)
    |
    v
MCP server exposes signals via get_signals tool
    |
    v
Claude reads signals during daily briefing
```

**Cron vs event-driven:** Use cron. At personal scale, running signal queries every 15 minutes is cheap (milliseconds of compute). Event-driven adds complexity with no benefit.

---

## 6. Memory and Relevance

### Relevance Scoring Formula

Combine recency, frequency, and importance into a single score:

```sql
-- Relevance score for a message
-- Uses exponential decay with configurable half-life
SELECT
    m.id,
    m.content,
    m.source,
    -- Recency: exponential decay, half-life of 14 days
    EXP(-0.693 * (julianday('now') - julianday(m.created_at)) / 14.0) AS recency_score,
    -- Frequency: how often this thread/contact appears (log-scaled)
    LOG(1 + COUNT(*) OVER (PARTITION BY m.author_id)) / 10.0 AS frequency_score,
    -- Importance: based on source and engagement signals
    CASE m.source
        WHEN 'email' THEN 0.7
        WHEN 'slack' THEN 0.5
        WHEN 'linear' THEN 0.8
        WHEN 'calendar' THEN 0.9
        ELSE 0.3
    END AS importance_base
FROM messages m;

-- Combined relevance (weighted sum)
-- final_score = 0.4 * recency + 0.3 * frequency + 0.3 * importance
```

### Memory Decay Function

```typescript
// Exponential decay with half-life
function decayScore(ageInHours: number, halfLifeHours: number = 336): number {
    // 336 hours = 14 days
    const decayRate = Math.LN2 / halfLifeHours;
    return Math.exp(-decayRate * ageInHours);
}

// Combined relevance with ACT-R-inspired frequency boost
function relevanceScore(params: {
    ageHours: number;
    accessCount: number;       // How often retrieved/referenced
    importanceBase: number;    // 0-1 from source/type
    halfLifeDays?: number;
}): number {
    const halfLifeHours = (params.halfLifeDays ?? 14) * 24;
    const recency = decayScore(params.ageHours, halfLifeHours);

    // ACT-R: each access reinforces memory
    // Log scale prevents runaway scores
    const frequency = Math.log(1 + params.accessCount) / Math.log(100);

    // Weighted combination
    return 0.4 * recency + 0.3 * frequency + 0.3 * params.importanceBase;
}
```

### MemGPT/Letta Memory Tiers (Lessons Learned)

Letta (formerly MemGPT) uses a tiered memory system inspired by OS virtual memory:

1. **Core Memory** (always in context): Key facts about the user, active projects, preferences. Equivalent to system prompt content. Updated by the agent itself via tool calls.

2. **Recall Memory** (searchable conversation history): Full conversation logs, searchable by keyword and time. Maps to our `messages` table with FTS5.

3. **Archival Memory** (long-term knowledge): Large documents, summaries, extracted knowledge. Searchable by embedding similarity. Maps to our vector store.

**Key insight from Letta:** The agent manages its own memory. It decides what to promote from recall to core memory, and what to archive. This self-editing capability is powerful but requires careful prompt engineering.

**For our system, a simpler 2-tier approach:**
- **Hot tier:** Recent messages (last 30 days) + pinned/starred items + active thread context. Always searchable, no decay applied.
- **Archive tier:** Everything older. Decay-weighted search results. Summarized on demand by LLM.

---

## 7. MCP Server Design

### Existing MCP Memory Servers (Analysis)

**Official MCP Memory Server** (modelcontextprotocol/servers/src/memory):
- Knowledge graph with entities, relations, observations
- Tools: `create_entities`, `create_relations`, `add_observations`, `delete_entities`, `search_nodes`, `open_nodes`, `read_graph`
- Storage: JSON file (simple but not scalable)
- No search beyond exact name matching
- Good interface design, limited implementation

**Community projects worth studying:**
- **memory-journal-mcp**: Triple search (keyword + semantic + graph), GitHub integration, persistent across sessions
- **codebase-memory-mcp**: Go binary, indexes code into knowledge graph, sub-ms queries
- **kb-mcp-server**: Uses txtai for embeddings, RAG-oriented

### Recommended MCP Tool Interface

```typescript
// MCP server tools for personal intelligence system

const tools = [
    // Search across all sources
    {
        name: "search",
        description: "Search messages, contacts, and threads across all sources using hybrid keyword + semantic search",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Search query (natural language or keywords)" },
                sources: {
                    type: "array",
                    items: { type: "string", enum: ["slack", "email", "telegram", "linear", "calendar", "git"] },
                    description: "Filter to specific sources (omit for all)"
                },
                timeRange: {
                    type: "object",
                    properties: {
                        after: { type: "string", description: "ISO 8601 date" },
                        before: { type: "string", description: "ISO 8601 date" }
                    }
                },
                limit: { type: "number", default: 10 }
            },
            required: ["query"]
        }
    },

    // Get daily briefing
    {
        name: "daily_briefing",
        description: "Get a summary of signals, stale threads, upcoming deadlines, and recent activity",
        inputSchema: {
            type: "object",
            properties: {
                date: { type: "string", description: "Date for briefing (default: today)" }
            }
        }
    },

    // Get active signals
    {
        name: "get_signals",
        description: "Get proactive signals (stale threads, missed follow-ups, deadlines)",
        inputSchema: {
            type: "object",
            properties: {
                types: {
                    type: "array",
                    items: { type: "string", enum: ["stale_thread", "missed_followup", "deadline_approaching", "contact_cold"] }
                },
                minPriority: { type: "number", default: 0.5 }
            }
        }
    },

    // Dismiss or act on a signal
    {
        name: "resolve_signal",
        description: "Mark a signal as dismissed or acted upon",
        inputSchema: {
            type: "object",
            properties: {
                signalId: { type: "string" },
                action: { type: "string", enum: ["dismiss", "acted_on"] }
            },
            required: ["signalId", "action"]
        }
    },

    // Contact context
    {
        name: "contact_context",
        description: "Get full context about a contact: recent messages, shared threads, communication frequency",
        inputSchema: {
            type: "object",
            properties: {
                name: { type: "string", description: "Contact name or partial match" },
                includeMessages: { type: "boolean", default: true },
                messageLimit: { type: "number", default: 20 }
            },
            required: ["name"]
        }
    },

    // Thread context
    {
        name: "thread_context",
        description: "Get full thread history and participants",
        inputSchema: {
            type: "object",
            properties: {
                threadId: { type: "string" },
                summarize: { type: "boolean", default: false, description: "Return LLM summary instead of raw messages" }
            },
            required: ["threadId"]
        }
    },

    // Remember / save a note
    {
        name: "remember",
        description: "Save a note, insight, or decision for future retrieval",
        inputSchema: {
            type: "object",
            properties: {
                content: { type: "string" },
                tags: { type: "array", items: { type: "string" } },
                relatedTo: { type: "string", description: "Contact name or thread ID this relates to" }
            },
            required: ["content"]
        }
    }
];
```

---

## 8. Recommended Architecture

```
                    +-----------------+
                    |   Claude (MCP)  |
                    |   Client        |
                    +--------+--------+
                             |
                    MCP Protocol (stdio/SSE)
                             |
                    +--------v--------+
                    |   MCP Server    |
                    |   (TypeScript)  |
                    +--------+--------+
                             |
              +--------------+--------------+
              |              |              |
    +---------v---+  +-------v-----+  +----v--------+
    |   SQLite    |  |  sqlite-vec |  |   FTS5      |
    |   (core DB) |  |  (vectors)  |  |   (search)  |
    +-------------+  +-------------+  +-------------+
              All in one .db file
                             |
              +--------------+--------------+
              |              |              |
    +---------v---+  +-------v-----+  +----v--------+
    |   Slack     |  |   Email     |  |  Telegram   |
    |  Connector  |  |  Connector  |  |  Connector  |
    +-------------+  +-------------+  +-------------+
    |   Linear    |  |  Calendar   |  |    Git      |
    |  Connector  |  |  Connector  |  |  Connector  |
    +-------------+  +-------------+  +-------------+

    Signal Engine (cron every 15min)
        - Stale thread detection
        - Missed follow-up detection
        - Deadline tracking
        - Contact activity analysis
```

### Technology Stack

- **Runtime:** Bun (TypeScript)
- **Database:** SQLite via `bun:sqlite`
- **Full-text search:** FTS5 (built-in)
- **Vector search:** sqlite-vec
- **Embeddings:** nomic-embed-text via Ollama (local)
- **MCP framework:** `@modelcontextprotocol/sdk`
- **Scheduler:** node-cron or system crontab
- **Connectors:** TypeScript modules implementing `Connector` interface

### Implementation Order

1. **Phase 1 — Core:** SQLite schema + FTS5 + MCP server with search tool
2. **Phase 2 — Connectors:** Slack connector (most data), then email
3. **Phase 3 — Vectors:** Add sqlite-vec + nomic-embed-text for semantic search
4. **Phase 4 — Signals:** Signal engine with cron + daily briefing tool
5. **Phase 5 — Memory:** Relevance scoring, decay functions, contact context

---

## Sources

### Storage & SQLite
- [SQLite Most Deployed](https://www.sqlite.org/mostdeployed.html)
- [Building a Hybrid Retriever for 16,894 Obsidian Files](https://blakecrosley.com/blog/hybrid-retriever-obsidian)

### Search & sqlite-vec
- [sqlite-vec GitHub](https://github.com/asg017/sqlite-vec)
- [sqlite-vec Stable Release Blog](https://alexgarcia.xyz/blog/2024/sqlite-vec-stable-release/index.html)
- [Hybrid FTS + Vector Search with SQLite](https://alexgarcia.xyz/blog/2024/sqlite-vec-hybrid-search/index.html)
- [sqlite-vec Documentation](https://alexgarcia.xyz/sqlite-vec/)
- [The State of Vector Search in SQLite](https://marcobambini.substack.com/p/the-state-of-vector-search-in-sqlite)
- [sqlite-vec Mozilla Builders](https://builders.mozilla.org/project/sqlite-vec/)
- [ZeroClaw Hybrid Memory: SQLite Vector + FTS5](https://zeroclaws.io/blog/zeroclaw-hybrid-memory-sqlite-vector-fts5/)

### Embedding Models
- [Best Open-Source Embedding Models Benchmarked](https://supermemory.ai/blog/best-open-source-embedding-models-benchmarked-and-ranked/)
- [Comparing Local Embedding Models for RAG](https://medium.com/@jinmochong/comparing-local-embedding-models-for-rag-systems-all-minilm-nomic-and-openai-ee425b507263)
- [Best Embedding Models 2026](https://elephas.app/blog/best-embedding-models)

### Memory & Relevance
- [MemGPT Paper](https://arxiv.org/abs/2310.08560)
- [Letta Docs — MemGPT Concepts](https://docs.letta.com/concepts/memgpt/)
- [Mastering Memory Consistency in AI Agents](https://sparkco.ai/blog/mastering-memory-consistency-in-ai-agents-2025-insights)
- [Multi-Tier Persistent Memory for LLMs](https://healthark.ai/persistent-memory-for-llms-designing-a-multi-tier-context-system/)
- [Time-Decay Weighting for Memory Search](https://github.com/openclaw/openclaw/issues/5547)

### MCP Servers
- [Official MCP Memory Server](https://github.com/modelcontextprotocol/servers/tree/main/src/memory)
- [Memory Journal MCP](https://github.com/neverinfamous/memory-journal-mcp)
- [Codebase Memory MCP](https://github.com/DeusData/codebase-memory-mcp)
- [KB MCP Server](https://github.com/Geeksfino/kb-mcp-server)
- [Awesome MCP Servers — Knowledge Management](https://github.com/TensorBlock/awesome-mcp-servers/blob/main/docs/knowledge-management--memory.md)

### Architecture & Patterns
- [Plugin Architecture in TypeScript](https://dev.to/hexshift/designing-a-plugin-system-in-typescript-for-modular-web-applications-4db5)
- [SQLite Memory — Hybrid Retrieval](https://github.com/sqliteai/sqlite-memory)
- [Second Brain I/O](https://second-brain.io)

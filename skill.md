---
name: traul
description: Personal Intelligence Engine CLI for syncing, searching, and monitoring messages from Slack, Telegram, Discord, Linear, Gmail, Claude Code sessions, Markdown files, and WhatsApp. Use when working with traul commands, message sync, search, signals, briefings, or browsing chat history.
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
  - Glob
  - Grep
---

# Traul — Personal Intelligence Engine

CLI tool that watches communication streams (Slack, Telegram, Discord, Linear, Gmail, Claude Code sessions, Markdown files, WhatsApp), indexes messages, detects patterns via signals, and surfaces actionable insights.

**Runtime:** Bun + TypeScript | **DB:** SQLite (WAL mode, FTS5, sqlite-vec) | **Embeddings:** Ollama + nomic-embed-text | **Version:** 0.1.0

**Project:** `/Users/dandaka/projects/traul`

---

## CLI Commands

### `traul sync [source]`

Sync messages from communication sources incrementally.

| Argument | Description |
|----------|-------------|
| `source` | Optional. `slack`, `telegram`, `discord`, `linear`, `gmail`, `claudecode`, `markdown`, or `whatsapp`. Omit to sync all. |

- Uses cursor-based incremental sync (only fetches new messages)
- Slack: syncs channels + thread replies, caches user profiles, stores reactions/reply_count in metadata
- Telegram: syncs via `tg.py` (Telethon), 1-hour cooldown skip per chat, progress reporting every 10s
- Claude Code: reads all JSONL sessions from `~/.claude/projects/`, extracts user+assistant messages
- Markdown: walks configured dirs for `.md` files, tracks changes by content hash
- Reports messages added + contacts discovered per source

### `traul search <query>`

Hybrid search combining vector similarity (semantic) and FTS5 keyword matching with Reciprocal Rank Fusion. Falls back to FTS-only if Ollama is unavailable.

**Search modes:**
- **Hybrid (default)** — best for multi-word and exploratory queries. Finds semantically related messages even when exact keywords don't appear. Requires Ollama running with `snowflake-arctic-embed2`. Prints coverage ratio to stderr (e.g. `88% vector, 12% FTS`). Falls back to FTS-only with a warning if Ollama is unavailable.
- **FTS-only (`--fts`)** — keyword matching with BM25 ranking. Faster, but requires ALL terms to match (implicit AND). Brittle with multi-word queries, especially combined with source/channel filters.
- **OR mode (`--or`)** — joins search terms with OR instead of AND. Works with both `--fts` and hybrid. Use for broad exploratory queries where any term is relevant.
- **Substring (`--like`)** — bypasses FTS entirely, uses SQL LIKE. Useful for exact phrases that FTS tokenization breaks (e.g. "how do I").

**Tip:** Prefer hybrid (default) for broad queries like "metrics mixpanel registration". Use `--fts --or` for exploratory keyword searches matching ANY term. Use `--like` for exact phrase matching.

| Option | Description |
|--------|-------------|
| `-s, --source <source>` | Filter by source |
| `-c, --channel <channel>` | Filter by channel name |
| `-a, --after <date>` | Messages after ISO date (aliases: `--from`, `--start`) |
| `-b, --before <date>` | Messages before ISO date (aliases: `--to`, `--end`) |
| `-l, --limit <n>` | Max results (default: 20) |
| `--json` | Output as JSON |
| `--fts` | Keyword-only search (skip vector search) |
| `--or` | Join terms with OR instead of AND (works with `--fts` and hybrid) |
| `--like` | Substring match (LIKE) — bypasses FTS, useful for exact phrases |

### `traul get [thread-id]`

Retrieve a full conversation thread by its thread ID, or list all threads from a given date. Search results display thread IDs in the output so you can copy them for use with `get`.

| Option | Description |
|--------|-------------|
| `thread-id` (positional) | Thread ID (e.g. Claude Code session UUID) |
| `-d, --date <date>` | Get all threads from a date (ISO 8601) |
| `--json` | Output as JSON |

```bash
# Search shows thread IDs in results
traul search "mixpanel metrics"
# → 2026-03-10 13:06  #base  claude  [thread:abc-123-uuid]: Let me try...

# Get full conversation by thread ID
traul get abc-123-session-uuid

# List all threads from a specific date
traul get --date 2026-03-10

# JSON output
traul get abc-123-session-uuid --json
```

### `traul messages [channel]`

Browse messages chronologically (no FTS required).

| Option | Description |
|--------|-------------|
| `channel` (positional) | Exact channel name match |
| `-c, --channel <name>` | Substring match on channel name |
| `-a, --author <name>` | Filter by author name (substring) |
| `-s, --source <source>` | Filter by source |
| `--after <date>` | Messages after ISO date (alias: `--from`) |
| `--before <date>` | Messages before ISO date (alias: `--to`) |
| `-l, --limit <n>` | Max results (default: 50) |
| `--json` | Output as JSON |
| `--asc` | Oldest first (default: newest first) |

### `traul channels`

List known channels with message counts and last activity.

| Option | Description |
|--------|-------------|
| `-s, --source <source>` | Filter by source |
| `--search <term>` | Substring search in channel name |
| `--json` | Output as JSON |

### `traul sql <query>`

Execute arbitrary read-only SQL against the database. Only SELECT, PRAGMA, WITH, and EXPLAIN queries are allowed by default.

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON (default) |
| `--write` | Allow write operations (INSERT, UPDATE, DELETE, etc.) |

```bash
# Ad-hoc analytics
traul sql "SELECT source, COUNT(*) as cnt FROM messages GROUP BY source"

# Check sync cursors
traul sql "SELECT * FROM sync_cursors WHERE source='gmail'"

# Modify data (requires --write flag)
traul sql "UPDATE messages SET channel_name='renamed' WHERE channel_name='old'" --write
```

### `traul schema`

Show database tables with column names, types, and constraints. Excludes FTS shadow tables.

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |

### `traul signals`

View active signal results (not dismissed), ordered by severity then date.

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |

#### `traul signals run`

Evaluate all enabled signal definitions against the database. Seeds built-in signals automatically. Replaces `:my_user_id` placeholder with configured Slack user ID.

#### `traul signals dismiss <id>`

Dismiss a signal result by its numeric ID.

### `traul briefing`

Structured overview with three sections:
1. **Signals** — up to 10 active signals with severity/detail
2. **Stats** — total messages, channels, contacts, active signals
3. **Volume** — last 7 days message bar chart

### Global Options

| Option | Description |
|--------|-------------|
| `-v, --verbose` | Debug logging to stderr |

---

## JSON Output Fields

All `--json` outputs use clean, normalized field names (not raw SQL column names).

### `channels --json`

| Field | Type | Description |
|-------|------|-------------|
| `source` | string | Source connector name |
| `name` | string | Channel name |
| `message_count` | number | Total messages in channel |
| `last_activity` | string | ISO 8601 timestamp of last message |

### `messages --json`

| Field | Type | Description |
|-------|------|-------------|
| `sent_at` | string | ISO 8601 timestamp |
| `author` | string | Author display name |
| `content` | string | Message content |
| `channel` | string | Channel name |
| `source` | string | Source connector name |

### `search --json`

| Field | Type | Description |
|-------|------|-------------|
| `sent_at` | string | ISO 8601 timestamp |
| `author` | string | Author display name |
| `content` | string | Message content |
| `channel` | string | Channel name |
| `source` | string | Source connector name |
| `thread_id` | string | Thread/session ID (optional, present when available) |
| `rank` | number | Search relevance score (optional) |

---

## Connectors

### Slack

- **Auth:** `SLACK_BOT_TOKEN` or `SLACK_USER_TOKEN` env var (+ optional `SLACK_COOKIE_*` for user tokens)
- **Config:** `token`, `cookie`, `my_user_id`, `channels[]`
- **Features:** Pagination (200/page), thread reply fetching, user profile caching, reaction/reply_count metadata
- **Cursors:** Stored per-channel as timestamps

### Telegram

- **Auth:** `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` env vars
- **Config:** `api_id`, `api_hash`, `session_path`, `chats[]`
- **External dep:** `~/.claude/skills/telegram-telethon/scripts/tg.py` (Telethon)
- **Features:** Auto-discover chats (limit 50), 1-hour cooldown skip, progress reporting, reaction metadata
- **Cursors:** Stored per-chat

### Linear

- **Auth:** `LINEAR_API_KEY` env var for single workspace, or `LINEAR_API_KEY_<NAME>` for multiple workspaces (e.g. `LINEAR_API_KEY_TRENDLE`, `LINEAR_API_KEY_AIFC`)
- **Config:** `linear.api_key`, `linear.teams[]`, `linear.workspaces[]` (each with `name`, `api_key`, `teams[]`)
- **Features:** GraphQL API, paginated issue fetch (50/page), comments as thread replies, priority/status/labels in metadata, contact caching
- **Cursors:** Stored per-workspace+team as `<workspace>:team:<id>` or `<workspace>:all`
- **Multi-workspace:** All `LINEAR_API_KEY_*` env vars are auto-discovered as separate workspaces

### Claude Code

- **Auth:** None required (reads local files)
- **Source dir:** `~/.claude/projects/` (all project subdirectories)
- **Features:** Parses JSONL session transcripts, extracts user + assistant text messages, skips tool results/commands
- **Channel:** Project name (derived from directory name, e.g. `-Users-dandaka-projects-traul` → `traul`)
- **Thread:** Session ID (UUID)
- **Cursors:** Per-session timestamp, incremental sync

### Markdown

- **Auth:** None required (reads local files)
- **Config:** `markdown.dirs[]` — list of directories to scan (supports `~` expansion)
- **Features:** Recursive `.md` file discovery, content-hash-based change detection, re-syncs on file modification
- **Channel:** Parent directory path relative to configured base dir
- **Author:** Filename (without `.md` extension)
- **Cursors:** Per-file content hash (only re-indexes changed files)

---

## Signals System

SQL-based pattern detection engine.

### Signal Definition Structure

| Field | Description |
|-------|-------------|
| `name` | Unique identifier |
| `query` | SQL returning: `message_id`, `severity`, `title`, `detail` |
| `severity_expression` | `"info"` (static) or `"dynamic"` (from query CASE) |
| `enabled` | Boolean toggle |

### Built-in Signals

**stale-threads** — Detects threads you participated in with no reply for 3+ days.

| Severity | Condition |
|----------|-----------|
| `urgent` | No reply 14+ days |
| `warning` | No reply 7+ days |
| `info` | No reply 3+ days |

---

## Database Schema

**Location:** `~/.local/share/traul/traul.db` (configurable)

| Table | Purpose |
|-------|---------|
| `messages` | Primary message store (source, channel, author, content, sent_at, metadata JSON) |
| `messages_fts` | FTS5 virtual table (content, author_name, channel_name) with porter tokenizer |
| `vec_messages` | sqlite-vec virtual table for vector embeddings (float[768]) |
| `contacts` | Unified contact directory (display_name unique) |
| `contact_identities` | Multi-source user mapping (source + source_user_id unique) |
| `sync_cursors` | Incremental sync state per source+key |
| `signal_definitions` | Signal rules with SQL queries |
| `signal_results` | Signal matches with severity, dismissal tracking |

FTS5 is auto-synced via INSERT/UPDATE/DELETE triggers on messages.

---

## Configuration

**File:** `~/.config/traul/config.json`

```json
{
  "sync_start": "2025-01-01",
  "database": { "path": "~/.local/share/traul/traul.db" },
  "slack": {
    "token": "",
    "cookie": "",
    "my_user_id": "",
    "channels": []
  },
  "telegram": {
    "api_id": "",
    "api_hash": "",
    "session_path": "",
    "chats": []
  },
  "linear": {
    "api_key": "",
    "teams": [],
    "workspaces": []
  },
  "markdown": {
    "dirs": ["~/projects/dn-kb"]
  }
}
```

ENV vars override config values. Empty `channels`/`chats` arrays = sync all.

---

## Project Structure

```
src/
  index.ts                  # CLI entry (Commander.js)
  commands/                 # Command handlers
    sync.ts, search.ts, messages.ts, channels.ts, get.ts, signals.ts, briefing.ts, sql.ts
  connectors/               # Source adapters
    types.ts, slack.ts, telegram.ts, linear.ts, claude-code.ts, markdown.ts
  db/                       # Data layer
    schema.ts, database.ts, queries.ts
  lib/                      # Utilities
    config.ts, logger.ts, formatter.ts
  signals/                  # Signal engine
    types.ts, evaluator.ts, definitions/stale-threads.ts
```

---

## Important: Source Discovery

**Never assume a source doesn't exist just because a search returns no results.** The config and connectors evolve — always verify by listing actual data:

1. Run `traul channels -s <source>` to check if a source has synced data
2. Run `traul messages -s <source> -l 10` to browse recent messages from a source
3. If both return nothing, the source may need a sync — ask the user before running it

**Do NOT** use `traul channels --search "discord"` to check if Discord is a source — that searches *channel names* for the word "discord", not source types.

---

## Important: Sync Performance

**`traul sync` is very slow — can take up to 1 hour.** Do NOT run sync before operations like search, messages, signals, or briefing. Always work with the data already in the database. Only run sync when the user explicitly asks for it.

---

## Common Workflows

```bash
# Initial sync of all sources
traul sync

# Sync only Slack
traul sync slack

# Browse recent messages in a channel
traul messages "general" --limit 20

# Find channels matching a keyword
traul channels --search "dev"

# Search for a topic (results include thread IDs)
traul search "deployment issue" --after 2026-03-01

# Get a full thread/conversation
traul get <thread-id>
traul get --date 2026-03-10

# Exploratory search matching ANY term
traul search "deposit withdraw broken" --fts --or

# Exact phrase search (bypasses FTS tokenization)
traul search "how do I" --like -s discord -l 20

# Run signal evaluation and view results
traul signals run
traul signals

# Get a full briefing
traul briefing

# Dismiss a signal
traul signals dismiss 42

# Ad-hoc SQL queries (read-only by default)
traul sql "SELECT source, COUNT(*) as cnt FROM messages GROUP BY source"
traul sql "SELECT * FROM sync_cursors" --json

# Modify data with --write flag
traul sql "UPDATE messages SET channel_name='new' WHERE channel_name='old'" --write

# Explore database schema
traul schema
traul schema --json
```

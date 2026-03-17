# traul

Give your AI agent memory across all your communications.

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

## Why

I was constantly asking my agent to pull context from various sources. Slack, Telegram, Gmail, Discord, Linear — the usual mess. But every time it had to request items one by one, from different APIs, building up context piece by piece. It could never see the full picture.

So I built Traul. A searchable, local-only database that indexes all my communications. Full-text search, vector embeddings, semantic search — the whole thing runs locally. No data leaves your machine. I expose it as a tool to my agent, and instead of me copy-pasting context into chat, the agent searches for it on its own.

## What you can actually do with this

**Track a project across scattered conversations.** Say you have an integration and a marketing program being discussed in Slack, Telegram, and five different group chats. Agent sees through all of them. Who's blocking, whose court the ball is in, what the next steps are.

**Monitor your community.** I asked my agent to look at our Discord community and summarize what users are writing. Got a solid analysis in minutes — main topics this week, overall sentiment, what people are unhappy about. Then separately asked for a list of feature requests. Then separately — how attitude toward the product is changing over time. All of this took a few minutes.

**Monitor competitors too.** Hook up competitor Discord servers and track what their users are asking for, what they're discussing, what's broken.

**Find that one message you vaguely remember.** Recently in a discussion about Claude Code pricing, I remembered a friend sent me a link about it. Asked the agent to search my chat history — found the exact Telegram message. Vector search works way better than keyword search for this kind of thing.

**Prep for a call in seconds.** Before a recruiter call, I asked the agent to find info about this person. Found them in my email. I don't need to remember where exactly I communicated with someone — agent finds it.

**Stop being the search engine yourself.** The whole problem of "was it in Slack, Telegram, or the task tracker?" goes away. Agent tries different keywords, reads intermediate chunks, follows the chain, arrives at the result.

## Privacy

All data stays on your machine. No APIs, no external services, no cloud sync. Traul indexes and stores everything in a local SQLite database. Nothing is sent to third parties.

## Connectors

Slack · Discord · Telegram · Gmail · Linear · WhatsApp · Claude Code sessions · Markdown files

## How it works

Sources → sync → local SQLite (FTS5 + vector embeddings via Ollama) → search → your agent or CLI.

## Quick start

```sh
git clone <repo-url> && cd traul
bun install
bun link
```

**Requirements:** [Bun](https://bun.sh) v1.0+, SQLite with development headers, optionally [Ollama](https://ollama.com) for vector search.

**SQLite setup by platform:**

- **macOS:** `brew install sqlite`
- **Ubuntu/Debian:** `sudo apt-get install libsqlite3-dev`
- **Fedora/RHEL:** `sudo dnf install sqlite-devel`

The `sqlite-vec` extension is bundled and works on macOS (x64/arm64) and Linux (x64/arm64). No extra steps needed.

Full walkthrough → **[Getting Started](docs/getting-started.md)**

## Usage

```sh
traul sync                # sync all sources
traul sync slack          # sync specific source
traul search "deployment issue"
traul search "marketing launch" --source slack --after 2025-01-01
traul search "error" --fts # keyword-only, no Ollama needed
traul embed               # generate vector embeddings
traul channels            # browse channels
traul messages general --limit 50
traul stats               # database statistics
traul daemon start --detach  # background sync
```

## Configuration

Config at `~/.config/traul/config.json`. Tokens via environment variables:

| Variable | What |
|----------|------|
| `SLACK_TOKEN` | Slack token (xoxb/xoxc) |
| `DISCORD_TOKEN` | Discord bot token |
| `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` | Telegram API |
| `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` | Gmail OAuth2 |
| `LINEAR_API_KEY` | Linear API key |

Per-workspace tokens: `SLACK_TOKEN_<WORKSPACE>`, `LINEAR_API_KEY_<WORKSPACE>`.

Details → **[Getting Started](docs/getting-started.md)**

## Development

```sh
bun test
bun run dev
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). All contributions require a DCO sign-off.

## License

[GNU Affero General Public License v3.0](LICENSE) — use, modify, distribute freely. Network service deployments must release source code.

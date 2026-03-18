#!/usr/bin/env bun
import { Command } from "commander";
import { TraulDB } from "./db/database";
import { loadConfig, ensureDbDir } from "./lib/config";
import { setVerbose } from "./lib/logger";
import { runSync } from "./commands/sync";
import { runSearch } from "./commands/search";
import { runMessages } from "./commands/messages";
import { runChannels } from "./commands/channels";
import { runEmbed } from "./commands/embed";
import { runStats } from "./commands/stats";
import { runWhatsAppAuth } from "./commands/whatsapp-auth";
import { runDaemonStart, runDaemonStop, runDaemonStatus } from "./commands/daemon";
import { runSql, runSchema } from "./commands/sql";
import { runGet } from "./commands/get";

const config = loadConfig();
ensureDbDir(config.database.path);
const db = new TraulDB(config.database.path);

const program = new Command();

program
  .name("traul")
  .description("Traul — Personal Intelligence Engine")
  .version("0.1.0")
  .option("-v, --verbose", "enable verbose output")
  .hook("preAction", () => {
    if (program.opts().verbose) {
      setVerbose(true);
    }
  });

program
  .command("sync")
  .description("Sync messages from communication sources")
  .argument("[source]", "source to sync (e.g. slack)")
  .action(async (source?: string) => {
    await runSync(db, config, source);
    db.close();
  });

program
  .command("search")
  .description(
    "Search messages (hybrid vector+keyword by default, requires Ollama)"
  )
  .argument("<query>", "search query (natural language or keywords)")
  .option("-s, --source <source>", "filter by source")
  .option("-c, --channel <channel>", "filter by channel name")
  .option("-a, --after <date>", "messages after date (ISO 8601)")
  .option("-b, --before <date>", "messages before date (ISO 8601)")
  .option("--from <date>", "alias for --after")
  .option("--to <date>", "alias for --before")
  .option("--start <date>", "alias for --after")
  .option("--end <date>", "alias for --before")
  .option("-l, --limit <n>", "max results", "20")
  .option("--json", "output as JSON")
  .option(
    "--fts",
    "keyword-only search (FTS5/BM25, no vector search). Faster but requires all terms to match — use hybrid for multi-word or exploratory queries"
  )
  .option("--or", "join search terms with OR instead of AND (use with --fts)")
  .option(
    "--like",
    "substring match (LIKE) — bypasses FTS, useful for exact phrases"
  )
  .action(async (query: string, options) => {
    options.after = options.after || options.from || options.start;
    options.before = options.before || options.to || options.end;
    await runSearch(db, query, options);
    db.close();
  });

program
  .command("messages")
  .description("Browse messages chronologically")
  .argument("[channel]", "channel name (exact match)")
  .option("-c, --channel <name>", "channel name (substring match)")
  .option("-a, --author <name>", "filter by author name")
  .option("-s, --source <source>", "filter by source (telegram, slack)")
  .option("--after <date>", "messages after ISO date")
  .option("--before <date>", "messages before ISO date")
  .option("--from <date>", "alias for --after")
  .option("--to <date>", "alias for --before")
  .option("--start <date>", "alias for --after")
  .option("--end <date>", "alias for --before")
  .option("-l, --limit <n>", "max results (default: 50)")
  .option("--json", "output as JSON")
  .option("--asc", "oldest first")
  .action(async (channel: string | undefined, options) => {
    options.after = options.after || options.from || options.start;
    options.before = options.before || options.to || options.end;
    await runMessages(db, channel, options);
    db.close();
  });

program
  .command("get")
  .description("Get full thread/conversation by thread ID")
  .argument("[thread-id]", "thread ID (e.g. Claude Code session UUID)")
  .option("-d, --date <date>", "get all threads from a date (ISO 8601)")
  .option("--json", "output as JSON")
  .action(async (threadId: string | undefined, options) => {
    await runGet(db, threadId, options);
    db.close();
  });

program
  .command("channels")
  .description("List known channels with message counts")
  .option("-s, --source <source>", "filter by source")
  .option("--search <term>", "substring search in channel name")
  .option("--json", "output as JSON")
  .action(async (options) => {
    await runChannels(db, options);
    db.close();
  });

program
  .command("stats")
  .description("Show database statistics")
  .option("--json", "output as JSON")
  .action(async (options) => {
    await runStats(db, config, options);
    db.close();
  });

program
  .command("embed")
  .description("Generate vector embeddings for messages (requires Ollama)")
  .option("-l, --limit <n>", "max messages to embed per run (0 = all)", "500")
  .option("-q, --quiet", "minimal output")
  .option("--rechunk", "re-chunk long messages that were embedded whole (pre-chunking)")
  .action(async (options) => {
    await runEmbed(db, options);
    db.close();
  });

program
  .command("reset-embed")
  .description("Drop all embeddings and recreate vec tables (run 'embed' after to regenerate)")
  .action(async () => {
    const { EMBED_DIMS } = await import("./lib/embeddings");
    console.log(`Resetting vec tables to ${EMBED_DIMS} dimensions...`);
    db.resetEmbeddings(EMBED_DIMS);
    console.log("Done. Run 'traul embed' to regenerate embeddings.");
    db.close();
  });

program
  .command("sql")
  .description("Execute a read-only SQL query against the database")
  .argument("<query>", "SQL query (SELECT, PRAGMA, WITH, EXPLAIN only)")
  .option("--json", "output as JSON (default)")
  .option("--write", "allow write operations (INSERT, UPDATE, DELETE, etc.)")
  .action(async (query: string, options) => {
    const result = runSql(db, query, { write: options.write });
    if (options.json !== false) {
      const output = JSON.stringify(result, null, 2);
      process.stdout.write(output + "\n");
    } else {
      if (Array.isArray(result)) {
        console.table(result);
      } else {
        console.log(`${result.changes} row(s) affected`);
      }
    }
    db.close();
  });

program
  .command("schema")
  .description("Show database schema (tables and columns)")
  .option("--json", "output as JSON")
  .action(async (options) => {
    const tables = runSchema(db);
    if (options.json) {
      const output = JSON.stringify(tables, null, 2);
      process.stdout.write(output + "\n");
    } else {
      for (const t of tables) {
        console.log(`\n${t.name} (${t.type})`);
        if (t.columns.length > 0) {
          for (const c of t.columns) {
            const pk = c.pk ? " PK" : "";
            const nn = c.notnull ? " NOT NULL" : "";
            console.log(`  ${c.name} ${c.type}${pk}${nn}`);
          }
        }
      }
    }
    db.close();
  });

const whatsapp = program
  .command("whatsapp")
  .description("WhatsApp connector commands");

whatsapp
  .command("auth")
  .description("Authenticate a WhatsApp account via WAHA QR code")
  .argument("<account>", "account name matching config instance name")
  .action(async (account: string) => {
    await runWhatsAppAuth(config, account);
    process.exit(0);
  });

const daemon = program
  .command("daemon")
  .description("Background sync daemon");

daemon
  .command("start", { isDefault: true })
  .description("Start the daemon (foreground by default)")
  .option("--detach", "run in background")
  .action(async (options) => {
    await runDaemonStart(db, config, options);
  });

daemon
  .command("stop")
  .description("Stop the running daemon")
  .action(() => {
    runDaemonStop();
  });

daemon
  .command("status")
  .description("Check daemon status")
  .action(async () => {
    await runDaemonStatus(config);
    process.exit(0);
  });

program.parse();

import type { TraulDB } from "../db/database";
import type { TraulConfig } from "../lib/config";
import { EMBED_MODEL, EMBED_DIMS } from "../lib/embeddings";

interface HealthSource {
  auth: string;
  last_run: string | null;
  status: string;
  last_error: string | null;
  progress: { started_at: number; progress_pct: number; eta: string | null } | null;
}

interface HealthResponse {
  status: string;
  uptime: number;
  sources: Record<string, HealthSource>;
}

async function fetchHealth(port: number): Promise<HealthResponse | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    if (!res.ok) return null;
    return (await res.json()) as HealthResponse;
  } catch {
    return null;
  }
}

export async function runStats(db: TraulDB, config: TraulConfig, options: { json?: boolean }): Promise<void> {
  const stats = await db.getDetailedStats();
  const bySource = await db.getStatsBySource();
  const health = await fetchHealth(config.daemon.port);

  if (options.json) {
    console.log(JSON.stringify({ ...stats, daemon: health ? { uptime: health.uptime, sources: health.sources } : null, bySource }, null, 2));
    return;
  }

  console.log(`Database size:      ${formatBytes(stats.db_size)}`);
  console.log(`Messages:           ${stats.total_messages}`);
  console.log(`Channels:           ${stats.total_channels}`);
  console.log(`Contacts:           ${stats.total_contacts}`);
  console.log(`Chunks:             ${stats.total_chunks}`);
  console.log(`Embed model:        ${EMBED_MODEL} (${EMBED_DIMS}d)`);
  console.log(`Msg embeddings:     ${stats.embedded_messages} / ${stats.embeddable_messages}`);
  console.log(`Chunk embeddings:   ${stats.embedded_chunks} / ${stats.total_chunks}`);

  // Daemon / connector state
  console.log();
  if (!health) {
    console.log("Daemon:             not running");
  } else {
    console.log(`Daemon:             running (uptime ${formatUptime(health.uptime)})`);
    console.log();
    const names = Object.keys(health.sources).filter((n) => n !== "embed");
    const nameW = Math.max(12, ...names.map((n) => n.length));
    const header = `${"Connector".padEnd(nameW)}  Auth          Status    Last run`;
    console.log(header);
    console.log("-".repeat(header.length));
    for (const name of names) {
      const s = health.sources[name];
      const auth = s.auth.padEnd(12);
      const status = (s.status ?? "-").padEnd(8);
      const lastRun = s.last_run ? timeAgo(s.last_run) : "-";
      console.log(`${name.padEnd(nameW)}  ${auth}  ${status}  ${lastRun}`);
    }
  }

  // Per-source message breakdown
  if (bySource.length > 0) {
    console.log();
    const nameW = Math.max(10, ...bySource.map((r) => r.source.length));
    const header = `${"Source".padEnd(nameW)}  Messages  Channels  Chunks`;
    console.log(header);
    console.log("-".repeat(header.length));
    for (const row of bySource) {
      console.log(
        `${row.source.padEnd(nameW)}  ${String(row.messages).padStart(8)}  ${String(row.channels).padStart(8)}  ${String(row.chunks).padStart(6)}`
      );
    }
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

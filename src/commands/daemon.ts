import { join } from "path";
import { homedir } from "os";
import type { TraulDB } from "../db/database";
import { loadConfig, type TraulConfig } from "../lib/config";
import { Scheduler } from "../daemon/scheduler";
import { startHealthServer, stopHealthServer } from "../daemon/health";
import { writePid, readPid, removePid, isProcessAlive } from "../daemon/pid";
import { GRACEFUL_SHUTDOWN_MS } from "../daemon/types";
import { getConnector, getConnectorNames, getCredsStatus } from "../connectors/registry";
import { runEmbed } from "./embed";
import * as log from "../lib/logger";

const DATA_DIR = join(homedir(), ".local", "share", "traul");
const PID_PATH = join(DATA_DIR, "daemon.pid");
const LOG_PATH = join(DATA_DIR, "daemon.log");

export async function runDaemonStart(
  db: TraulDB,
  config: TraulConfig,
  options: { detach?: boolean },
): Promise<void> {
  // Duplicate prevention
  const existingPid = readPid(PID_PATH);
  if (existingPid !== null && isProcessAlive(existingPid)) {
    log.error(`Daemon already running (PID ${existingPid}). Use 'traul daemon stop' first.`);
    process.exit(1);
  }
  // Clean stale PID file
  if (existingPid !== null) {
    removePid(PID_PATH);
  }

  if (options.detach) {
    // Use nohup + shell to properly detach the child from this process
    const scriptPath = join(import.meta.dir, "../index.ts");
    const proc = Bun.spawn(
      ["sh", "-c", `nohup bun run "${scriptPath}" daemon start >> "${LOG_PATH}" 2>&1 &\necho $!`],
      { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
    );
    const output = await new Response(proc.stdout).text();
    const childPid = parseInt(output.trim(), 10);
    if (isNaN(childPid)) {
      log.error("Failed to start detached daemon.");
      process.exit(1);
    }
    // Wait briefly to check the child is alive
    await new Promise((r) => setTimeout(r, 500));
    if (!isProcessAlive(childPid)) {
      log.error("Daemon exited immediately. Check logs: " + LOG_PATH);
      process.exit(1);
    }
    console.log(`Daemon started (PID ${childPid}). Logs: ${LOG_PATH}`);
    process.exit(0);
  }

  // Foreground mode
  writePid(PID_PATH, process.pid);
  log.info(`Daemon starting (PID ${process.pid})...`);

  // Check credentials and determine which sources to schedule
  const credsPresent = getCredsStatus(config);
  const allNames = getConnectorNames();
  const enabled = allNames.filter((s) => credsPresent[s]);
  const missing = allNames.filter((s) => !credsPresent[s]);

  // Embed is a built-in task, not a connector — always schedule it
  enabled.push("embed");

  log.info(`Configured sources: ${enabled.join(", ")}`);
  if (missing.length > 0) {
    log.info(`Missing credentials: ${missing.join(", ")}`);
  }

  const scheduler = new Scheduler(config.daemon, async (source, onProgress) => {
    const currentConfig = loadConfig();
    if (source === "embed") {
      await runEmbed(db, { limit: "10000", quiet: true, onProgress });
    } else {
      const connector = getConnector(source);
      if (!connector) {
        log.warn(`Unknown source: ${source}`);
        return;
      }
      const result = await connector.sync(db, currentConfig);
      log.info(`${source}: ${result.messagesAdded} added, ${result.contactsAdded} contacts`);
    }
  }, enabled);

  // Health endpoint
  await startHealthServer(config.daemon.port, () => scheduler.getStates(), config);

  scheduler.start();
  log.info(`Daemon running. Health: http://127.0.0.1:${config.daemon.port}/health`);

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Clear any in-progress line (e.g. progress bar) before logging
    process.stdout.write("\r" + " ".repeat(80) + "\r");
    log.info("Shutting down...");
    scheduler.stop();
    await scheduler.waitForRunning(GRACEFUL_SHUTDOWN_MS);
    await stopHealthServer();
    removePid(PID_PATH);
    db.close();
    log.info("Daemon stopped.");
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

export function runDaemonStop(): void {
  const pid = readPid(PID_PATH);
  if (pid === null || !isProcessAlive(pid)) {
    if (pid !== null) removePid(PID_PATH);
    console.log("Daemon is not running.");
    process.exit(1);
  }

  try {
    process.kill(pid, "SIGTERM");
    console.log(`Sent SIGTERM to daemon (PID ${pid}). Waiting for shutdown...`);
    const deadline = Date.now() + 12_000;
    const poll = setInterval(() => {
      if (!isProcessAlive(pid)) {
        clearInterval(poll);
        removePid(PID_PATH);
        console.log("Daemon stopped.");
        process.exit(0);
      }
      if (Date.now() > deadline) {
        clearInterval(poll);
        log.warn("Daemon did not exit within 12s. PID file left in place.");
        process.exit(1);
      }
    }, 300);
  } catch (err) {
    log.error(`Failed to stop daemon: ${err}`);
    process.exit(1);
  }
}

export async function runDaemonStatus(config: TraulConfig): Promise<void> {
  const pid = readPid(PID_PATH);
  if (pid === null) {
    console.log("Daemon is not running.");
    process.exit(1);
  }

  if (!isProcessAlive(pid)) {
    removePid(PID_PATH);
    console.log("Daemon is not running (stale PID file cleaned).");
    process.exit(1);
  }

  try {
    const res = await fetch(`http://127.0.0.1:${config.daemon.port}/health`);
    if (res.ok) {
      const data = await res.json() as any;
      console.log(`Daemon running (PID ${pid}), uptime ${data.uptime}s`);
      console.log();
      for (const [source, info] of Object.entries(data.sources) as Array<[string, any]>) {
        const lastRun = info.last_run ? new Date(info.last_run).toLocaleTimeString() : "never";
        const error = info.last_error ? ` [${info.last_error}]` : "";
        let progressStr = "";
        if (info.progress) {
          const pct = info.progress.progress_pct;
          const eta = info.progress.eta ? new Date(info.progress.eta).toLocaleTimeString() : "?";
          progressStr = ` ${pct}% ETA ${eta}`;
        }
        console.log(`  ${source.padEnd(12)} ${info.status.padEnd(8)} last: ${lastRun}${progressStr}${error}`);
      }
    } else {
      console.log(`Daemon running (PID ${pid}), health endpoint returned ${res.status}.`);
    }
  } catch {
    console.log(`Daemon running (PID ${pid}), health endpoint unavailable.`);
  }
}

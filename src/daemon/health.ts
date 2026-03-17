import type { SourceState } from "./types";
import type { TraulConfig } from "../lib/config";
import { getCredsStatus } from "../connectors/registry";
import * as log from "../lib/logger";

type AuthStatus = "success" | "creds-empty" | "fail";

function getAuthStatuses(config: TraulConfig, states: Map<string, SourceState>): Record<string, AuthStatus> {
  const credsPresent = getCredsStatus(config);

  const result: Record<string, AuthStatus> = {};
  for (const [name, hasCreds] of Object.entries(credsPresent)) {
    if (!hasCreds) {
      result[name] = "creds-empty";
    } else {
      const state = states.get(name);
      const lastErr = state?.lastError ?? "";
      if (/401|403|auth|token|unauthorized|forbidden/i.test(lastErr)) {
        result[name] = "fail";
      } else {
        result[name] = "success";
      }
    }
  }
  return result;
}

let server: ReturnType<typeof Bun.serve> | null = null;
let startedAt: number = 0;

export async function startHealthServer(
  port: number,
  getStates: () => Map<string, SourceState>,
  config: TraulConfig,
): Promise<number> {
  startedAt = Date.now();

  try {
    server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/health" || url.pathname === "/") {
          const states = getStates();
          const auth = getAuthStatuses(config, states);
          const sources: Record<string, unknown> = {};
          for (const [name, state] of states) {
            sources[name] = {
              auth: auth[name] ?? "creds-empty",
              last_run: state.lastRun,
              status: state.status,
              last_error: state.lastError,
              progress: state.progress
                ? {
                    started_at: state.progress.startedAt,
                    progress_pct: state.progress.progressPct,
                    eta: state.progress.eta,
                  }
                : null,
            };
          }
          return Response.json({
            status: "ok",
            uptime: Math.floor((Date.now() - startedAt) / 1000),
            sources,
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });
    const actualPort = server.port ?? port;
    log.info(`Health endpoint listening on 127.0.0.1:${actualPort}`);
    return actualPort;
  } catch (err) {
    log.warn(`Could not start health endpoint on port ${port}: ${err}`);
    log.warn("Daemon will run without health endpoint.");
    return 0;
  }
}

export async function stopHealthServer(): Promise<void> {
  if (server) {
    server.stop(true);
    server = null;
  }
}

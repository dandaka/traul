// test/daemon/daemon.test.ts
import { describe, it, expect, afterEach } from "bun:test";
import { Scheduler } from "../../src/daemon/scheduler";
import { startHealthServer, stopHealthServer } from "../../src/daemon/health";
import { DEFAULT_PORT } from "../../src/daemon/types";
import { loadConfig } from "../../src/lib/config";
import { getConnectorNames } from "../../src/connectors/registry";

describe("daemon integration", () => {
  let scheduler: Scheduler | null = null;

  afterEach(async () => {
    if (scheduler) {
      scheduler.stop();
      await scheduler.waitForRunning(2000);
    }
    await stopHealthServer();
  });

  it("scheduler fires sources and health reports them", async () => {
    const fired = new Set<string>();
    const intervals: Record<string, number> = {};
    for (const name of getConnectorNames()) {
      intervals[name] = 999;
    }
    intervals.embed = 999;

    const config = { port: DEFAULT_PORT, intervals };

    scheduler = new Scheduler(config, async (source, _onProgress) => {
      fired.add(source);
    });

    const port = await startHealthServer(0, () => scheduler!.getStates(), loadConfig());
    expect(port).toBeGreaterThan(0);
    scheduler.start();

    // Wait for staggered startup to fire first few sources (2s stagger each)
    await new Promise((r) => setTimeout(r, 5000));

    // At least the first 2 connectors should have fired
    const names = getConnectorNames();
    expect(fired.has(names[0])).toBe(true);
    expect(fired.has(names[1])).toBe(true);

    // Health should reflect states
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await res.json() as any;
    expect(body.status).toBe("ok");
    expect(body.sources[names[0]]).toBeDefined();
  }, 10000);
});

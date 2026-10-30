import type { TraulDB } from "../db/database";
import type { TraulConfig } from "../lib/config";
import { getConnectors, getConnectorNames } from "../connectors/registry";
import { runEmbed } from "./embed";
import * as log from "../lib/logger";

export async function runSync(
  db: TraulDB,
  config: TraulConfig,
  source?: string
): Promise<void> {
  const connectors = getConnectors();
  const toRun = source
    ? connectors.filter((c) => c.name === source)
    : connectors;

  if (toRun.length === 0) {
    const names = getConnectorNames().join(", ");
    log.error(`Unknown source: ${source}. Available: ${names}`);
    process.exit(1);
  }

  let totalAdded = 0;
  let failed = false;
  for (const connector of toRun) {
    log.info(`Syncing ${connector.name}...`);
    try {
      const result = await connector.sync(db, config);
      totalAdded += result.messagesAdded;
      console.log(
        `${connector.name}: ${result.messagesAdded} messages, ${result.contactsAdded} new contacts`
      );
    } catch (err) {
      // Keep going so one broken source doesn't block the others; fail the run at the end.
      log.error(`Sync failed for ${connector.name}:`, err);
      failed = true;
    }
  }

  if (totalAdded > 0) {
    log.info("Embedding new messages...");
    await runEmbed(db, { limit: String(totalAdded) });
  }

  if (failed) process.exitCode = 1;
}

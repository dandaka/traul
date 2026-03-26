import type { TraulDB } from "../db/database";
import { writeJSON } from "../lib/formatter";

function formatDate(unixTs: number): string {
  return new Date(unixTs * 1000).toISOString().slice(0, 10);
}

export async function runChannels(
  db: TraulDB,
  options: {
    source?: string;
    search?: string;
    json?: boolean;
  }
): Promise<void> {
  const results = await db.getChannels({
    source: options.source,
    search: options.search,
  });

  if (results.length === 0) {
    console.log("No channels found.");
    return;
  }

  if (options.json) {
    const jsonData = results.map((ch) => ({
      source: ch.source,
      name: ch.channel_name,
      message_count: ch.msg_count,
      last_activity: new Date(ch.last_message * 1000).toISOString(),
    }));
    await writeJSON(jsonData);
  } else {
    for (const ch of results) {
      const source = ch.source.padEnd(12);
      const name = (ch.channel_name ?? "(unknown)").padEnd(30);
      const count = `${ch.msg_count} msgs`.padStart(10);
      const last = `last: ${formatDate(ch.last_message)}`;
      console.log(`${source}${name}${count}  ${last}`);
    }
  }
}

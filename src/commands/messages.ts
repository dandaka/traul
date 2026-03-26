import type { TraulDB } from "../db/database";
import { writeJSON } from "../lib/formatter";

function formatTimestamp(unixTs: number): string {
  return new Date(unixTs * 1000).toISOString().replace("T", " ").slice(0, 16);
}

export async function runMessages(
  db: TraulDB,
  channel: string | undefined,
  options: {
    channel?: string;
    author?: string;
    source?: string;
    after?: string;
    before?: string;
    limit?: string;
    json?: boolean;
    asc?: boolean;
  }
): Promise<void> {
  const limit = options.limit ? parseInt(options.limit, 10) : 50;
  const after = options.after
    ? Math.floor(new Date(options.after).getTime() / 1000)
    : undefined;
  const before = options.before
    ? Math.floor(new Date(options.before).getTime() / 1000)
    : undefined;

  const results = await db.getMessages({
    channel: channel,
    channelLike: options.channel,
    author: options.author,
    source: options.source,
    after,
    before,
    limit,
    asc: options.asc,
  });

  if (results.length === 0) {
    console.log("No messages found.");
    return;
  }

  if (options.json) {
    const jsonData = results.map((msg) => ({
      sent_at: new Date(msg.sent_at * 1000).toISOString(),
      author: msg.author_name,
      content: msg.content,
      channel: msg.channel_name,
      source: msg.source,
    }));
    await writeJSON(jsonData);
  } else {
    for (const msg of results) {
      const time = formatTimestamp(msg.sent_at);
      const author = msg.author_name ?? "unknown";
      console.log(`${time}  ${author}`);
      console.log(msg.content);
      console.log();
    }
  }
}

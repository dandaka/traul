import type { TraulDB, MessageRow } from "../db/database";
import { writeJSON } from "../lib/formatter";

function formatTimestamp(unixTs: number): string {
  return new Date(unixTs * 1000).toISOString().replace("T", " ").slice(0, 19);
}

export async function runGet(
  db: TraulDB,
  threadId: string | undefined,
  options: { date?: string; json?: boolean }
): Promise<void> {
  let messages: MessageRow[];

  if (options.date) {
    const dayStart = Math.floor(new Date(options.date).getTime() / 1000);
    const dayEnd = dayStart + 86400;
    messages = db.getThreadsByDate(dayStart, dayEnd);
  } else if (threadId) {
    messages = db.getThread(threadId);
  } else {
    console.error("Usage: traul get <thread-id> or traul get --date 2026-03-10");
    process.exit(1);
  }

  if (messages.length === 0) {
    if (options.json) {
      console.log("[]");
    } else {
      console.log("No messages found.");
    }
    return;
  }

  if (options.json) {
    const jsonData = messages.map((msg) => ({
      sent_at: new Date(msg.sent_at * 1000).toISOString(),
      author: msg.author_name,
      content: msg.content,
      channel: msg.channel_name,
      source: msg.source,
      thread_id: msg.thread_id,
    }));
    await writeJSON(jsonData);
  } else {
    for (const msg of messages) {
      const time = formatTimestamp(msg.sent_at);
      const author = msg.author_name ?? "unknown";
      console.log(`${time}  ${author}:`);
      console.log(msg.content);
      console.log();
    }
  }
}

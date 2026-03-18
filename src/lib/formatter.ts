import type { MessageRow, Stats } from "../db/database";

function formatTimestamp(unixTs: number): string {
  return new Date(unixTs * 1000).toISOString().replace("T", " ").slice(0, 19);
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + "...";
}

export function formatMessage(msg: MessageRow): string {
  const time = formatTimestamp(msg.sent_at);
  const channel = msg.channel_name ? `#${msg.channel_name}` : msg.source;
  const author = msg.author_name ?? "unknown";
  const thread = msg.thread_id ? `  [thread:${msg.thread_id.slice(0, 12)}]` : "";
  const content = truncate(msg.content.replace(/\n/g, " "), 120);
  return `${time}  ${channel}  ${author}${thread}: ${content}`;
}

export function formatStats(stats: Stats): string {
  return [
    `Messages: ${stats.total_messages}`,
    `Channels: ${stats.total_channels}`,
    `Contacts: ${stats.total_contacts}`,
  ].join("\n");
}

function sanitizeContent(content: string, maxLen: number = 500): string {
  // Strip null bytes and control characters (keep newlines/tabs)
  const clean = content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen) + "...";
}

export function writeJSON(data: unknown): Promise<void> {
  // Sanitize message content to prevent JSON parse issues with piped output
  // No length truncation — JSON consumers expect full data
  if (Array.isArray(data)) {
    data = data.map((item: Record<string, unknown>) => {
      if (item && typeof item === "object" && typeof item.content === "string") {
        return { ...item, content: sanitizeContent(item.content, Infinity) };
      }
      return item;
    });
  }
  const json = JSON.stringify(data, null, 2) + "\n";
  return new Promise<void>((resolve, reject) => {
    const ok = process.stdout.write(json);
    if (ok) {
      resolve();
    } else {
      process.stdout.once("drain", resolve);
      process.stdout.once("error", reject);
    }
  });
}


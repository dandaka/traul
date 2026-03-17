import { join } from "path";
import type { Connector, SyncResult } from "./types";
import type { TraulDB } from "../db/database";
import { type TraulConfig, getSyncStartTimestamp } from "../lib/config";
import * as log from "../lib/logger";

const TG_SCRIPT = join(import.meta.dir, "..", "..", "scripts", "tg_sync.py");

/** Default subprocess timeout: 5 minutes */
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export class SubprocessTimeoutError extends Error {
  constructor(command: string, timeoutMs: number) {
    super(
      `Telegram subprocess timed out after ${Math.round(timeoutMs / 1000)}s: ${command}`
    );
    this.name = "SubprocessTimeoutError";
  }
}

interface TgMessage {
  id: number;
  sender: string;
  text: string;
  date: string | null;
  chat_id?: number;
  reactions?: Array<{ emoji: string; count: number }>;
}

interface TgChat {
  name: string;
  id: number;
  type: string;
  unread: number;
  last_message_date: string | null;
}

interface BulkChatSpec {
  chat_id: string;
  chat_name: string;
  min_id: number;
  limit: number;
  offset_date?: string;
}

interface BulkChatResult {
  chat_id: string;
  chat_name?: string;
  error?: string;
  messages: TgMessage[];
}

export async function runTg(
  args: string[],
  stdin?: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<string> {
  const proc = Bun.spawn(["python3", TG_SCRIPT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: stdin ? new Blob([stdin]) : undefined,
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  // Stream stderr to log for progress visibility
  const stderrPromise = (async () => {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let fullStderr = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      fullStderr += chunk;
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) log.info(`  tg: ${line.trim()}`);
      }
    }
    if (buf.trim()) log.info(`  tg: ${buf.trim()}`);
    return fullStderr;
  })();

  const stdout = await new Response(proc.stdout).text();
  const stderr = await stderrPromise;
  const exitCode = await proc.exited;
  clearTimeout(timer);

  if (timedOut) {
    throw new SubprocessTimeoutError(`tg.py ${args[0]}`, timeoutMs);
  }
  if (exitCode !== 0) {
    throw new Error(`tg.py ${args[0]} failed (exit ${exitCode}): ${stderr}`);
  }
  return stdout.trim();
}

async function listChats(limit: number = 10000, since?: string): Promise<TgChat[]> {
  const args = ["list", "--limit", String(limit), "--json"];
  if (since) args.push("--since", since);
  const raw = await runTg(args);
  if (!raw) return [];
  return JSON.parse(raw);
}

export const telegramConnector: Connector = {
  defaultInterval: 300,
  hasCredentials: (config) => !!config.telegram.api_id && !!config.telegram.api_hash,
  name: "telegram",

  async sync(db: TraulDB, config: TraulConfig): Promise<SyncResult> {
    // Verify tg.py is accessible
    try {
      await runTg(["status"]);
    } catch {
      throw new Error(
        `Telegram not configured. Run: python3 ${TG_SCRIPT} setup`
      );
    }

    const result: SyncResult = {
      messagesAdded: 0,
      messagesUpdated: 0,
      contactsAdded: 0,
    };

    const syncStartTs = getSyncStartTimestamp(config);

    // Determine which chats to sync
    let chatsToSync: Array<{ name: string; id: string; lastMessageDate: string | null }> = [];

    if (config.telegram.chats.length > 0) {
      chatsToSync = config.telegram.chats.map((c) => ({
        name: c,
        id: c,
        lastMessageDate: null,
      }));
    } else {
      log.info("  Listing all Telegram chats...");
      const lastGlobalSync = db.getSyncCursor("telegram", "last_sync");
      const since = lastGlobalSync
        ? new Date(parseInt(lastGlobalSync)).toISOString()
        : undefined;
      const allChats = await listChats(10000, since);
      chatsToSync = allChats.map((c) => ({
        name: c.name,
        id: String(c.id),
        lastMessageDate: c.last_message_date,
      }));
    }

    log.info(`  Found ${chatsToSync.length} chats`);

    // Build bulk request — filter out recently synced chats
    const bulkSpecs: BulkChatSpec[] = [];
    const skipped: string[] = [];

    for (const chat of chatsToSync) {
      // Skip chats where last message is older than our last sync
      const lastSyncKey = `synced_at:${chat.id}`;
      const lastSyncValue = db.getSyncCursor("telegram", lastSyncKey);
      if (lastSyncValue && chat.lastMessageDate) {
        const lastSyncMs = parseInt(lastSyncValue);
        const lastMsgMs = new Date(chat.lastMessageDate).getTime();
        if (lastMsgMs < lastSyncMs) {
          skipped.push(chat.name);
          continue;
        }
      }

      // Get last known message ID for this chat to use as min_id
      const cursorKey = `msg_id:${chat.id}`;
      const lastMsgId = db.getSyncCursor("telegram", cursorKey);
      let minId = lastMsgId ? parseInt(lastMsgId) : 0;

      // Calculate offset_date: use sync_start if it's earlier than cursor (backfill)
      let offsetDate: string | undefined;
      const cursorDateKey = `chat:${chat.id}`;
      const cursorValue = db.getSyncCursor("telegram", cursorDateKey);

      if (minId === 0) {
        const referenceTs = cursorValue
          ? Math.floor(new Date(cursorValue).getTime() / 1000)
          : syncStartTs !== "0" ? parseInt(syncStartTs)
          : Math.floor((Date.now() - 30 * 86400_000) / 1000);

        offsetDate = new Date(referenceTs * 1000).toISOString();
      } else if (cursorValue && syncStartTs !== "0") {
        // Backfill: if sync_start is earlier than existing cursor, reset to re-fetch from sync_start
        const cursorSec = Math.floor(new Date(cursorValue).getTime() / 1000);
        if (parseInt(syncStartTs) < cursorSec) {
          minId = 0;
          offsetDate = new Date(parseInt(syncStartTs) * 1000).toISOString();
        }
      }

      bulkSpecs.push({
        chat_id: chat.id,
        chat_name: chat.name,
        min_id: minId,
        limit: 500,
        ...(offsetDate ? { offset_date: offsetDate } : {}),
      });
    }

    if (skipped.length > 0) {
      log.info(`  Skipped ${skipped.length} recently synced chats`);
    }

    if (bulkSpecs.length === 0) {
      log.info("  No chats to sync");
      return result;
    }

    // Map resolved chat IDs back to spec IDs for consistent cursor keys
    const specIdByName = new Map<string, string>();
    for (const spec of bulkSpecs) {
      specIdByName.set(spec.chat_name, spec.chat_id);
    }

    log.info(`  Fetching ${bulkSpecs.length} chats in single session...`);
    const syncStart = Date.now();

    // Spawn bulk-recent process and stream JSONL — store each chat as it arrives
    const proc = Bun.spawn(["python3", TG_SCRIPT, "bulk-recent", "--limit", "500"], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: new Blob([JSON.stringify(bulkSpecs)]),
    });

    // Timeout guard for bulk subprocess
    let bulkTimedOut = false;
    const bulkTimer = setTimeout(() => {
      bulkTimedOut = true;
      proc.kill();
    }, DEFAULT_TIMEOUT_MS);

    // Stream stderr for progress
    const stderrDrain = (async () => {
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) log.info(`  tg: ${line.trim()}`);
        }
      }
      if (buf.trim()) log.info(`  tg: ${buf.trim()}`);
    })();

    // Stream stdout JSONL — process and store each chat immediately
    const contactCache = new Map<string, boolean>();
    const stdoutReader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let stdoutBuf = "";

    const processChatLine = (line: string) => {
      let chatResult: BulkChatResult;
      try {
        chatResult = JSON.parse(line);
      } catch {
        log.warn(`  Failed to parse JSONL line: ${line.slice(0, 100)}`);
        return;
      }

      if (chatResult.error) {
        log.warn(`  ${chatResult.chat_name || chatResult.chat_id}: ${chatResult.error}`);
        return;
      }

      const chatId = chatResult.chat_id;
      const chatName = chatResult.chat_name || chatId;
      const messages = chatResult.messages || [];

      let chatMsgCount = 0;
      let maxMsgId = 0;
      let latestDate = "";

      for (const msg of messages) {
        if (!msg.text) continue;

        const sentAt = msg.date
          ? Math.floor(new Date(msg.date).getTime() / 1000)
          : Math.floor(Date.now() / 1000);

        const sourceId = `${chatId}:${msg.id}`;

        if (msg.id > maxMsgId) maxMsgId = msg.id;

        if (msg.sender && !contactCache.has(msg.sender)) {
          const existing = db.getContactBySourceId("telegram", msg.sender);
          if (!existing) {
            const contactId = db.upsertContact(msg.sender);
            db.upsertContactIdentity({
              contactId,
              source: "telegram",
              sourceUserId: msg.sender,
              displayName: msg.sender,
            });
            result.contactsAdded++;
          }
          contactCache.set(msg.sender, true);
        }

        db.upsertMessage({
          source: "telegram",
          source_id: sourceId,
          channel_id: chatId,
          channel_name: chatName,
          author_id: msg.sender,
          author_name: msg.sender,
          content: msg.text,
          sent_at: sentAt,
          metadata: msg.reactions
            ? JSON.stringify({ reactions: msg.reactions })
            : undefined,
        });
        chatMsgCount++;

        if (msg.date && msg.date > latestDate) {
          latestDate = msg.date;
        }
      }

      // Update cursors using the original spec ID so lookups match on next sync
      const cursorId = specIdByName.get(chatName) ?? chatId;
      if (maxMsgId > 0) {
        db.setSyncCursor("telegram", `msg_id:${cursorId}`, String(maxMsgId));
      }
      if (latestDate) {
        db.setSyncCursor("telegram", `chat:${cursorId}`, latestDate);
      }
      db.setSyncCursor("telegram", `synced_at:${cursorId}`, String(Date.now()));

      result.messagesAdded += chatMsgCount;
      if (chatMsgCount > 0) {
        log.info(`    ${chatName}: ${chatMsgCount} messages`);
      }
    };

    while (true) {
      const { done, value } = await stdoutReader.read();
      if (done) break;
      stdoutBuf += decoder.decode(value, { stream: true });
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) processChatLine(line.trim());
      }
    }
    if (stdoutBuf.trim()) processChatLine(stdoutBuf.trim());

    await stderrDrain;
    await proc.exited;
    clearTimeout(bulkTimer);

    if (bulkTimedOut) {
      throw new SubprocessTimeoutError("tg.py bulk-recent", DEFAULT_TIMEOUT_MS);
    }

    const elapsed = Math.round((Date.now() - syncStart) / 1000);
    log.info(`  Sync completed in ${elapsed}s: ${result.messagesAdded} messages, ${result.contactsAdded} contacts`);

    // Save global sync timestamp so next run can skip old dialogs
    db.setSyncCursor("telegram", "last_sync", String(syncStart));

    return result;
  },
};

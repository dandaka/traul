import type { Connector, SyncResult } from "./types";
import type { TraulDB } from "../db/database";
import { type TraulConfig, getEffectiveSyncStart } from "../lib/config";
import * as log from "../lib/logger";

interface WahaChat {
  id: string;
  name: string;
  isGroup: boolean;
}

interface WahaMessage {
  id: string;
  body: string;
  timestamp: number;
  from: string;
  fromMe: boolean;
  hasMedia: boolean;
  mediaUrl?: string;
  ack: number;
  _data?: {
    notifyName?: string;
    type?: string;
  };
}

function getHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["X-Api-Key"] = apiKey;
  return headers;
}

function mediaPlaceholder(msg: WahaMessage): string {
  const type = msg._data?.type ?? "file";
  const typeMap: Record<string, string> = {
    image: "image",
    video: "video",
    ptt: "audio",
    audio: "audio",
    document: "document",
    sticker: "sticker",
  };
  return `[media: ${typeMap[type] ?? type}]`;
}

async function syncInstance(
  db: TraulDB,
  config: TraulConfig,
  instance: { name: string; url: string; api_key: string; session: string; chats: string[] },
  result: SyncResult,
): Promise<void> {
  const { name, url, api_key, session, chats: chatFilter } = instance;
  const headers = getHeaders(api_key);

  try {
    const statusResp = await fetch(`${url}/api/sessions/${session}`, { headers });
    if (!statusResp.ok) {
      log.warn(`  [${name}] WAHA session "${session}" not found. Run: traul whatsapp auth ${name}`);
      return;
    }
    const status = await statusResp.json() as { status: string };
    if (status.status !== "WORKING") {
      log.warn(`  [${name}] WAHA session not authenticated (status: ${status.status}). Run: traul whatsapp auth ${name}`);
      return;
    }
  } catch {
    log.warn(`  [${name}] Cannot reach WAHA at ${url}. Is it running?`);
    return;
  }

  const chatsResp = await fetch(`${url}/api/sessions/${session}/chats`, { headers });
  if (!chatsResp.ok) {
    log.warn(`  [${name}] Failed to list chats: ${chatsResp.status}`);
    return;
  }
  let allChats = await chatsResp.json() as WahaChat[];

  if (chatFilter.length > 0) {
    allChats = allChats.filter(
      (c) => chatFilter.includes(c.id) || chatFilter.some((f) => c.name?.includes(f)),
    );
  }

  log.info(`  [${name}] Syncing ${allChats.length} chats...`);

  for (const chat of allChats) {
    const chatName = chat.name || chat.id;
    const cursorKey = `${name}:chat:${chat.id}`;
    const effectiveStart = await getEffectiveSyncStart(db, config, "whatsapp", cursorKey);
    const afterTs = effectiveStart ? parseInt(effectiveStart) : 0;

    log.info(`    ${chatName}`);

    let offset = 0;
    const PAGE_SIZE = 100;
    let latestTs = afterTs;
    let chatMsgCount = 0;

    while (true) {
      const msgsResp = await fetch(
        `${url}/api/sessions/${session}/chats/${encodeURIComponent(chat.id)}/messages?limit=${PAGE_SIZE}&offset=${offset}`,
        { headers },
      );

      if (!msgsResp.ok) {
        log.warn(`    Failed to fetch messages: ${msgsResp.status}`);
        break;
      }

      const messages = await msgsResp.json() as WahaMessage[];
      if (messages.length === 0) break;

      messages.sort((a, b) => a.timestamp - b.timestamp);

      for (const msg of messages) {
        if (msg.timestamp <= afterTs) continue;

        const content = msg.body
          ? msg.body
          : msg.hasMedia
            ? mediaPlaceholder(msg)
            : "";

        if (!content) continue;

        const authorName = msg._data?.notifyName ?? (msg.fromMe ? "Me" : msg.from);

        await db.upsertMessage({
          source: "whatsapp",
          source_id: `${name}:${msg.id}`,
          channel_id: chat.id,
          channel_name: chatName,
          author_id: msg.from,
          author_name: authorName,
          content,
          sent_at: msg.timestamp,
          metadata: JSON.stringify({
            fromMe: msg.fromMe,
            hasMedia: msg.hasMedia,
            ack: msg.ack,
          }),
        });
        chatMsgCount++;

        if (msg.timestamp > latestTs) {
          latestTs = msg.timestamp;
        }

        if (!msg.fromMe) {
          const existing = await db.getContactBySourceId("whatsapp", msg.from);
          if (!existing) {
            const contactId = await db.upsertContact(authorName);
            await db.upsertContactIdentity({
              contactId,
              source: "whatsapp",
              sourceUserId: msg.from,
              username: msg.from,
              displayName: authorName,
            });
            result.contactsAdded++;
          }
        }
      }

      if (messages.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    if (latestTs > afterTs) {
      await db.setSyncCursor("whatsapp", cursorKey, String(latestTs));
    }

    result.messagesAdded += chatMsgCount;
    if (chatMsgCount > 0) {
      log.info(`      ${chatMsgCount} messages`);
    }
  }
}

export const whatsappConnector: Connector = {
  defaultInterval: 300,
  hasCredentials: (config) => config.whatsapp.instances.length > 0,
  name: "whatsapp",

  async sync(db: TraulDB, config: TraulConfig): Promise<SyncResult> {
    const result: SyncResult = { messagesAdded: 0, messagesUpdated: 0, contactsAdded: 0 };

    if (config.whatsapp.instances.length === 0) {
      log.warn("No WhatsApp instances configured.");
      log.warn("Add whatsapp.instances to ~/.config/traul/config.json");
      return result;
    }

    log.info(`Syncing ${config.whatsapp.instances.length} WhatsApp instance(s)...`);
    for (const instance of config.whatsapp.instances) {
      await syncInstance(db, config, instance, result);
    }

    return result;
  },
};

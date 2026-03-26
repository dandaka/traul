import { google, type gmail_v1 } from "googleapis";
import { htmlToText } from "html-to-text";
import type { Connector, SyncResult } from "./types";
import type { TraulDB } from "../db/database";
import { type TraulConfig, getSyncStartTimestamp } from "../lib/config";
import * as log from "../lib/logger";

function getAuthClient(config: TraulConfig) {
  if (!config.gmail.client_id || !config.gmail.client_secret || !config.gmail.refresh_token) {
    return null;
  }

  const oauth2Client = new google.auth.OAuth2(
    config.gmail.client_id,
    config.gmail.client_secret,
  );
  oauth2Client.setCredentials({ refresh_token: config.gmail.refresh_token });
  return oauth2Client;
}

function decodeBody(part: gmail_v1.Schema$MessagePart): string {
  if (part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf-8");
  }
  return "";
}

const HTML_TO_TEXT_OPTIONS: Parameters<typeof htmlToText>[1] = {
  wordwrap: false,
  selectors: [
    { selector: "img", format: "skip" },
    { selector: "a", options: { ignoreHref: true } },
  ],
};

function extractBody(payload: gmail_v1.Schema$MessagePart): string {
  if (payload.mimeType === "text/plain") {
    return decodeBody(payload);
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain") {
        return decodeBody(part);
      }
    }
    for (const part of payload.parts) {
      if (part.mimeType === "text/html") {
        return htmlToText(decodeBody(part), HTML_TO_TEXT_OPTIONS);
      }
    }
    for (const part of payload.parts) {
      if (part.mimeType?.startsWith("multipart/")) {
        const result = extractBody(part);
        if (result) return result;
      }
    }
  }

  if (payload.mimeType === "text/html") {
    return htmlToText(decodeBody(payload), HTML_TO_TEXT_OPTIONS);
  }

  return "";
}

function getHeader(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function parseEmailAddress(from: string): { name: string; email: string } {
  const match = from.match(/^(.+?)\s*<(.+?)>$/);
  if (match) {
    return { name: match[1].replace(/^"|"$/g, "").trim(), email: match[2] };
  }
  return { name: from, email: from };
}

function truncateSubject(subject: string, maxLen = 200): string {
  if (!subject) return "(no subject)";
  return subject.length > maxLen ? subject.slice(0, maxLen) + "..." : subject;
}

async function syncAccount(
  db: TraulDB,
  config: TraulConfig,
  accountName: string,
  labels: string[],
  result: SyncResult,
): Promise<void> {
  const auth = getAuthClient(config);
  if (!auth) {
    log.warn(`Gmail not authenticated. Set GMAIL_CREDS_JSON env var.`);
    return;
  }

  const gmail = google.gmail({ version: "v1", auth });
  const cursorKey = `${accountName}:all`;
  const existingCursor = await db.getSyncCursor("gmail", cursorKey);
  const syncStartTs = getSyncStartTimestamp(config, "gmail");

  // Gmail cursor is stored in ms; sync_start is in seconds. Compare in seconds.
  let afterEpochMs: number | undefined;
  if (existingCursor) {
    const cursorSec = Math.floor(parseInt(existingCursor) / 1000);
    const syncStartSec = syncStartTs !== "0" ? parseInt(syncStartTs) : undefined;
    if (syncStartSec && syncStartSec < cursorSec) {
      // Config sync_start moved earlier — backfill
      afterEpochMs = syncStartSec * 1000;
    } else {
      afterEpochMs = parseInt(existingCursor);
    }
  } else {
    afterEpochMs = syncStartTs !== "0" ? parseInt(syncStartTs) * 1000 : undefined;
  }

  let query = "";
  if (afterEpochMs) {
    const afterSecs = Math.floor(afterEpochMs / 1000);
    query = `after:${afterSecs}`;
  }
  if (labels.length > 0) {
    query += " " + labels.map((l) => `label:${l}`).join(" ");
  }
  query = query.trim();

  log.info(`  [${accountName}] query: "${query || "(all)"}"`);

  let pageToken: string | undefined;
  let latestInternalDate = afterEpochMs ?? 0;
  let msgCount = 0;
  const contactCache = new Map<string, boolean>();

  do {
    const listResp = await gmail.users.messages.list({
      userId: "me",
      q: query || undefined,
      maxResults: 100,
      pageToken,
    });

    const messageIds = listResp.data.messages ?? [];
    if (messageIds.length === 0) break;

    const CONCURRENCY = 20;
    for (let i = 0; i < messageIds.length; i += CONCURRENCY) {
      const batch = messageIds.slice(i, i + CONCURRENCY);
      const messages = await Promise.all(
        batch.map((m) =>
          gmail.users.messages.get({
            userId: "me",
            id: m.id!,
            format: "full",
          }).then((r) => r.data)
        ),
      );

      for (const msg of messages) {
        if (!msg.id || !msg.payload) continue;

        const headers = msg.payload.headers;
        const subject = getHeader(headers, "Subject");
        const from = getHeader(headers, "From");
        const to = getHeader(headers, "To");
        const cc = getHeader(headers, "Cc");
        const internalDate = parseInt(msg.internalDate ?? "0");

        const body = extractBody(msg.payload);
        if (!body.trim()) continue;

        const fromParsed = parseEmailAddress(from);
        const threadId = msg.threadId ?? msg.id;

        await db.upsertMessage({
          source: "gmail",
          source_id: `${accountName}:${msg.id}`,
          channel_id: `${accountName}:${threadId}`,
          channel_name: truncateSubject(subject),
          thread_id: threadId,
          author_id: fromParsed.email,
          author_name: fromParsed.name,
          content: body,
          sent_at: Math.floor(internalDate / 1000),
          metadata: JSON.stringify({
            labels: msg.labelIds,
            snippet: msg.snippet,
            to,
            cc,
          }),
        });
        msgCount++;

        const addresses = [from, ...to.split(","), ...cc.split(",")]
          .map((a) => a.trim())
          .filter(Boolean);

        for (const addr of addresses) {
          const parsed = parseEmailAddress(addr);
          if (contactCache.has(parsed.email)) continue;
          contactCache.set(parsed.email, true);

          const existing = await db.getContactBySourceId("gmail", parsed.email);
          if (!existing) {
            const contactId = await db.upsertContact(parsed.name || parsed.email);
            await db.upsertContactIdentity({
              contactId,
              source: "gmail",
              sourceUserId: parsed.email,
              username: parsed.email,
              displayName: parsed.name || parsed.email,
            });
            result.contactsAdded++;
          }
        }

        if (internalDate > latestInternalDate) {
          latestInternalDate = internalDate;
        }
      }
    }

    pageToken = listResp.data.nextPageToken ?? undefined;
  } while (pageToken);

  if (latestInternalDate > (afterEpochMs ?? 0)) {
    await db.setSyncCursor("gmail", cursorKey, String(latestInternalDate));
  }

  result.messagesAdded += msgCount;
  log.info(`  [${accountName}] ${msgCount} messages`);
}

export const gmailConnector: Connector = {
  defaultInterval: 600,
  hasCredentials: (config) => !!config.gmail.client_id && !!config.gmail.client_secret && !!config.gmail.refresh_token,
  name: "gmail",

  async sync(db: TraulDB, config: TraulConfig): Promise<SyncResult> {
    const result: SyncResult = { messagesAdded: 0, messagesUpdated: 0, contactsAdded: 0 };

    if (!config.gmail.client_id || !config.gmail.client_secret || !config.gmail.refresh_token) {
      log.warn("Gmail not configured.");
      log.warn("Set GMAIL_CREDS_JSON env var with {client_id, client_secret, refresh_token}");
      return result;
    }

    let accounts = config.gmail.accounts;
    if (accounts.length === 0) {
      accounts = [{ name: "default", labels: [] }];
    }

    log.info(`Syncing ${accounts.length} Gmail account(s)...`);
    for (const account of accounts) {
      await syncAccount(db, config, account.name, account.labels, result);
    }

    return result;
  },
};

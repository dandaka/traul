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

/** Minimal Gmail surface used by the sync, so tests can supply a fake. */
export interface GmailApi {
  getProfile(): Promise<{ historyId?: string | null }>;
  listMessages(q: string | undefined, pageToken: string | undefined, maxResults: number): Promise<gmail_v1.Schema$ListMessagesResponse>;
  listHistory(startHistoryId: string, pageToken: string | undefined): Promise<gmail_v1.Schema$ListHistoryResponse>;
  getMessage(id: string): Promise<gmail_v1.Schema$Message>;
}

export function createGmailApi(config: TraulConfig): GmailApi | null {
  const auth = getAuthClient(config);
  if (!auth) return null;
  // retry: false — gaxios retries 429s by default, and every retry during a
  // Google user-rate lockout restarts the lockout window.
  const gmail = google.gmail({ version: "v1", auth, retry: false });
  return {
    getProfile: () => gmail.users.getProfile({ userId: "me" }).then((r) => r.data),
    listMessages: (q, pageToken, maxResults) =>
      gmail.users.messages.list({ userId: "me", q, pageToken, maxResults }).then((r) => r.data),
    listHistory: (startHistoryId, pageToken) =>
      gmail.users.history
        .list({ userId: "me", startHistoryId, historyTypes: ["messageAdded"], maxResults: 500, pageToken })
        .then((r) => r.data),
    getMessage: (id) => gmail.users.messages.get({ userId: "me", id, format: "full" }).then((r) => r.data),
  };
}

// Shared by every account: they all use the same OAuth client and per-user quota.
export const RATE_LIMIT_KEY = "rate_limited_until";
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000;
const RETRY_AFTER_MARGIN_MS = 5 * 1000;
// ~10 requests/s ≈ 50 quota units/s, about a fifth of Gmail's per-user limit.
const DEFAULT_REQUEST_INTERVAL_MS = 100;
const DEFAULT_MAX_MESSAGES_PER_RUN = 500;
const LIST_PAGE_SIZE = 500;

export interface GmailSyncOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  requestIntervalMs?: number;
  maxMessagesPerRun?: number;
}

function errorStatus(err: any): number | undefined {
  return err?.status ?? err?.response?.status ?? (typeof err?.code === "number" ? err.code : undefined);
}

function errorMessage(err: any): string {
  return String(err?.message ?? err ?? "");
}

export function isRateLimitError(err: unknown): boolean {
  const status = errorStatus(err);
  if (status === 429) return true;
  return status === 403 && /rate limit|quota/i.test(errorMessage(err));
}

/** When Gmail may be called again (ms epoch), from Google's "Retry after <ISO>" text or a default backoff. */
export function parseRetryAfter(err: unknown, now: number): number {
  const match = errorMessage(err).match(/Retry after (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/i);
  if (match) {
    const ts = Date.parse(match[1]);
    if (!isNaN(ts)) return Math.max(ts + RETRY_AFTER_MARGIN_MS, now);
  }
  return now + DEFAULT_RATE_LIMIT_BACKOFF_MS;
}

interface ScanState {
  query: string;
  pageToken?: string;
  done?: boolean;
}

class AccountSync {
  private lastRequestAt = -Infinity;
  private budget: number;
  latestInternalDate = 0;
  msgCount = 0;
  private contactCache = new Map<string, boolean>();

  constructor(
    private db: TraulDB,
    private api: GmailApi,
    private accountName: string,
    private result: SyncResult,
    private opts: Required<GmailSyncOptions>,
  ) {
    this.budget = opts.maxMessagesPerRun;
  }

  private async pace(): Promise<void> {
    const wait = this.lastRequestAt + this.opts.requestIntervalMs - this.opts.now();
    if (wait > 0) await this.opts.sleep(wait);
    this.lastRequestAt = this.opts.now();
  }

  get budgetLeft(): boolean {
    return this.budget > 0;
  }

  key(name: string): string {
    return `${this.accountName}:${name}`;
  }

  async call<T>(fn: () => Promise<T>): Promise<T> {
    await this.pace();
    return fn();
  }

  /** Fetch and store one message unless we already have it. Returns false when out of budget. */
  async ingest(id: string): Promise<boolean> {
    if (this.db.hasMessage("gmail", `${this.accountName}:${id}`)) return true;
    if (this.budget <= 0) return false;
    this.budget--;
    let msg: gmail_v1.Schema$Message;
    try {
      msg = await this.call(() => this.api.getMessage(id));
    } catch (err) {
      // Deleted since it was listed (e.g. a draft that got sent); history still reports it.
      if (errorStatus(err) === 404) return true;
      throw err;
    }
    this.store(msg);
    return true;
  }

  private store(msg: gmail_v1.Schema$Message): void {
    if (!msg.id || !msg.payload) return;
    const { db, accountName, result } = this;

    const headers = msg.payload.headers;
    const subject = getHeader(headers, "Subject");
    const from = getHeader(headers, "From");
    const to = getHeader(headers, "To");
    const cc = getHeader(headers, "Cc");
    const internalDate = parseInt(msg.internalDate ?? "0");
    if (internalDate > this.latestInternalDate) this.latestInternalDate = internalDate;

    const body = extractBody(msg.payload);
    if (!body.trim()) return;

    const fromParsed = parseEmailAddress(from);
    const threadId = msg.threadId ?? msg.id;

    db.upsertMessage({
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
    this.msgCount++;

    const addresses = [from, ...to.split(","), ...cc.split(",")]
      .map((a) => a.trim())
      .filter(Boolean);

    for (const addr of addresses) {
      const parsed = parseEmailAddress(addr);
      if (this.contactCache.has(parsed.email)) continue;
      this.contactCache.set(parsed.email, true);

      const existing = db.getContactBySourceId("gmail", parsed.email);
      if (!existing) {
        const contactId = db.upsertContact(parsed.name || parsed.email);
        db.upsertContactIdentity({
          contactId,
          source: "gmail",
          sourceUserId: parsed.email,
          username: parsed.email,
          displayName: parsed.name || parsed.email,
        });
        result.contactsAdded++;
      }
    }
  }

  /**
   * Page through a messages.list query, saving the page token after each
   * completed page so an interrupted scan resumes where it stopped.
   * Returns true once the whole query has been scanned.
   */
  async scan(stateName: string, query: string): Promise<boolean> {
    const key = this.key(stateName);
    const raw = this.db.getSyncCursor("gmail", key);
    let state: ScanState = { query };
    if (raw) {
      try {
        const saved = JSON.parse(raw) as ScanState;
        if (saved.query === query) state = saved;
      } catch {}
    }
    if (state.done) return true;

    if (state.pageToken) log.info(`  [${this.accountName}] resuming ${stateName} scan: "${query || "(all)"}"`);
    else log.info(`  [${this.accountName}] ${stateName} scan: "${query || "(all)"}"`);

    while (true) {
      let resp: gmail_v1.Schema$ListMessagesResponse;
      try {
        resp = await this.call(() => this.api.listMessages(query || undefined, state.pageToken, LIST_PAGE_SIZE));
      } catch (err) {
        // A stale page token is a 400; start the scan over (already-stored messages are skipped).
        if (state.pageToken && errorStatus(err) === 400) {
          log.warn(`  [${this.accountName}] saved page token rejected; restarting ${stateName} scan`);
          state = { query };
          this.db.setSyncCursor("gmail", key, JSON.stringify(state));
          continue;
        }
        throw err;
      }

      for (const m of resp.messages ?? []) {
        if (!m.id) continue;
        // Out of budget: keep the current page token so this page is re-listed next run.
        if (!(await this.ingest(m.id))) return false;
      }

      if (!resp.nextPageToken) {
        this.db.setSyncCursor("gmail", key, JSON.stringify({ query, done: true }));
        return true;
      }
      state = { query, pageToken: resp.nextPageToken };
      this.db.setSyncCursor("gmail", key, JSON.stringify(state));
    }
  }

  /**
   * Pull messages added since the saved historyId. Returns false if the
   * historyId has expired (Gmail answers 404) and a rescan is needed.
   */
  async history(startHistoryId: string): Promise<boolean> {
    let pageToken: string | undefined;
    let latestHistoryId = startHistoryId;
    const ids: string[] = [];
    do {
      let resp: gmail_v1.Schema$ListHistoryResponse;
      try {
        resp = await this.call(() => this.api.listHistory(startHistoryId, pageToken));
      } catch (err) {
        if (errorStatus(err) === 404) return false;
        throw err;
      }
      for (const h of resp.history ?? []) {
        for (const added of h.messagesAdded ?? []) {
          if (added.message?.id) ids.push(added.message.id);
        }
      }
      if (resp.historyId) latestHistoryId = resp.historyId;
      pageToken = resp.nextPageToken ?? undefined;
    } while (pageToken);

    for (const id of ids) {
      // Out of budget: leave the historyId alone so the rest is picked up next run.
      if (!(await this.ingest(id))) return true;
    }
    this.db.setSyncCursor("gmail", this.key("history_id"), latestHistoryId);
    return true;
  }
}

async function syncAccount(
  db: TraulDB,
  config: TraulConfig,
  api: GmailApi,
  accountName: string,
  labels: string[],
  result: SyncResult,
  opts: Required<GmailSyncOptions>,
): Promise<void> {
  const sync = new AccountSync(db, api, accountName, result, opts);
  const labelQuery = labels.map((l) => `label:${l}`).join(" ");
  const syncStartTs = getSyncStartTimestamp(config, "gmail");
  const backfillQuery = [syncStartTs !== "0" ? `after:${syncStartTs}` : "", labelQuery].filter(Boolean).join(" ");
  const lastDateKey = sync.key("all");
  const lastDate = parseInt(db.getSyncCursor("gmail", lastDateKey) ?? "0");

  try {
    if (labels.length === 0) {
      // New mail: history.list from the saved historyId.
      const historyKey = sync.key("history_id");
      const historyId = db.getSyncCursor("gmail", historyKey);
      if (historyId) {
        log.info(`  [${accountName}] history since ${historyId}`);
        if (!(await sync.history(historyId))) {
          log.warn(`  [${accountName}] historyId expired; rescanning (stored messages are skipped)`);
          db.deleteSyncCursor("gmail", historyKey);
          db.deleteSyncCursor("gmail", sync.key("backfill"));
        }
      }
      if (!db.getSyncCursor("gmail", historyKey)) {
        // Take the historyId before scanning so anything arriving mid-backfill is caught by history.
        const profile = await sync.call(() => api.getProfile());
        if (profile.historyId) db.setSyncCursor("gmail", historyKey, profile.historyId);
      }
    } else if (lastDate > 0) {
      // history.list can't filter by label name, so labelled accounts scan forward by date.
      const forwardQuery = `after:${Math.floor(lastDate / 1000) - 1} ${labelQuery}`;
      if (sync.budgetLeft) await sync.scan("forward", forwardQuery);
    }

    // Older mail: resumable, budgeted backfill from sync_start.
    if (sync.budgetLeft) {
      const done = await sync.scan("backfill", backfillQuery);
      if (done) log.info(`  [${accountName}] backfill complete`);
      else log.info(`  [${accountName}] backfill paused (per-run budget used); resumes next run`);
    }
  } finally {
    if (sync.latestInternalDate > lastDate) {
      db.setSyncCursor("gmail", lastDateKey, String(sync.latestInternalDate));
    }
    result.messagesAdded += sync.msgCount;
    log.info(`  [${accountName}] ${sync.msgCount} messages`);
  }
}

/** Sync all configured accounts. Rate-limit errors are recorded and swallowed so other sources keep syncing. */
export async function syncGmail(
  db: TraulDB,
  config: TraulConfig,
  api: GmailApi,
  options: GmailSyncOptions = {},
): Promise<SyncResult> {
  const result: SyncResult = { messagesAdded: 0, messagesUpdated: 0, contactsAdded: 0 };
  const opts: Required<GmailSyncOptions> = {
    now: options.now ?? Date.now,
    sleep: options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    requestIntervalMs: options.requestIntervalMs ?? config.gmail.request_interval_ms ?? DEFAULT_REQUEST_INTERVAL_MS,
    maxMessagesPerRun: options.maxMessagesPerRun ?? config.gmail.max_messages_per_run ?? DEFAULT_MAX_MESSAGES_PER_RUN,
  };

  const blockedUntil = parseInt(db.getSyncCursor("gmail", RATE_LIMIT_KEY) ?? "0");
  if (blockedUntil > opts.now()) {
    log.warn(`Gmail rate-limited until ${new Date(blockedUntil).toISOString()}; skipping (no requests sent).`);
    return result;
  }

  let accounts = config.gmail.accounts;
  if (accounts.length === 0) {
    accounts = [{ name: "default", labels: [] }];
  }

  log.info(`Syncing ${accounts.length} Gmail account(s)...`);
  try {
    for (const account of accounts) {
      await syncAccount(db, config, api, account.name, account.labels, result, opts);
    }
  } catch (err) {
    if (!isRateLimitError(err)) throw err;
    const until = parseRetryAfter(err, opts.now());
    db.setSyncCursor("gmail", RATE_LIMIT_KEY, String(until));
    log.warn(`Gmail rate limit hit (${errorStatus(err)}); pausing Gmail until ${new Date(until).toISOString()}. Progress saved.`);
  }
  return result;
}

export const gmailConnector: Connector = {
  defaultInterval: 600,
  hasCredentials: (config) => !!config.gmail.client_id && !!config.gmail.client_secret && !!config.gmail.refresh_token,
  name: "gmail",

  async sync(db: TraulDB, config: TraulConfig): Promise<SyncResult> {
    const api = createGmailApi(config);
    if (!api) {
      log.warn("Gmail not configured.");
      log.warn("Set GMAIL_CREDS_JSON env var with {client_id, client_secret, refresh_token}");
      return { messagesAdded: 0, messagesUpdated: 0, contactsAdded: 0 };
    }
    return syncGmail(db, config, api);
  },
};

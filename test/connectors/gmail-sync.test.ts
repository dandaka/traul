import { describe, it, expect, beforeEach } from "bun:test";
import type { gmail_v1 } from "googleapis";
import { TraulDB } from "../../src/db/database";
import { setRawParsedConfig, type TraulConfig } from "../../src/lib/config";
import { syncGmail, parseRetryAfter, isRateLimitError, RATE_LIMIT_KEY, type GmailApi } from "../../src/connectors/gmail";

function makeMessage(id: string, internalDate: number): gmail_v1.Schema$Message {
  return {
    id,
    threadId: `t-${id}`,
    internalDate: String(internalDate),
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "Subject", value: `Subject ${id}` },
        { name: "From", value: "Alice <alice@example.com>" },
      ],
      body: { data: Buffer.from(`body of ${id}`).toString("base64url") },
    },
  };
}

class FakeGmail implements GmailApi {
  calls: string[] = [];
  historyId = "1000";
  pages: string[][] = [];
  history: { historyId: string; ids: string[] } | null = null;
  failWith: ((call: string) => unknown) | null = null;

  private maybeFail(call: string) {
    this.calls.push(call);
    const err = this.failWith?.(call);
    if (err) throw err;
  }

  async getProfile() {
    this.maybeFail("getProfile");
    return { historyId: this.historyId };
  }

  async listMessages(_q: string | undefined, pageToken: string | undefined) {
    this.maybeFail(`list:${pageToken ?? "start"}`);
    const index = pageToken ? parseInt(pageToken.replace("p", "")) : 0;
    const ids = this.pages[index] ?? [];
    return {
      messages: ids.map((id) => ({ id })),
      nextPageToken: index + 1 < this.pages.length ? `p${index + 1}` : undefined,
    };
  }

  async listHistory(startHistoryId: string) {
    this.maybeFail(`history:${startHistoryId}`);
    const h = this.history ?? { historyId: startHistoryId, ids: [] };
    return {
      historyId: h.historyId,
      history: h.ids.map((id) => ({ messagesAdded: [{ message: { id } }] })),
    };
  }

  async getMessage(id: string) {
    this.maybeFail(`get:${id}`);
    return makeMessage(id, 1_700_000_000_000 + parseInt(id.replace(/\D/g, "") || "0") * 1000);
  }
}

function rateLimitError(retryAfter: string) {
  return Object.assign(new Error(`User-rate limit exceeded.  Retry after ${retryAfter}`), { status: 429 });
}

const noSleep = async () => {};

describe("gmail sync", () => {
  let db: TraulDB;
  let api: FakeGmail;
  const config = { sync_start: "2020-01-01", gmail: { accounts: [] } } as unknown as TraulConfig;
  setRawParsedConfig({});

  beforeEach(() => {
    db = new TraulDB(":memory:");
    api = new FakeGmail();
  });

  it("resumes a budgeted backfill from the saved page instead of restarting", async () => {
    api.pages = [["m1", "m2"], ["m3", "m4"], ["m5"]];

    const first = await syncGmail(db, config, api, { sleep: noSleep, maxMessagesPerRun: 3 });
    expect(first.messagesAdded).toBe(3);
    // Page 2 was only half done, so its token is what gets resumed.
    expect(api.calls).toEqual(["getProfile", "list:start", "get:m1", "get:m2", "list:p1", "get:m3"]);

    api.calls = [];
    const second = await syncGmail(db, config, api, { sleep: noSleep, maxMessagesPerRun: 3 });
    expect(second.messagesAdded).toBe(2);
    // No restart from page 1, and m3 is not fetched twice.
    expect(api.calls).toEqual(["history:1000", "list:p1", "get:m4", "list:p2", "get:m5"]);

    api.calls = [];
    await syncGmail(db, config, api, { sleep: noSleep });
    // Backfill is done: an idle run is a single cheap history call.
    expect(api.calls).toEqual(["history:1000"]);
  });

  it("picks up new mail via the saved historyId and advances it", async () => {
    api.pages = [["m1"]];
    await syncGmail(db, config, api, { sleep: noSleep });

    api.calls = [];
    api.history = { historyId: "1005", ids: ["m1", "m9"] };
    const result = await syncGmail(db, config, api, { sleep: noSleep });
    expect(result.messagesAdded).toBe(1);
    expect(api.calls).toEqual(["history:1000", "get:m9"]);
    expect(db.getSyncCursor("gmail", "default:history_id")).toBe("1005");
  });

  it("skips messages deleted after history reported them instead of getting stuck", async () => {
    api.pages = [["m1"]];
    await syncGmail(db, config, api, { sleep: noSleep });

    api.calls = [];
    api.history = { historyId: "1010", ids: ["m7", "m8"] };
    api.failWith = (call) => (call === "get:m7" ? Object.assign(new Error("Requested entity was not found."), { status: 404 }) : null);
    const result = await syncGmail(db, config, api, { sleep: noSleep });
    expect(result.messagesAdded).toBe(1);
    expect(api.calls).toEqual(["history:1000", "get:m7", "get:m8"]);
    expect(db.getSyncCursor("gmail", "default:history_id")).toBe("1010");
  });

  it("rescans (skipping stored messages) when the historyId has expired", async () => {
    api.pages = [["m1"]];
    await syncGmail(db, config, api, { sleep: noSleep });

    api.calls = [];
    api.historyId = "2000";
    api.pages = [["m2", "m1"]];
    api.failWith = (call) => (call.startsWith("history:") ? Object.assign(new Error("Not Found"), { status: 404 }) : null);
    const result = await syncGmail(db, config, api, { sleep: noSleep });
    expect(result.messagesAdded).toBe(1);
    expect(api.calls).toEqual(["history:1000", "getProfile", "list:start", "get:m2"]);
    expect(db.getSyncCursor("gmail", "default:history_id")).toBe("2000");
  });

  it("on 429 saves progress and Retry-After, then sends no requests until it passes", async () => {
    api.pages = [["m1", "m2", "m3"]];
    api.failWith = (call) => (call === "get:m2" ? rateLimitError("2026-10-27T16:36:01.525Z") : null);
    const t0 = Date.parse("2026-10-27T16:30:00Z");

    const first = await syncGmail(db, config, api, { sleep: noSleep, now: () => t0 });
    expect(first.messagesAdded).toBe(1);
    expect(parseInt(db.getSyncCursor("gmail", RATE_LIMIT_KEY)!)).toBe(Date.parse("2026-10-27T16:36:06.525Z"));

    // Still locked: zero requests.
    api.calls = [];
    api.failWith = null;
    const skipped = await syncGmail(db, config, api, { sleep: noSleep, now: () => t0 + 5 * 60 * 1000 });
    expect(skipped.messagesAdded).toBe(0);
    expect(api.calls).toEqual([]);

    // After the lock: resumes, m1 is not refetched.
    const resumed = await syncGmail(db, config, api, { sleep: noSleep, now: () => t0 + 10 * 60 * 1000 });
    expect(resumed.messagesAdded).toBe(2);
    expect(api.calls).toEqual(["history:1000", "list:start", "get:m2", "get:m3"]);
  });

  it("does not throw on rate limits, so other sources keep syncing", async () => {
    api.failWith = () =>
      Object.assign(new Error("Quota exceeded for quota metric 'Queries' and limit 'Units per minute per user'"), { status: 403 });
    const t0 = 1_800_000_000_000;
    await expect(syncGmail(db, config, api, { sleep: noSleep, now: () => t0 })).resolves.toBeDefined();
    // No Retry-After in the message: default backoff.
    expect(parseInt(db.getSyncCursor("gmail", RATE_LIMIT_KEY)!)).toBe(t0 + 5 * 60 * 1000);
  });

  it("still throws non-rate-limit errors", async () => {
    api.failWith = () => Object.assign(new Error("Invalid Credentials"), { status: 401 });
    await expect(syncGmail(db, config, api, { sleep: noSleep })).rejects.toThrow("Invalid Credentials");
    expect(db.getSyncCursor("gmail", RATE_LIMIT_KEY)).toBeNull();
  });

  it("spaces requests by the configured interval", async () => {
    api.pages = [["m1", "m2"]];
    let clock = 0;
    const sleeps: number[] = [];
    await syncGmail(db, config, api, {
      now: () => clock,
      sleep: async (ms) => { sleeps.push(ms); clock += ms; },
      requestIntervalMs: 250,
    });
    // getProfile, list, get, get: three gaps of 250ms after the first request.
    expect(sleeps).toEqual([250, 250, 250]);
  });
});

describe("rate limit parsing", () => {
  it("recognises 429 and quota 403s only", () => {
    expect(isRateLimitError({ status: 429, message: "x" })).toBe(true);
    expect(isRateLimitError({ response: { status: 403 }, message: "User-rate limit exceeded" })).toBe(true);
    expect(isRateLimitError({ status: 403, message: "Insufficient Permission" })).toBe(false);
  });

  it("parses Google's Retry after timestamp", () => {
    const now = Date.parse("2026-10-27T16:00:00Z");
    expect(parseRetryAfter(rateLimitError("2026-10-27T16:20:37.868Z"), now)).toBe(Date.parse("2026-10-27T16:20:42.868Z"));
    expect(parseRetryAfter(new Error("no hint"), now)).toBe(now + 5 * 60 * 1000);
  });
});

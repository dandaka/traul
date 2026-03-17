import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { TraulDB } from "../../src/db/database";
import { EMBED_DIMS } from "../../src/lib/embeddings";
import { runSearch } from "../../src/commands/search";

function fakeEmbedding(): Uint8Array {
  const vec = new Float32Array(EMBED_DIMS);
  for (let i = 0; i < EMBED_DIMS; i++) vec[i] = Math.random() - 0.5;
  return new Uint8Array(vec.buffer);
}

describe("Search command logic", () => {
  let db: TraulDB;

  beforeEach(() => {
    db = new TraulDB(":memory:");

    db.upsertMessage({
      source: "slack",
      source_id: "C1:1",
      channel_name: "engineering",
      author_name: "alice",
      content: "We need to fix the API rate limiting before launch",
      sent_at: 1700000000,
    });
    db.upsertMessage({
      source: "slack",
      source_id: "C1:2",
      channel_name: "engineering",
      author_name: "bob",
      content: "The database migration script failed on staging",
      sent_at: 1700000100,
    });
    db.upsertMessage({
      source: "slack",
      source_id: "C2:1",
      channel_name: "product",
      author_name: "carol",
      content: "Launch timeline looks good, API docs are ready",
      sent_at: 1700000200,
    });
  });

  it("searches by keyword", () => {
    const results = db.searchMessages("API");
    expect(results.length).toBe(2);
  });

  it("filters by source", () => {
    const results = db.searchMessages("API", { source: "slack" });
    expect(results.length).toBe(2);
  });

  it("filters by channel", () => {
    const results = db.searchMessages("API", { channel: "engineering" });
    expect(results.length).toBe(1);
    expect(results[0].author_name).toBe("alice");
  });

  it("filters by time range", () => {
    const results = db.searchMessages("API", {
      after: 1700000050,
    });
    // Only carol's message should match (after the cutoff)
    expect(results.length).toBe(1);
    expect(results[0].author_name).toBe("carol");
  });

  it("filters by channel substring", () => {
    db.upsertMessage({
      source: "markdown",
      source_id: "book:1",
      channel_name: "books/books",
      author_name: "The Lean Startup",
      content: "Build measure learn is the core feedback loop",
      sent_at: 1700000300,
    });

    // Exact prefix should match
    const results = db.searchMessages("feedback", { channel: "books" });
    expect(results.length).toBe(1);
    expect(results[0].channel_name).toBe("books/books");

    // Full name should also match
    const results2 = db.searchMessages("feedback", { channel: "books/books" });
    expect(results2.length).toBe(1);

    // Non-matching substring should return nothing
    const results3 = db.searchMessages("feedback", { channel: "slack" });
    expect(results3.length).toBe(0);
  });
});

describe("runSearch empty results output", () => {
  let db: TraulDB;
  let logSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    db = new TraulDB(":memory:");
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("outputs [] when --json and no results", async () => {
    await runSearch(db, "nonexistent", { json: true, fts: true });
    expect(logSpy).toHaveBeenCalledWith("[]");
  });

  it("outputs 'No results found.' when no --json and no results", async () => {
    await runSearch(db, "nonexistent", { fts: true });
    expect(logSpy).toHaveBeenCalledWith("No results found.");
  });

  it("--json empty output is valid JSON", async () => {
    await runSearch(db, "nonexistent", { json: true, fts: true });
    const output = logSpy.mock.calls[0][0] as string;
    expect(JSON.parse(output)).toEqual([]);
  });
});

describe("Hybrid search", () => {
  let db: TraulDB;

  beforeEach(() => {
    db = new TraulDB(":memory:");

    // Message 1: will be embedded
    db.upsertMessage({
      source: "slack",
      source_id: "C1:1",
      channel_name: "eng",
      author_name: "alice",
      content: "The deployment pipeline is broken again",
      sent_at: 1700000000,
    });

    // Message 2: will NOT be embedded (FTS backfill target)
    db.upsertMessage({
      source: "slack",
      source_id: "C1:2",
      channel_name: "eng",
      author_name: "bob",
      content: "The deployment script needs a rewrite",
      sent_at: 1700000100,
    });

    // Message 3: unrelated
    db.upsertMessage({
      source: "slack",
      source_id: "C1:3",
      channel_name: "random",
      author_name: "carol",
      content: "Lunch at noon?",
      sent_at: 1700000200,
    });

    // Embed only message 1
    const msg1 = db.db
      .query<{ id: number }, [string]>("SELECT id FROM messages WHERE source_id = ?")
      .get("C1:1");
    db.insertEmbedding(msg1!.id, fakeEmbedding());
  });

  it("hybridSearchAll returns vector results first, then FTS backfill", () => {
    const queryEmbedding = fakeEmbedding();
    const results = db.hybridSearchAll(queryEmbedding, "deployment", { limit: 10 });

    // Should find both deployment messages
    expect(results.length).toBe(2);

    // First result should be the embedded message (from vector search)
    expect(results[0].content).toContain("deployment pipeline");

    // Second result should be the unembedded message (from FTS backfill)
    expect(results[1].content).toContain("deployment script");
  });

  it("hybridSearchAll deduplicates results", () => {
    // Embed message 2 as well — both messages now have embeddings
    const msg2 = db.db
      .query<{ id: number }, [string]>("SELECT id FROM messages WHERE source_id = ?")
      .get("C1:2");
    db.insertEmbedding(msg2!.id, fakeEmbedding());

    const results = db.hybridSearchAll(fakeEmbedding(), "deployment", { limit: 10 });

    // Should still only have 2 results (no duplicates), and FTS backfill should find nothing
    const ids = results.map((r) => r.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it("hybridSearchAll respects limit", () => {
    const results = db.hybridSearchAll(fakeEmbedding(), "deployment", { limit: 1 });
    expect(results.length).toBe(1);
  });

  it("hybridSearchAll filters by channel", () => {
    const results = db.hybridSearchAll(fakeEmbedding(), "deployment", {
      channel: "random",
      limit: 10,
    });

    // No deployment messages in #random
    expect(results.length).toBe(0);
  });

  it("ftsSearchAll still works independently for --fts flag", () => {
    const results = db.ftsSearchAll("deployment", { limit: 10 });

    // Should find both deployment messages regardless of embedding status
    expect(results.length).toBe(2);
  });
});

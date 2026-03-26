import { describe, it, expect, beforeEach } from "bun:test";
import { TraulDB } from "../../src/db/database";
import { runReset } from "../../src/commands/reset";

describe("runReset", () => {
  let db: TraulDB;

  beforeEach(async () => {
    db = await TraulDB.create(":memory:");
    // Seed data
    await db.upsertMessage({
      source: "slack",
      source_id: "C1:1",
      channel_name: "eng",
      author_name: "bob",
      content: "hello",
      sent_at: 1700000000,
    });
    await db.upsertMessage({
      source: "markdown",
      source_id: "md:abc",
      channel_name: "notes",
      author_name: "doc",
      content: "x".repeat(3000),
      sent_at: 1700000001,
    });
    const msgs = await db.getMessages({ source: "markdown", limit: 1 });
    await db.replaceChunks(msgs[0].id, [
      { index: 0, content: "chunk 0", embeddingInput: "chunk 0" },
    ]);
    await db.setSyncCursor("slack", "channel:C1", "ts1");
    await db.setSyncCursor("markdown", "file:a.md", "hash1");
  });

  it("reset sync clears all cursors", async () => {
    await runReset(db, "sync", {});
    expect(await db.getSyncCursor("slack", "channel:C1")).toBeNull();
    expect(await db.getSyncCursor("markdown", "file:a.md")).toBeNull();
  });

  it("reset sync with --source filters by source", async () => {
    await runReset(db, "sync", { source: "markdown" });
    expect(await db.getSyncCursor("markdown", "file:a.md")).toBeNull();
    expect(await db.getSyncCursor("slack", "channel:C1")).toBe("ts1");
  });

  it("reset chunks deletes chunks and resets embeddings", async () => {
    await runReset(db, "chunks", {});
    expect((await db.getChunkEmbeddingStats()).total_chunks).toBe(0);
    expect((await db.getEmbeddingStats()).embedded_messages).toBe(0);
  });

  it("reset embed drops vec tables", async () => {
    await runReset(db, "embed", {});
    expect((await db.getEmbeddingStats()).embedded_messages).toBe(0);
  });

  it("reset all clears everything", async () => {
    await runReset(db, "all", {});
    expect(await db.getSyncCursor("slack", "channel:C1")).toBeNull();
    expect((await db.getChunkEmbeddingStats()).total_chunks).toBe(0);
    expect((await db.getEmbeddingStats()).embedded_messages).toBe(0);
  });

  it("preserves messages on all reset layers", async () => {
    await runReset(db, "all", {});
    expect((await db.getStats()).total_messages).toBe(2);
  });

  it("throws on invalid layer", async () => {
    await expect(runReset(db, "invalid", {})).rejects.toThrow("Unknown layer");
  });
});

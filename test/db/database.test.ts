import { describe, it, expect, beforeEach } from "bun:test";
import { TraulDB, sanitizeFtsQuery } from "../../src/db/database";

describe("TraulDB async", () => {
  let db: TraulDB;

  beforeEach(async () => {
    db = await TraulDB.create(":memory:");
  });

  describe("upsertMessage", () => {
    it("inserts a message", async () => {
      await db.upsertMessage({
        source: "slack",
        source_id: "C123:1234567890.123456",
        channel_name: "general",
        author_name: "alice",
        content: "Hello world",
        sent_at: 1700000000,
      });

      const stats = await db.getStats();
      expect(stats.total_messages).toBe(1);
    });

    it("deduplicates on source+source_id", async () => {
      const msg = {
        source: "slack",
        source_id: "C123:1234567890.123456",
        channel_name: "general",
        author_name: "alice",
        content: "Hello world",
        sent_at: 1700000000,
      };

      await db.upsertMessage(msg);
      await db.upsertMessage({ ...msg, content: "Updated content" });

      const stats = await db.getStats();
      expect(stats.total_messages).toBe(1);
    });
  });

  describe("FTS5 search", () => {
    it("finds messages by content", async () => {
      await db.upsertMessage({
        source: "slack",
        source_id: "C1:1",
        channel_name: "eng",
        author_name: "bob",
        content: "The deployment pipeline is broken",
        sent_at: 1700000000,
      });
      await db.upsertMessage({
        source: "slack",
        source_id: "C1:2",
        channel_name: "eng",
        author_name: "alice",
        content: "I fixed the bug in the login page",
        sent_at: 1700000001,
      });

      const results = await db.searchMessages("deployment");
      expect(results.length).toBe(1);
      expect(results[0].content).toContain("deployment");
    });

    it("finds messages by author", async () => {
      await db.upsertMessage({
        source: "slack",
        source_id: "C1:1",
        channel_name: "eng",
        author_name: "bob",
        content: "Hello",
        sent_at: 1700000000,
      });

      const results = await db.searchMessages("bob");
      expect(results.length).toBe(1);
    });

    it("filters by channel", async () => {
      await db.upsertMessage({
        source: "slack",
        source_id: "C1:1",
        channel_name: "eng",
        author_name: "bob",
        content: "deploy fix",
        sent_at: 1700000000,
      });
      await db.upsertMessage({
        source: "slack",
        source_id: "C2:1",
        channel_name: "random",
        author_name: "alice",
        content: "deploy party",
        sent_at: 1700000001,
      });

      const results = await db.searchMessages("deploy", { channel: "eng" });
      expect(results.length).toBe(1);
      expect(results[0].channel_name).toBe("eng");
    });

    it("handles special characters in queries (dots, colons, etc.)", async () => {
      await db.upsertMessage({
        source: "telegram",
        source_id: "T1:1",
        channel_name: "general",
        author_name: "dan",
        content: "Check out ask.fm for anonymous questions",
        sent_at: 1700000000,
      });

      const results = await db.searchMessages("ask.fm anonymous");
      expect(results.length).toBe(1);
      expect(results[0].content).toContain("ask.fm");
    });

    it("handles other FTS5 special chars without error", async () => {
      await db.upsertMessage({
        source: "slack",
        source_id: "C1:99",
        channel_name: "eng",
        author_name: "bob",
        content: "Use node:fs for file operations",
        sent_at: 1700000000,
      });

      await expect(db.searchMessages("node:fs")).resolves.toBeDefined();
      await expect(db.searchMessages("C++ programming")).resolves.toBeDefined();
      await expect(db.searchMessages("-flag --verbose")).resolves.toBeDefined();
      await expect(db.searchMessages("hello*world")).resolves.toBeDefined();
    });

    it("respects limit", async () => {
      for (let i = 0; i < 10; i++) {
        await db.upsertMessage({
          source: "slack",
          source_id: `C1:${i}`,
          channel_name: "eng",
          author_name: "bob",
          content: `Message about testing number ${i}`,
          sent_at: 1700000000 + i,
        });
      }

      const results = await db.searchMessages("testing", { limit: 3 });
      expect(results.length).toBe(3);
    });

    it("FTS search returns results via ftsSearchAll", async () => {
      await db.upsertMessage({
        source: "test",
        source_id: "1",
        channel_name: "general",
        content: "hello world from test",
        sent_at: 1000,
      });
      const results = await db.ftsSearchAll("hello", { limit: 10 });
      expect(results.length).toBe(1);
      expect(results[0].content).toBe("hello world from test");
    });
  });

  describe("sanitizeFtsQuery", () => {
    it("quotes simple words", () => {
      expect(sanitizeFtsQuery("hello world")).toBe('"hello" "world"');
    });

    it("escapes dots and special chars", () => {
      expect(sanitizeFtsQuery("ask.fm")).toBe('"ask.fm"');
    });

    it("escapes embedded double quotes", () => {
      expect(sanitizeFtsQuery('say "hello"')).toBe('"say" """hello"""');
    });

    it("handles empty/whitespace input", () => {
      expect(sanitizeFtsQuery("")).toBe('""');
      expect(sanitizeFtsQuery("   ")).toBe('""');
    });

    it("handles colons and operators", () => {
      expect(sanitizeFtsQuery("node:fs")).toBe('"node:fs"');
      expect(sanitizeFtsQuery("-flag")).toBe('"-flag"');
    });
  });

  describe("contacts", () => {
    it("creates and retrieves contacts", async () => {
      const contactId = await db.upsertContact("Alice");
      await db.upsertContactIdentity({
        contactId,
        source: "slack",
        sourceUserId: "U123",
        username: "alice",
        displayName: "Alice",
      });

      const found = await db.getContactBySourceId("slack", "U123");
      expect(found).not.toBeNull();
      expect(found!.display_name).toBe("Alice");
    });
  });

  describe("sync cursors", () => {
    it("stores and retrieves cursors", async () => {
      await db.setSyncCursor("slack", "channel:C123", "1700000000.000000");
      const cursor = await db.getSyncCursor("slack", "channel:C123");
      expect(cursor).toBe("1700000000.000000");
    });

    it("returns null for missing cursor", async () => {
      const cursor = await db.getSyncCursor("slack", "nonexistent");
      expect(cursor).toBeNull();
    });
  });

  describe("getUnembeddedMessages", () => {
    it("excludes messages that have chunks", async () => {
      await db.upsertMessage({
        source: "slack",
        source_id: "C1:1",
        channel_name: "eng",
        author_name: "bob",
        content: "short message",
        sent_at: 1700000000,
      });

      await db.upsertMessage({
        source: "claudecode",
        source_id: "cc:sess1:uuid1",
        channel_name: "traul",
        author_name: "claude",
        content: "x".repeat(5000),
        sent_at: 1700000001,
      });

      const msgs = await db.getMessages({ source: "claudecode", limit: 1 });
      await db.replaceChunks(msgs[0].id, [
        { index: 0, content: "chunk 0 content", embeddingInput: "chunk 0" },
        { index: 1, content: "chunk 1 content", embeddingInput: "chunk 1" },
      ]);

      const unembedded = await db.getUnembeddedMessages(100);
      expect(unembedded).toHaveLength(1);
      expect(unembedded[0].content).toBe("short message");
    });

    it("includes messages without chunks", async () => {
      await db.upsertMessage({
        source: "slack",
        source_id: "C1:1",
        channel_name: "eng",
        author_name: "bob",
        content: "message one",
        sent_at: 1700000000,
      });
      await db.upsertMessage({
        source: "slack",
        source_id: "C1:2",
        channel_name: "eng",
        author_name: "alice",
        content: "message two",
        sent_at: 1700000001,
      });

      const unembedded = await db.getUnembeddedMessages(100);
      expect(unembedded).toHaveLength(2);
    });
  });

  describe("resetSyncCursors", () => {
    it("clears all cursors for a source", async () => {
      await db.setSyncCursor("markdown", "file:a.md", "hash1");
      await db.setSyncCursor("markdown", "file:b.md", "hash2");
      await db.setSyncCursor("slack", "channel:C1", "ts1");

      await db.resetSyncCursors("markdown");

      expect(await db.getSyncCursor("markdown", "file:a.md")).toBeNull();
      expect(await db.getSyncCursor("markdown", "file:b.md")).toBeNull();
      expect(await db.getSyncCursor("slack", "channel:C1")).toBe("ts1");
    });

    it("clears all cursors when no source given", async () => {
      await db.setSyncCursor("markdown", "file:a.md", "hash1");
      await db.setSyncCursor("slack", "channel:C1", "ts1");

      await db.resetSyncCursors();

      expect(await db.getSyncCursor("markdown", "file:a.md")).toBeNull();
      expect(await db.getSyncCursor("slack", "channel:C1")).toBeNull();
    });
  });

  describe("resetChunks", () => {
    it("deletes all chunks", async () => {
      await db.upsertMessage({
        source: "markdown",
        source_id: "md:abc",
        channel_name: "notes",
        author_name: "doc",
        content: "x".repeat(3000),
        sent_at: 1700000000,
      });

      const msgs = await db.getMessages({ source: "markdown", limit: 1 });
      await db.replaceChunks(msgs[0].id, [
        { index: 0, content: "chunk 0", embeddingInput: "chunk 0" },
        { index: 1, content: "chunk 1", embeddingInput: "chunk 1" },
      ]);

      const chunksBefore = await db.getChunkEmbeddingStats();
      expect(chunksBefore.total_chunks).toBe(2);

      await db.resetChunks();

      const chunksAfter = await db.getChunkEmbeddingStats();
      expect(chunksAfter.total_chunks).toBe(0);
    });

    it("does not delete messages", async () => {
      await db.upsertMessage({
        source: "markdown",
        source_id: "md:abc",
        channel_name: "notes",
        author_name: "doc",
        content: "some content",
        sent_at: 1700000000,
      });

      await db.resetChunks();

      const stats = await db.getStats();
      expect(stats.total_messages).toBe(1);
    });
  });

  describe("meta", () => {
    it("returns null for missing key", async () => {
      expect(await db.getMeta("nonexistent")).toBeNull();
    });

    it("stores and retrieves a value", async () => {
      await db.setMeta("chunker_version", "1");
      expect(await db.getMeta("chunker_version")).toBe("1");
    });

    it("overwrites existing value", async () => {
      await db.setMeta("chunker_version", "1");
      await db.setMeta("chunker_version", "2");
      expect(await db.getMeta("chunker_version")).toBe("2");
    });
  });

  describe("stats", () => {
    it("returns correct counts", async () => {
      await db.upsertMessage({
        source: "slack",
        source_id: "C1:1",
        channel_name: "eng",
        content: "msg1",
        sent_at: 1700000000,
      });
      await db.upsertMessage({
        source: "slack",
        source_id: "C2:1",
        channel_name: "random",
        content: "msg2",
        sent_at: 1700000001,
      });
      await db.upsertContact("Alice");

      const stats = await db.getStats();
      expect(stats.total_messages).toBe(2);
      expect(stats.total_channels).toBe(2);
      expect(stats.total_contacts).toBe(1);
    });
  });

  describe("hasMessage", () => {
    it("upserts and retrieves a message", async () => {
      await db.upsertMessage({
        source: "test",
        source_id: "1",
        content: "hello world",
        sent_at: 1000,
      });
      expect(await db.hasMessage("test", "1")).toBe(true);
      expect(await db.hasMessage("test", "999")).toBe(false);
    });
  });

  describe("embedding stats", () => {
    it("reflects inserted embeddings", async () => {
      await db.upsertMessage({
        source: "test",
        source_id: "1",
        content: "embedded message",
        sent_at: 1000,
      });
      const before = await db.getEmbeddingStats();
      expect(before.embedded_messages).toBe(0);

      const msgs = await db.getMessages({ limit: 1 });
      const vec = new Float32Array(1024);
      vec[0] = 1.0;
      await db.insertEmbedding(msgs[0].id, vec);

      const after = await db.getEmbeddingStats();
      expect(after.embedded_messages).toBe(1);
    });
  });

  describe("vector search", () => {
    it("vector search with vector_top_k", async () => {
      await db.upsertMessage({
        source: "test",
        source_id: "1",
        content: "hello world",
        sent_at: 1000,
      });
      const vec = new Float32Array(1024);
      vec[0] = 1.0;
      const msgs = await db.getMessages({ limit: 1 });
      await db.insertEmbedding(msgs[0].id, vec);

      const results = await db.vectorSearch(vec, { limit: 5 });
      expect(results.length).toBe(1);
      expect(results[0].content).toBe("hello world");
    });

    it("filtered vector search by source", async () => {
      await db.upsertMessage({
        source: "slack",
        source_id: "1",
        channel_name: "general",
        content: "slack message",
        sent_at: 1000,
      });
      await db.upsertMessage({
        source: "discord",
        source_id: "2",
        channel_name: "random",
        content: "discord message",
        sent_at: 1001,
      });

      const vec = new Float32Array(1024);
      vec[0] = 1.0;
      const msgs = await db.getMessages({ limit: 10 });
      for (const m of msgs) await db.insertEmbedding(m.id, vec);

      const results = await db.vectorSearch(vec, { source: "slack", limit: 5 });
      expect(results.length).toBe(1);
      expect(results[0].source).toBe("slack");
    });
  });

  describe("deleteMessage", () => {
    it("deletes a message and its chunks", async () => {
      await db.upsertMessage({
        source: "test",
        source_id: "1",
        content: "to be deleted",
        sent_at: 1000,
      });
      const msgs = await db.getMessages({ limit: 1 });
      await db.replaceChunks(msgs[0].id, [
        { index: 0, content: "chunk", embeddingInput: "chunk" },
      ]);

      await db.deleteMessage(msgs[0].id);

      const stats = await db.getStats();
      expect(stats.total_messages).toBe(0);
      const chunkStats = await db.getChunkEmbeddingStats();
      expect(chunkStats.total_chunks).toBe(0);
    });
  });

  describe("resetEmbeddings", () => {
    it("clears all embeddings", async () => {
      await db.upsertMessage({
        source: "test",
        source_id: "1",
        content: "embedded",
        sent_at: 1000,
      });
      const msgs = await db.getMessages({ limit: 1 });
      const vec = new Float32Array(1024);
      vec[0] = 1.0;
      await db.insertEmbedding(msgs[0].id, vec);

      const before = await db.getEmbeddingStats();
      expect(before.embedded_messages).toBe(1);

      await db.resetEmbeddings();

      const after = await db.getEmbeddingStats();
      expect(after.embedded_messages).toBe(0);
    });
  });

  describe("execute", () => {
    it("runs raw SQL", async () => {
      const result = await db.execute("SELECT 1 AS val");
      expect(result.rows.length).toBe(1);
    });
  });

  describe("getChannels", () => {
    it("lists channels with counts", async () => {
      await db.upsertMessage({
        source: "slack",
        source_id: "1",
        channel_name: "general",
        content: "msg1",
        sent_at: 1000,
      });
      await db.upsertMessage({
        source: "slack",
        source_id: "2",
        channel_name: "general",
        content: "msg2",
        sent_at: 1001,
      });

      const channels = await db.getChannels();
      expect(channels.length).toBe(1);
      expect(channels[0].msg_count).toBe(2);
    });
  });
});

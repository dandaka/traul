import { describe, it, expect, beforeEach } from "bun:test";
import { TraulDB } from "../../src/db/database";

describe("getThread / getThreadsByDate", () => {
  let db: TraulDB;

  beforeEach(() => {
    db = new TraulDB(":memory:");
  });

  describe("getThread", () => {
    it("returns all messages for a thread_id ordered by sent_at", () => {
      db.upsertMessage({
        source: "claudecode",
        source_id: "cc:sess1:msg1",
        channel_name: "traul",
        thread_id: "session-uuid-123",
        author_name: "user",
        content: "First message",
        sent_at: 1700000000,
      });
      db.upsertMessage({
        source: "claudecode",
        source_id: "cc:sess1:msg2",
        channel_name: "traul",
        thread_id: "session-uuid-123",
        author_name: "claude",
        content: "Second message",
        sent_at: 1700000001,
      });
      db.upsertMessage({
        source: "claudecode",
        source_id: "cc:sess1:msg3",
        channel_name: "traul",
        thread_id: "session-uuid-123",
        author_name: "user",
        content: "Third message",
        sent_at: 1700000002,
      });

      const results = db.getThread("session-uuid-123");
      expect(results).toHaveLength(3);
      expect(results[0].content).toBe("First message");
      expect(results[1].content).toBe("Second message");
      expect(results[2].content).toBe("Third message");
    });

    it("does not return messages from other threads", () => {
      db.upsertMessage({
        source: "claudecode",
        source_id: "cc:sess1:msg1",
        thread_id: "session-aaa",
        content: "Thread A",
        sent_at: 1700000000,
      });
      db.upsertMessage({
        source: "claudecode",
        source_id: "cc:sess2:msg1",
        thread_id: "session-bbb",
        content: "Thread B",
        sent_at: 1700000001,
      });

      const results = db.getThread("session-aaa");
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe("Thread A");
    });

    it("returns empty array for non-existent thread", () => {
      const results = db.getThread("does-not-exist");
      expect(results).toHaveLength(0);
    });
  });

  describe("getThreadsByDate", () => {
    it("returns messages from threads within the date range", () => {
      const dayStart = 1700000000;
      const dayEnd = dayStart + 86400;

      db.upsertMessage({
        source: "claudecode",
        source_id: "cc:sess1:msg1",
        thread_id: "session-today",
        author_name: "user",
        content: "Today's message",
        sent_at: dayStart + 100,
      });
      db.upsertMessage({
        source: "claudecode",
        source_id: "cc:sess2:msg1",
        thread_id: "session-yesterday",
        author_name: "user",
        content: "Yesterday's message",
        sent_at: dayStart - 100,
      });

      const results = db.getThreadsByDate(dayStart, dayEnd);
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe("Today's message");
    });

    it("excludes messages with null thread_id", () => {
      const dayStart = 1700000000;
      const dayEnd = dayStart + 86400;

      db.upsertMessage({
        source: "slack",
        source_id: "C1:1",
        channel_name: "general",
        content: "No thread",
        sent_at: dayStart + 100,
      });
      db.upsertMessage({
        source: "claudecode",
        source_id: "cc:sess1:msg1",
        thread_id: "session-123",
        content: "Has thread",
        sent_at: dayStart + 200,
      });

      const results = db.getThreadsByDate(dayStart, dayEnd);
      expect(results).toHaveLength(1);
      expect(results[0].thread_id).toBe("session-123");
    });

    it("returns empty array when no threads in range", () => {
      const results = db.getThreadsByDate(1700000000, 1700086400);
      expect(results).toHaveLength(0);
    });
  });
});

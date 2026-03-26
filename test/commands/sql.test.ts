import { describe, it, expect, beforeEach } from "bun:test";
import { TraulDB } from "../../src/db/database";

describe("runSql", () => {
  let db: TraulDB;

  beforeEach(async () => {
    db = await TraulDB.create(":memory:");
    await db.upsertMessage({
      source: "slack",
      source_id: "C1:1",
      channel_name: "engineering",
      author_name: "alice",
      content: "Hello world",
      sent_at: 1700000000,
    });
    await db.upsertMessage({
      source: "telegram",
      source_id: "T1:1",
      channel_name: "random",
      author_name: "bob",
      content: "Goodbye world",
      sent_at: 1700000100,
    });
  });

  it("executes a SELECT query and returns rows", async () => {
    const { runSql } = await import("../../src/commands/sql");
    const rows = await runSql(db, "SELECT source, COUNT(*) as cnt FROM messages GROUP BY source ORDER BY source");
    expect(rows).toEqual([
      { source: "slack", cnt: 1 },
      { source: "telegram", cnt: 1 },
    ]);
  });

  it("executes PRAGMA queries", async () => {
    const { runSql } = await import("../../src/commands/sql");
    const rows = await runSql(db, "PRAGMA table_info(messages)") as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveProperty("name");
  });

  it("rejects INSERT statements", async () => {
    const { runSql } = await import("../../src/commands/sql");
    await expect(runSql(db, "INSERT INTO messages (source, source_id, content, sent_at) VALUES ('x','x','x',0)"))
      .rejects.toThrow(/read-only/i);
  });

  it("rejects DELETE statements", async () => {
    const { runSql } = await import("../../src/commands/sql");
    await expect(runSql(db, "DELETE FROM messages WHERE 1=1"))
      .rejects.toThrow(/read-only/i);
  });

  it("rejects UPDATE statements", async () => {
    const { runSql } = await import("../../src/commands/sql");
    await expect(runSql(db, "UPDATE messages SET content='hacked' WHERE 1=1"))
      .rejects.toThrow(/read-only/i);
  });

  it("rejects DROP statements", async () => {
    const { runSql } = await import("../../src/commands/sql");
    await expect(runSql(db, "DROP TABLE messages"))
      .rejects.toThrow(/read-only/i);
  });

  it("rejects CREATE statements", async () => {
    const { runSql } = await import("../../src/commands/sql");
    await expect(runSql(db, "CREATE TABLE evil (id INTEGER)"))
      .rejects.toThrow(/read-only/i);
  });

  it("rejects ALTER statements", async () => {
    const { runSql } = await import("../../src/commands/sql");
    await expect(runSql(db, "ALTER TABLE messages ADD COLUMN evil TEXT"))
      .rejects.toThrow(/read-only/i);
  });

  it("rejects stacked statements with semicolons", async () => {
    const { runSql } = await import("../../src/commands/sql");
    await expect(runSql(db, "SELECT 1; DROP TABLE messages"))
      .rejects.toThrow(/read-only/i);
  });

  it("handles case-insensitive keywords", async () => {
    const { runSql } = await import("../../src/commands/sql");
    await expect(runSql(db, "delete from messages"))
      .rejects.toThrow(/read-only/i);
  });

  it("handles leading whitespace in queries", async () => {
    const { runSql } = await import("../../src/commands/sql");
    const rows = await runSql(db, "  SELECT COUNT(*) as cnt FROM messages");
    expect(rows).toEqual([{ cnt: 2 }]);
  });

  it("allows WITH (CTE) queries", async () => {
    const { runSql } = await import("../../src/commands/sql");
    const rows = await runSql(db, "WITH src AS (SELECT source FROM messages GROUP BY source) SELECT COUNT(*) as cnt FROM src");
    expect(rows).toEqual([{ cnt: 2 }]);
  });

  it("allows EXPLAIN queries", async () => {
    const { runSql } = await import("../../src/commands/sql");
    const rows = await runSql(db, "EXPLAIN QUERY PLAN SELECT * FROM messages") as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("runSql with write flag", () => {
  let db: TraulDB;

  beforeEach(async () => {
    db = await TraulDB.create(":memory:");
    await db.upsertMessage({
      source: "slack",
      source_id: "C1:1",
      channel_name: "engineering",
      author_name: "alice",
      content: "Hello world",
      sent_at: 1700000000,
    });
  });

  it("allows UPDATE when write=true", async () => {
    const { runSql } = await import("../../src/commands/sql");
    const result = await runSql(db, "UPDATE messages SET content='Updated' WHERE source_id='C1:1'", { write: true });
    expect(result).toHaveProperty("changes");

    const rows = await runSql(db, "SELECT content FROM messages WHERE source_id='C1:1'");
    expect(rows).toEqual([{ content: "Updated" }]);
  });

  it("allows DELETE when write=true", async () => {
    const { runSql } = await import("../../src/commands/sql");
    const result = await runSql(db, "DELETE FROM messages WHERE source_id='C1:1'", { write: true });
    expect(result).toHaveProperty("changes");

    const rows = await runSql(db, "SELECT COUNT(*) as cnt FROM messages");
    expect(rows).toEqual([{ cnt: 0 }]);
  });

  it("allows INSERT when write=true", async () => {
    const { runSql } = await import("../../src/commands/sql");
    const result = await runSql(db, "INSERT INTO messages (source, source_id, content, sent_at) VALUES ('test','T:1','test msg',1700000000)", { write: true });
    expect(result).toHaveProperty("changes");

    const rows = await runSql(db, "SELECT COUNT(*) as cnt FROM messages WHERE source='test'");
    expect(rows).toEqual([{ cnt: 1 }]);
  });

  it("still rejects writes without the flag", async () => {
    const { runSql } = await import("../../src/commands/sql");
    await expect(runSql(db, "DELETE FROM messages"))
      .rejects.toThrow(/read-only/i);
  });
});

describe("runSchema", () => {
  let db: TraulDB;

  beforeEach(async () => {
    db = await TraulDB.create(":memory:");
  });

  it("returns table info with columns", async () => {
    const { runSchema } = await import("../../src/commands/sql");
    const tables = await runSchema(db);
    expect(tables.length).toBeGreaterThan(0);

    const messages = tables.find((t) => t.name === "messages");
    expect(messages).toBeDefined();
    expect(messages!.columns.length).toBeGreaterThan(0);
    expect(messages!.columns.find((c) => c.name === "content")).toBeDefined();
  });

  it("includes column types", async () => {
    const { runSchema } = await import("../../src/commands/sql");
    const tables = await runSchema(db);
    const messages = tables.find((t) => t.name === "messages")!;
    const idCol = messages.columns.find((c) => c.name === "id")!;
    expect(idCol.type).toBe("INTEGER");
  });

  it("excludes FTS shadow tables", async () => {
    const { runSchema } = await import("../../src/commands/sql");
    const tables = await runSchema(db);
    const names = tables.map((t) => t.name);
    expect(names).not.toContain("messages_fts_content");
    expect(names).not.toContain("messages_fts_idx");
  });

  it("includes virtual tables like messages_fts", async () => {
    const { runSchema } = await import("../../src/commands/sql");
    const tables = await runSchema(db);
    const names = tables.map((t) => t.name);
    expect(names).toContain("messages_fts");
  });
});

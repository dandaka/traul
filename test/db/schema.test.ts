import { describe, it, expect } from "bun:test";
import { initializeDatabase } from "../../src/db/schema";

describe("schema", () => {
  it("creates all tables including embedding columns", async () => {
    const db = await initializeDatabase(":memory:");
    const msgCols = (await db.execute("PRAGMA table_info(messages)")).rows;
    const embCol = msgCols.find((r: any) => r.name === "embedding");
    expect(embCol).toBeTruthy();

    const chunkCols = (await db.execute("PRAGMA table_info(chunks)")).rows;
    const chunkEmbCol = chunkCols.find((r: any) => r.name === "embedding");
    expect(chunkEmbCol).toBeTruthy();

    const tables = (
      await db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      )
    ).rows.map((r: any) => r.name);
    expect(tables).toContain("messages_fts");
    expect(tables).toContain("chunks_fts");
    expect(tables).toContain("traul_meta");
    db.close();
  });

  it("does not create DiskANN vector indexes", async () => {
    const db = await initializeDatabase(":memory:");
    const indexes = (
      await db.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%vec%'"
      )
    ).rows.map((r: any) => r.name);
    expect(indexes).not.toContain("idx_msg_vec");
    expect(indexes).not.toContain("idx_chunk_vec");
    db.close();
  });

  it("creates all expected tables", async () => {
    const db = await initializeDatabase(":memory:");
    const tables = (
      await db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
    ).rows.map((r: any) => r.name);

    expect(tables).toContain("messages");
    expect(tables).toContain("contacts");
    expect(tables).toContain("contact_identities");
    expect(tables).toContain("sync_cursors");
    expect(tables).toContain("chunks");
    db.close();
  });
});

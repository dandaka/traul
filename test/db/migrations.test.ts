import { describe, it, expect } from "bun:test";
import { TraulDB } from "../../src/db/database";
import { runMigrations } from "../../src/db/migrations";

describe("migrations", () => {
  it("runs without error on fresh database", async () => {
    const db = await TraulDB.create(":memory:");
    const result = await runMigrations(db);
    expect(result.chunksReset).toBe(false);
    db.close();
  });

  it("stores meta values after migration", async () => {
    const db = await TraulDB.create(":memory:");
    await runMigrations(db);
    const model = await db.getMeta("embed_model");
    expect(model).toBeTruthy();
    db.close();
  });
});

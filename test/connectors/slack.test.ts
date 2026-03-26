import { describe, it, expect } from "bun:test";
import { slackConnector } from "../../src/connectors/slack";

describe("Slack connector", () => {
  it("has correct name", () => {
    expect(slackConnector.name).toBe("slack");
  });

  it("returns zero counts when no token configured", async () => {
    const { TraulDB } = await import("../../src/db/database");
    const db = await TraulDB.create(":memory:");
    const config = {
      database: { path: ":memory:" },
      slack: { token: "", my_user_id: "", channels: [] },
    };

    const result = await slackConnector.sync(db, config as any);
    expect(result.messagesAdded).toBe(0);
    expect(result.messagesUpdated).toBe(0);
    expect(result.contactsAdded).toBe(0);
    db.close();
  });
});

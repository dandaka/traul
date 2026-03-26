import { describe, it, expect } from "bun:test";
import { loadConfig } from "../../src/lib/config";
import { discordConnector, filterGuilds, filterChannels, dateToSnowflake, buildContent } from "../../src/connectors/discord";
import { TraulDB } from "../../src/db/database";

describe("Discord config", () => {
  it("loads DISCORD_TOKEN from env", () => {
    const orig = process.env.DISCORD_TOKEN;
    process.env.DISCORD_TOKEN = "test-token-123";
    const config = loadConfig();
    expect(config.discord.token).toBe("test-token-123");
    if (orig) {
      process.env.DISCORD_TOKEN = orig;
    } else {
      delete process.env.DISCORD_TOKEN;
    }
  });
});

describe("Discord filtering", () => {
  const guilds = [
    { id: "1", name: "Server A" },
    { id: "2", name: "Server B" },
    { id: "3", name: "Server C" },
  ];

  it("returns all guilds when no filters set", () => {
    const result = filterGuilds(guilds, { allowlist: [], stoplist: [] });
    expect(result).toHaveLength(3);
  });

  it("filters guilds by allowlist", () => {
    const result = filterGuilds(guilds, { allowlist: ["1", "3"], stoplist: [] });
    expect(result.map((g) => g.id)).toEqual(["1", "3"]);
  });

  it("filters guilds by stoplist", () => {
    const result = filterGuilds(guilds, { allowlist: [], stoplist: ["2"] });
    expect(result.map((g) => g.id)).toEqual(["1", "3"]);
  });

  it("applies allowlist then stoplist", () => {
    const result = filterGuilds(guilds, { allowlist: ["1", "2"], stoplist: ["2"] });
    expect(result.map((g) => g.id)).toEqual(["1"]);
  });

  it("filters channels by allowlist", () => {
    const channels = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const result = filterChannels(channels, { allowlist: ["a"], stoplist: [] });
    expect(result.map((c) => c.id)).toEqual(["a"]);
  });

  it("filters channels by stoplist", () => {
    const channels = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const result = filterChannels(channels, { allowlist: [], stoplist: ["b"] });
    expect(result.map((c) => c.id)).toEqual(["a", "c"]);
  });
});

describe("Discord snowflake conversion", () => {
  it("converts epoch to snowflake 0", () => {
    const result = dateToSnowflake(new Date("2015-01-01T00:00:00.000Z"));
    expect(result).toBe("0");
  });

  it("converts a known date to correct snowflake", () => {
    const date = new Date("2025-01-01T00:00:00.000Z");
    const expected = String((BigInt(date.getTime()) - 1420070400000n) << 22n);
    expect(dateToSnowflake(date)).toBe(expected);
  });
});

describe("Discord content building", () => {
  it("returns content when present", () => {
    expect(buildContent({ content: "hello" })).toBe("hello");
  });

  it("falls back to attachment filenames", () => {
    expect(buildContent({
      content: "",
      attachments: [{ filename: "image.png" }],
    })).toBe("[attachment: image.png]");
  });

  it("falls back to embed titles", () => {
    expect(buildContent({
      content: "",
      embeds: [{ title: "Article" }],
    })).toBe("[embed: Article]");
  });

  it("combines attachments and embeds", () => {
    expect(buildContent({
      content: "",
      attachments: [{ filename: "doc.pdf" }],
      embeds: [{ title: "Link Preview" }],
    })).toBe("[attachment: doc.pdf] [embed: Link Preview]");
  });

  it("returns empty string when no content, attachments, or embeds", () => {
    expect(buildContent({ content: "" })).toBe("");
  });
});

describe("Discord connector", () => {
  it("has correct name", () => {
    expect(discordConnector.name).toBe("discord");
  });

  it("returns zero counts when no token configured", async () => {
    const db = await TraulDB.create(":memory:");
    const config = {
      sync_start: "",
      database: { path: ":memory:" },
      discord: {
        token: "",
        servers: { allowlist: [], stoplist: [] },
        channels: { allowlist: [], stoplist: [] },
      },
    };

    const result = await discordConnector.sync(db, config as any);
    expect(result.messagesAdded).toBe(0);
    expect(result.messagesUpdated).toBe(0);
    expect(result.contactsAdded).toBe(0);
    db.close();
  });
});

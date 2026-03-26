import type { Connector, SyncResult } from "./types";
import type { TraulDB } from "../db/database";
import { type TraulConfig, getSyncStartTimestamp } from "../lib/config";
import * as log from "../lib/logger";

const BASE_URL = "https://discord.com/api/v9";
const DISCORD_EPOCH = 1420070400000n;
const FLOOR_DELAY_MS = 100;
const MAX_RETRIES = 5;

export function dateToSnowflake(date: Date): string {
  const ms = BigInt(date.getTime());
  return String((ms - DISCORD_EPOCH) << 22n);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function discordFetch(
  path: string,
  token: string,
  params?: Record<string, string>
): Promise<Response> {
  const url = new URL(`${BASE_URL}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v) url.searchParams.set(k, v);
    }
  }

  let retries = 0;
  while (true) {
    await sleep(FLOOR_DELAY_MS);

    const resp = await fetch(url.toString(), {
      headers: { Authorization: token },
    });

    if (resp.status === 429) {
      if (retries >= MAX_RETRIES) {
        throw new Error(`Rate limited after ${MAX_RETRIES} retries: ${path}`);
      }
      const retryAfter = parseFloat(resp.headers.get("Retry-After") ?? "1");
      log.warn(`Rate limited on ${path}, waiting ${retryAfter}s...`);
      await sleep(retryAfter * 1000);
      retries++;
      continue;
    }

    // Proactive rate limit handling
    const remaining = resp.headers.get("X-RateLimit-Remaining");
    const resetAfter = resp.headers.get("X-RateLimit-Reset-After");
    if (remaining === "0" && resetAfter) {
      await sleep(parseFloat(resetAfter) * 1000);
    }

    return resp;
  }
}

export function buildContent(msg: {
  content: string;
  attachments?: Array<{ filename: string }>;
  embeds?: Array<{ title?: string }>;
}): string {
  if (msg.content) return msg.content;
  const parts: string[] = [];
  for (const att of msg.attachments ?? []) {
    parts.push(`[attachment: ${att.filename}]`);
  }
  for (const emb of msg.embeds ?? []) {
    if (emb.title) parts.push(`[embed: ${emb.title}]`);
  }
  return parts.join(" ");
}

export function filterGuilds(
  guilds: Array<{ id: string; name: string }>,
  servers: { allowlist: string[]; stoplist: string[] }
): Array<{ id: string; name: string }> {
  let filtered = guilds;
  if (servers.allowlist.length > 0) {
    filtered = filtered.filter((g) => servers.allowlist.includes(g.id));
  }
  if (servers.stoplist.length > 0) {
    filtered = filtered.filter((g) => !servers.stoplist.includes(g.id));
  }
  return filtered;
}

export function filterChannels(
  channels: Array<{ id: string }>,
  filters: { allowlist: string[]; stoplist: string[] }
): Array<{ id: string }> {
  let filtered = channels;
  if (filters.allowlist.length > 0) {
    filtered = filtered.filter((c) => filters.allowlist.includes(c.id));
  }
  if (filters.stoplist.length > 0) {
    filtered = filtered.filter((c) => !filters.stoplist.includes(c.id));
  }
  return filtered;
}

export const discordConnector: Connector = {
  defaultInterval: 300,
  hasCredentials: (config) => !!config.discord.token,
  name: "discord",

  async sync(db: TraulDB, config: TraulConfig): Promise<SyncResult> {
    if (!config.discord.token) {
      log.warn("Discord token not configured.");
      log.warn("Set DISCORD_TOKEN env var, or add discord.token to ~/.config/traul/config.json");
      return { messagesAdded: 0, messagesUpdated: 0, contactsAdded: 0 };
    }

    const token = config.discord.token;
    const result: SyncResult = { messagesAdded: 0, messagesUpdated: 0, contactsAdded: 0 };

    // Contact cache to avoid redundant lookups
    const contactCache = new Map<string, string>();

    async function resolveContact(author: { id: string; username: string; global_name?: string }): Promise<string> {
      const cached = contactCache.get(author.id);
      if (cached) return cached;

      const displayName = author.global_name || author.username;
      contactCache.set(author.id, displayName);

      const existing = await db.getContactBySourceId("discord", author.id);
      if (!existing) {
        const contactId = await db.upsertContact(displayName);
        await db.upsertContactIdentity({
          contactId,
          source: "discord",
          sourceUserId: author.id,
          username: author.username,
          displayName,
        });
        result.contactsAdded++;
      }

      return displayName;
    }

    // --- Fetch guilds ---
    let guilds: Array<{ id: string; name: string }> = [];
    let afterGuild = "0";
    while (true) {
      const resp = await discordFetch("/users/@me/guilds", token, {
        limit: "200",
        after: afterGuild,
      });
      if (!resp.ok) {
        log.error(`Failed to fetch guilds: ${resp.status}`);
        break;
      }
      const page: Array<{ id: string; name: string }> = await resp.json();
      if (page.length === 0) break;
      guilds.push(...page);
      afterGuild = page[page.length - 1].id;
      if (page.length < 200) break;
    }

    // Apply server filters
    const { servers, channels: channelFilters } = config.discord;
    guilds = filterGuilds(guilds, servers);

    log.info(`Found ${guilds.length} servers to sync`);

    // --- Fetch channels per guild ---
    interface ChannelInfo {
      id: string;
      name: string;
      type: number;
      parent_id?: string;
      guildName?: string;
      recipients?: Array<{ id: string; username: string; global_name?: string }>;
    }

    const allChannels: ChannelInfo[] = [];
    const guildNameMap = new Map<string, string>();

    for (const guild of guilds) {
      guildNameMap.set(guild.id, guild.name);
      const resp = await discordFetch(`/guilds/${guild.id}/channels`, token);
      if (!resp.ok) {
        if (resp.status === 403 || resp.status === 401) {
          log.warn(`  No access to ${guild.name}, skipping`);
          continue;
        }
        log.error(`Failed to fetch channels for ${guild.name}: ${resp.status}`);
        continue;
      }
      const channels: ChannelInfo[] = await resp.json();
      // Text channels (0), announcement (5), active threads (11, 12)
      const textChannels = channels.filter((c) => [0, 5, 11, 12].includes(c.type));
      for (const ch of textChannels) {
        ch.guildName = guild.name;
      }
      allChannels.push(...textChannels);

      // Fetch archived threads for each text channel
      for (const ch of channels.filter((c) => [0, 5].includes(c.type))) {
        for (const endpoint of [
          `/channels/${ch.id}/threads/archived/public`,
          `/channels/${ch.id}/threads/archived/private`,
        ]) {
          const threadResp = await discordFetch(endpoint, token);
          if (!threadResp.ok) continue;
          const threadData: { threads?: ChannelInfo[] } = await threadResp.json();
          for (const t of threadData.threads ?? []) {
            t.guildName = guild.name;
            allChannels.push(t);
          }
        }
      }
    }

    // --- Fetch DM channels ---
    const dmResp = await discordFetch("/users/@me/channels", token);
    if (dmResp.ok) {
      const dmChannels: ChannelInfo[] = await dmResp.json();
      allChannels.push(...dmChannels);
    }

    // Apply channel filters
    const filteredChannels = filterChannels(allChannels, channelFilters) as ChannelInfo[];

    log.info(`Syncing ${filteredChannels.length} channels...`);

    // --- Compute initial snowflake from sync_start ---
    const syncStartTs = getSyncStartTimestamp(config);
    const initialSnowflake = dateToSnowflake(new Date(parseInt(syncStartTs) * 1000));

    // --- Sync messages per channel ---
    for (const channel of filteredChannels) {
      // Build channel name
      let channelName: string;
      if (channel.type === 1) {
        // DM
        const recipient = channel.recipients?.[0];
        channelName = `DM/${recipient?.global_name || recipient?.username || channel.id}`;
      } else if (channel.type === 3) {
        // Group DM
        const names = (channel.recipients ?? [])
          .map((r) => r.global_name || r.username)
          .join(", ");
        channelName = `GroupDM/${names || channel.id}`;
      } else {
        // Server channel or thread
        channelName = `${channel.guildName}/${channel.name}`;
      }

      log.info(`  ${channelName}`);

      const cursorKey = `channel:${channel.id}`;
      const existingCursor = await db.getSyncCursor("discord", cursorKey);
      // If sync_start produces an earlier snowflake than cursor, backfill
      const cursor = existingCursor
        ? BigInt(initialSnowflake) < BigInt(existingCursor) ? initialSnowflake : existingCursor
        : initialSnowflake;
      let latestId = cursor;
      let channelMsgCount = 0;
      let afterMsg = cursor;

      // Paginate forward using after=
      while (true) {
        const resp = await discordFetch(`/channels/${channel.id}/messages`, token, {
          limit: "100",
          after: afterMsg,
        });

        if (!resp.ok) {
          if (resp.status === 403 || resp.status === 401) {
            log.warn(`    No access, skipping`);
          } else {
            log.warn(`    Failed to fetch messages: ${resp.status}`);
          }
          break;
        }

        const messages: Array<{
          id: string;
          type: number;
          content: string;
          author: { id: string; username: string; global_name?: string };
          timestamp: string;
          attachments?: Array<{ filename: string }>;
          embeds?: Array<{ title?: string }>;
          thread?: { id: string };
          message_reference?: { message_id?: string };
        }> = await resp.json();

        if (messages.length === 0) break;

        // Discord returns newest first, reverse for chronological processing
        messages.reverse();

        for (const msg of messages) {
          // Skip non-default and non-reply types
          if (msg.type !== 0 && msg.type !== 19) continue;

          // Build content
          const content = buildContent(msg);
          if (!content) continue;

          const displayName = await resolveContact(msg.author);

          // Determine thread_id
          let threadId: string | undefined;
          if (channel.type === 11 || channel.type === 12) {
            threadId = channel.id;
          }

          await db.upsertMessage({
            source: "discord",
            source_id: `${channel.id}:${msg.id}`,
            channel_id: channel.id,
            channel_name: channelName,
            thread_id: threadId,
            author_id: msg.author.id,
            author_name: displayName,
            content,
            sent_at: Math.floor(new Date(msg.timestamp).getTime() / 1000),
          });
          channelMsgCount++;

          if (BigInt(msg.id) > BigInt(latestId)) {
            latestId = msg.id;
          }
        }

        afterMsg = messages[messages.length - 1].id;
        if (messages.length < 100) break;
      }

      if (latestId !== cursor) {
        await db.setSyncCursor("discord", cursorKey, latestId);
      }
      result.messagesAdded += channelMsgCount;
      if (channelMsgCount > 0) {
        log.info(`    ${channelMsgCount} messages`);
      }
    }

    return result;
  },
};

import { WebClient, LogLevel } from "@slack/web-api";
import type { Connector, SyncResult } from "./types";
import type { TraulDB } from "../db/database";
import { type TraulConfig, getEffectiveSyncStart } from "../lib/config";
import * as log from "../lib/logger";

export const slackConnector: Connector = {
  name: "slack",
  defaultInterval: 300,
  hasCredentials: (config) => !!config.slack.token,

  async sync(db: TraulDB, config: TraulConfig): Promise<SyncResult> {
    if (!config.slack.token) {
      log.warn("Slack token not configured.");
      log.warn("Set SLACK_BOT_TOKEN or SLACK_USER_TOKEN env var, or add slack.token to ~/.config/traul/config.json");
      log.warn("To extract tokens from Slack desktop app, run: /slack connect");
      return { messagesAdded: 0, messagesUpdated: 0, contactsAdded: 0 };
    }

    const headers: Record<string, string> = {};
    if (config.slack.token.startsWith("xoxc-") && config.slack.cookie) {
      headers.cookie = `d=${config.slack.cookie}`;
    }
    const client = new WebClient(config.slack.token, {
      headers,
      retryConfig: { retries: 5, factor: 2 },
      logLevel: LogLevel.ERROR, // suppress built-in rate limit warnings
    });
    const result: SyncResult = {
      messagesAdded: 0,
      messagesUpdated: 0,
      contactsAdded: 0,
    };

    const userCache = new Map<
      string,
      { displayName: string; username: string }
    >();

    async function resolveUser(
      userId: string
    ): Promise<{ displayName: string; username: string }> {
      const cached = userCache.get(userId);
      if (cached) return cached;

      try {
        const resp = await client.users.info({ user: userId });
        const user = resp.user!;
        const displayName =
          user.profile?.display_name || user.real_name || user.name || userId;
        const username = user.name || userId;

        userCache.set(userId, { displayName, username });

        const existing = await db.getContactBySourceId("slack", userId);
        if (!existing) {
          const contactId = await db.upsertContact(displayName);
          await db.upsertContactIdentity({
            contactId,
            source: "slack",
            sourceUserId: userId,
            username,
            displayName,
          });
          result.contactsAdded++;
        }

        return { displayName, username };
      } catch (err) {
        log.warn(`Failed to resolve user ${userId}:`, err);
        return { displayName: userId, username: userId };
      }
    }

    // Get channels to sync
    let channelIds: Array<{ id: string; name: string }> = [];

    if (config.slack.channels.length > 0) {
      // Use configured channel list
      for (const name of config.slack.channels) {
        const cursor = undefined;
        let found = false;
        for await (const page of paginateChannels(client)) {
          const ch = page.find(
            (c: any) => c.name === name || c.id === name
          );
          if (ch) {
            channelIds.push({ id: ch.id, name: ch.name });
            found = true;
            break;
          }
        }
        if (!found) log.warn(`Channel not found: ${name}`);
      }
    } else {
      // All joined channels
      for await (const page of paginateChannels(client)) {
        for (const ch of page) {
          if (ch.is_member) {
            channelIds.push({ id: ch.id, name: ch.name });
          }
        }
      }
    }

    log.info(`Syncing ${channelIds.length} channels...`);

    for (const channel of channelIds) {
      log.info(`  #${channel.name}`);
      const cursorKey = `channel:${channel.id}`;
      const oldest = (await getEffectiveSyncStart(db, config, "slack", cursorKey)) ?? "0";
      let latestTs = oldest;
      let channelMsgCount = 0;

      let cursor: string | undefined;
      do {
        const resp = await client.conversations.history({
          channel: channel.id,
          oldest,
          limit: 200,
          cursor,
        });

        for (const msg of resp.messages ?? []) {
          if (msg.subtype && msg.subtype !== "thread_broadcast") continue;
          if (!msg.ts || !msg.text) continue;

          const user = msg.user ? await resolveUser(msg.user) : null;

          await db.upsertMessage({
            source: "slack",
            source_id: `${channel.id}:${msg.ts}`,
            channel_id: channel.id,
            channel_name: channel.name,
            thread_id: msg.thread_ts !== msg.ts ? msg.thread_ts : undefined,
            author_id: msg.user,
            author_name: user?.displayName,
            content: msg.text,
            sent_at: Math.floor(parseFloat(msg.ts)),
            metadata: JSON.stringify({
              reactions: msg.reactions,
              reply_count: msg.reply_count,
            }),
          });
          channelMsgCount++;

          if (msg.ts > latestTs) latestTs = msg.ts;

          // Fetch thread replies
          if (msg.reply_count && msg.reply_count > 0 && msg.thread_ts === msg.ts) {
            let threadCursor: string | undefined;
            do {
              const threadResp = await client.conversations.replies({
                channel: channel.id,
                ts: msg.ts,
                oldest,
                limit: 200,
                cursor: threadCursor,
              });

              for (const reply of threadResp.messages ?? []) {
                if (reply.ts === msg.ts) continue; // skip parent
                if (!reply.text) continue;

                const replyUser = reply.user
                  ? await resolveUser(reply.user)
                  : null;

                await db.upsertMessage({
                  source: "slack",
                  source_id: `${channel.id}:${reply.ts}`,
                  channel_id: channel.id,
                  channel_name: channel.name,
                  thread_id: msg.ts,
                  author_id: reply.user,
                  author_name: replyUser?.displayName,
                  content: reply.text,
                  sent_at: Math.floor(parseFloat(reply.ts!)),
                });
                channelMsgCount++;

                if (reply.ts! > latestTs) latestTs = reply.ts!;
              }

              threadCursor =
                threadResp.response_metadata?.next_cursor || undefined;
            } while (threadCursor);
          }
        }

        cursor = resp.response_metadata?.next_cursor || undefined;
      } while (cursor);

      if (latestTs !== oldest) {
        await db.setSyncCursor("slack", cursorKey, latestTs);
      }
      result.messagesAdded += channelMsgCount;
      log.info(`    ${channelMsgCount} messages`);
    }

    return result;
  },
};

async function* paginateChannels(client: WebClient) {
  let cursor: string | undefined;
  do {
    const resp = await client.conversations.list({
      types: "public_channel,private_channel",
      limit: 200,
      cursor,
      exclude_archived: true,
    });
    yield (resp.channels ?? []) as Array<{
      id: string;
      name: string;
      is_member: boolean;
    }>;
    cursor = resp.response_metadata?.next_cursor || undefined;
  } while (cursor);
}

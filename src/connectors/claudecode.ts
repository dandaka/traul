import { readdirSync, readFileSync, statSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import type { Connector, SyncResult } from "./types";
import type { TraulDB } from "../db/database";
import type { TraulConfig } from "../lib/config";
import { getSyncStartTimestamp } from "../lib/config";
import { shouldChunk, chunkText } from "../lib/chunker";
import * as log from "../lib/logger";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");

interface SessionMessage {
  type: string;
  timestamp: string;
  sessionId: string;
  uuid: string;
  message?: {
    content: string | Array<{ type: string; text?: string; tool_use_id?: string }>;
    role?: string;
  };
  cwd?: string;
}

function extractTextContent(message: SessionMessage): string | null {
  if (!message.message) return null;
  const content = message.message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!);
    return texts.length > 0 ? texts.join("\n") : null;
  }
  return null;
}

function projectNameFromDir(dirName: string): string {
  // Convert "-Users-dandaka-projects-traul" → "traul"
  // Take the last meaningful segment
  const parts = dirName.split("-").filter(Boolean);
  return parts[parts.length - 1] || dirName;
}

export const claudeCodeConnector: Connector = {
  defaultInterval: 600,
  name: "claudecode",

  async sync(db: TraulDB, config: TraulConfig): Promise<SyncResult> {
    const result: SyncResult = { messagesAdded: 0, messagesUpdated: 0, contactsAdded: 0 };

    let projectDirs: string[];
    try {
      projectDirs = readdirSync(PROJECTS_DIR);
    } catch {
      log.warn("Claude Code projects dir not found: " + PROJECTS_DIR);
      return result;
    }

    const syncStartTs = getSyncStartTimestamp(config);
    const syncStartSec = syncStartTs !== "0" ? parseInt(syncStartTs) : 0;

    let totalSessions = 0;

    for (const projDir of projectDirs) {
      const projPath = join(PROJECTS_DIR, projDir);
      try {
        if (!statSync(projPath).isDirectory()) continue;
      } catch {
        continue;
      }

      const projectName = projectNameFromDir(projDir);
      const files = readdirSync(projPath).filter((f) => f.endsWith(".jsonl"));

      for (const file of files) {
        const sessionId = basename(file, ".jsonl");
        const cursorKey = `session:${sessionId}`;
        let lastCursor = await db.getSyncCursor("claudecode", cursorKey);

        // If sync_start is earlier than cursor, ignore cursor to backfill
        if (lastCursor && syncStartSec > 0) {
          const cursorSec = Math.floor(new Date(lastCursor).getTime() / 1000);
          if (syncStartSec < cursorSec) {
            lastCursor = null;
          }
        }

        const filePath = join(projPath, file);
        let lines: string[];
        try {
          lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
        } catch {
          continue;
        }

        let sessionMessages: Array<{
          text: string;
          author: string;
          timestamp: number;
          uuid: string;
        }> = [];

        let latestTimestamp: string | null = null;

        for (const line of lines) {
          let msg: SessionMessage;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }

          if (msg.type !== "user" && msg.type !== "assistant") continue;
          if (!msg.timestamp) continue;

          const sentAt = Math.floor(new Date(msg.timestamp).getTime() / 1000);
          if (sentAt < syncStartSec) continue;

          // Skip tool results (user messages with array content containing tool_result)
          if (msg.type === "user" && Array.isArray(msg.message?.content)) {
            const hasToolResult = msg.message!.content.some(
              (c: { type: string }) => c.type === "tool_result"
            );
            if (hasToolResult) continue;
          }

          const text = extractTextContent(msg);
          if (!text || text.length < 5) continue;

          // Skip command messages (system-generated)
          if (text.startsWith("<command-message>")) continue;

          if (lastCursor && msg.timestamp <= lastCursor) continue;

          sessionMessages.push({
            text,
            author: msg.type === "user" ? "user" : "claude",
            timestamp: sentAt,
            uuid: msg.uuid,
          });

          if (!latestTimestamp || msg.timestamp > latestTimestamp) {
            latestTimestamp = msg.timestamp;
          }
        }

        if (sessionMessages.length === 0) continue;
        totalSessions++;

        // Store each meaningful exchange as a message
        for (const sm of sessionMessages) {
          await db.upsertMessage({
            source: "claudecode",
            source_id: `cc:${sessionId}:${sm.uuid}`,
            channel_name: projectName,
            thread_id: sessionId,
            author_name: sm.author,
            content: sm.text,
            sent_at: sm.timestamp,
            metadata: JSON.stringify({ project_dir: projDir }),
          });
          result.messagesAdded++;

          // Chunk long messages for better embedding coverage (only if not already chunked)
          if (shouldChunk(sm.text)) {
            const sourceId = `cc:${sessionId}:${sm.uuid}`.replace(/'/g, "''");
            const msgResult = await db.execute(
              `SELECT id FROM messages WHERE source = 'claudecode' AND source_id = '${sourceId}'`
            );
            const msgRow = msgResult.rows[0] as { id: number } | undefined;
            if (msgRow) {
              const existing = await db.execute(
                `SELECT 1 FROM chunks WHERE message_id = ${msgRow.id} LIMIT 1`
              );
              if (existing.rows.length === 0) {
                const chunks = chunkText(sm.text, { docTitle: `${projectName} session` });
                await db.replaceChunks(msgRow.id, chunks);
              }
            }
          }
        }

        if (latestTimestamp) {
          await db.setSyncCursor("claudecode", cursorKey, latestTimestamp);
        }
      }
    }

    log.info(`  Processed ${totalSessions} sessions across ${projectDirs.length} projects`);
    return result;
  },
};

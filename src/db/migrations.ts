import type { TraulDB } from "./database";
import { CHUNKER_VERSION } from "../lib/chunker";
import { EMBED_MODEL } from "../lib/embeddings";
import { EMBED_DIMS } from "./schema";
import * as log from "../lib/logger";

export interface MigrationResult {
  chunksReset: boolean;
  embeddingsReset: boolean;
  syncCursorsReset: boolean;
}

export async function runMigrations(db: TraulDB): Promise<MigrationResult> {
  const result: MigrationResult = { chunksReset: false, embeddingsReset: false, syncCursorsReset: false };

  // Schema v2 migration: detect old sqlite-vec schema (run once)
  const schemaVersion = await db.getMeta("schema_version");
  if (schemaVersion !== "2") {
    const oldVecTable = await db.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = 'vec_messages'"
    );
    if (oldVecTable.rows.length > 0) {
      log.info("Migrating from sqlite-vec to libSQL native vectors...");
      // vec0 tables can't be dropped without the sqlite-vec extension loaded — harmless leftovers
      try { await db.execute("DROP TABLE IF EXISTS vec_messages"); } catch {}
      try { await db.execute("DROP TABLE IF EXISTS vec_chunks"); } catch {}
      await db.resetEmbeddings();
      result.embeddingsReset = true;
      log.info("Migration complete. Run 'traul embed' to re-generate embeddings.");
    }
    await db.setMeta("schema_version", "2");
  }

  // Existing migration logic (now async)
  const storedChunkerVersion = await db.getMeta("chunker_version");
  const storedEmbedModel = await db.getMeta("embed_model");
  const storedEmbedDims = await db.getMeta("embed_dims");
  const currentDims = String(EMBED_DIMS);

  if (storedChunkerVersion !== null && storedChunkerVersion !== CHUNKER_VERSION) {
    log.info(`Chunker updated (v${storedChunkerVersion} → v${CHUNKER_VERSION}), rechunking on next sync...`);
    await db.resetChunks();
    await db.resetEmbeddings();
    await db.resetSyncCursors("markdown");
    result.chunksReset = true;
    result.embeddingsReset = true;
    result.syncCursorsReset = true;
  }

  if (!result.embeddingsReset && storedEmbedModel !== null &&
      (storedEmbedModel !== EMBED_MODEL || storedEmbedDims !== currentDims)) {
    const reason = storedEmbedModel !== EMBED_MODEL
      ? `model changed (${storedEmbedModel} → ${EMBED_MODEL})`
      : `dimensions changed (${storedEmbedDims} → ${currentDims})`;
    log.info(`Embedding ${reason}, re-embed with 'traul embed'...`);
    await db.resetEmbeddings();
    result.embeddingsReset = true;
  }

  if (storedChunkerVersion !== CHUNKER_VERSION) await db.setMeta("chunker_version", CHUNKER_VERSION);
  if (storedEmbedModel !== EMBED_MODEL) await db.setMeta("embed_model", EMBED_MODEL);
  if (storedEmbedDims !== currentDims) await db.setMeta("embed_dims", currentDims);

  return result;
}

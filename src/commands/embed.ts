import type { TraulDB } from "../db/database";
import { embedBatch, BATCH_SIZE } from "../lib/embeddings";
import { shouldChunk, chunkText, CHUNK_THRESHOLD } from "../lib/chunker";

function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${mins}m ${remSecs}s`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h ${remMins}m`;
}

async function embedItems(
  items: Array<{ id: number; content: string }>,
  insertFn: (id: number, embedding: Float32Array) => Promise<void>,
  label: string,
  quiet: boolean,
  chunkFn?: (id: number, content: string) => Promise<void>,
  onBatchDone?: (done: number, failed: number) => void,
): Promise<{ done: number; failed: number; elapsed: number }> {
  let done = 0;
  let failed = 0;
  const startTime = Date.now();

  if (!quiet) {
    console.log(`Embedding ${items.length} ${label}...`);
  }

  const skippedIds: number[] = [];

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    let batch = items.slice(i, i + BATCH_SIZE);

    // Chunk long items instead of embedding them directly
    if (chunkFn) {
      const short: typeof batch = [];
      for (const item of batch) {
        if (shouldChunk(item.content)) {
          await chunkFn(item.id, item.content);
          done++; // counted as processed (chunks will be embedded separately)
        } else {
          short.push(item);
        }
      }
      batch = short;
    }

    if (batch.length === 0) continue;

    try {
      const vecs = await embedBatch(
        batch.map((item) => item.content),
        (idx) => {
          failed++;
          skippedIds.push(batch[idx]?.id);
        }
      );
      for (let j = 0; j < batch.length; j++) {
        if (vecs[j] !== null) {
          await insertFn(batch[j].id, vecs[j]!);
          done++;
        }
      }
    } catch (err) {
      failed += batch.length;
      if (!quiet) {
        const errMsg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`\n  ! ${label} batch at ${i}: ${errMsg}\n`);
      }
    }

    onBatchDone?.(done, failed);

    if (!quiet) {
      const elapsed = Date.now() - startTime;
      const processed = done + failed;
      const msPerMsg = elapsed / processed;
      const remaining = items.length - processed;
      const eta = formatDuration(msPerMsg * remaining);
      const pct = Math.round((processed / items.length) * 100);
      process.stdout.write(
        `\r  ${processed}/${items.length} (${pct}%)  ${done} ok, ${failed} err  ETA: ${eta}   `
      );
    }
  }

  if (!quiet && items.length > 0) {
    process.stdout.write("\r" + " ".repeat(80) + "\r");
    if (skippedIds.length > 0) {
      process.stderr.write(`  ! skipped ${skippedIds.length} ${label} (ids: ${skippedIds.slice(0, 10).join(",")}${skippedIds.length > 10 ? "..." : ""})\n`);
    }
  }

  return { done, failed, elapsed: Date.now() - startTime };
}

export async function runEmbed(
  db: TraulDB,
  options: { limit?: string; quiet?: boolean; rechunk?: boolean; onProgress?: (pct: number, eta: string | null) => void }
): Promise<void> {
  const parsed = options.limit ? parseInt(options.limit, 10) : 500;
  const batchLimit = parsed === 0 ? 999999 : parsed;

  // Rechunk: find long messages embedded whole (pre-chunking) and convert them to chunks
  if (options.rechunk) {
    const unchunked = await db.getUnchunkedLongMessages(CHUNK_THRESHOLD, batchLimit);
    for (const msg of unchunked) {
      await db.deleteMessageEmbedding(msg.id);
      const chunks = chunkText(msg.content);
      await db.replaceChunks(msg.id, chunks);
    }
    if (!options.quiet) {
      console.log(`Rechunked ${unchunked.length} long messages into chunks.`);
    }
  }

  const orphanedChunksData = await db.deleteOrphanedChunks();
  const orphaned = await db.deleteOrphanedEmbeddings();
  const orphanedChunks = await db.deleteOrphanedChunkEmbeddings();
  if (!options.quiet && (orphanedChunksData > 0 || orphaned > 0 || orphanedChunks > 0)) {
    console.log(`Cleaned ${orphanedChunksData} orphaned chunks, ${orphaned} orphaned message embeddings, ${orphanedChunks} orphaned chunk embeddings.`);
  }

  const stats = await db.getEmbeddingStats();
  const chunkStats = await db.getChunkEmbeddingStats();

  if (!options.quiet) {
    console.log(`Embeddings: ${stats.embedded_messages}/${stats.total_messages} messages, ${chunkStats.embedded_chunks}/${chunkStats.total_chunks} chunks`);
  }

  // Shared budget: messages first, then chunks with whatever remains
  let remaining = batchLimit;
  let doneTotal = 0;
  const embedStart = Date.now();

  // Embed messages — chunk long ones on the fly before each batch
  const messages = await db.getUnembeddedMessages(remaining);
  const preCheckChunks = await db.getUnembeddedChunks(1);
  const totalItems = messages.length + Math.min(remaining - messages.length, preCheckChunks.length > 0 ? remaining - messages.length : 0);

  function reportProgress() {
    if (!options.onProgress || totalItems === 0) return;
    const pct = Math.round((doneTotal / Math.max(totalItems, doneTotal)) * 100);
    const elapsed = Date.now() - embedStart;
    const msPerItem = elapsed / (doneTotal || 1);
    const left = Math.max(totalItems, doneTotal) - doneTotal;
    const etaMs = Date.now() + msPerItem * left;
    options.onProgress(pct, new Date(etaMs).toISOString());
  }

  if (messages.length > 0) {
    const r = await embedItems(
      messages,
      async (id, emb) => { await db.insertEmbedding(id, emb); },
      "messages",
      !!options.quiet,
      async (id, content) => {
        const chunks = chunkText(content);
        await db.replaceChunks(id, chunks);
      },
      (done, failed) => { doneTotal = done + failed; reportProgress(); },
    );
    remaining -= r.done + r.failed;
    doneTotal = r.done + r.failed;
    reportProgress();
    if (!options.quiet) {
      console.log(`Messages: ${r.done} embedded, ${r.failed} failed in ${formatDuration(r.elapsed)}.`);
    }
  } else if (!options.quiet) {
    console.log("All messages already embedded.");
  }

  // Embed chunks with remaining budget (re-fetch since chunking may have created new ones)
  if (remaining > 0) {
    const chunks = await db.getUnembeddedChunks(remaining);
    if (chunks.length > 0) {
      const msgDone = doneTotal;
      const r = await embedItems(
        chunks,
        async (id, emb) => { await db.insertChunkEmbedding(id, emb); },
        "chunks",
        !!options.quiet,
        undefined,
        (done, failed) => { doneTotal = msgDone + done + failed; reportProgress(); },
      );
      doneTotal = msgDone + r.done + r.failed;
      reportProgress();
      if (!options.quiet) {
        console.log(`Chunks: ${r.done} embedded, ${r.failed} failed in ${formatDuration(r.elapsed)}.`);
      }
    } else if (!options.quiet) {
      console.log("All chunks already embedded.");
    }
  }

  if (!options.quiet) {
    const updated = await db.getEmbeddingStats();
    const updatedChunks = await db.getChunkEmbeddingStats();
    console.log(`Total: ${updated.embedded_messages}/${updated.total_messages} messages, ${updatedChunks.embedded_chunks}/${updatedChunks.total_chunks} chunks`);
  }
}

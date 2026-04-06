import { createClient } from "@libsql/client";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "traul-bench-"));
const dbPath = join(dir, "bench.db");

console.log(`DB path: ${dbPath}`);

const db = createClient({ url: `file://${dbPath}` });

const DIM = 1024;
const TOTAL = 10_000; // Start with 10K to keep it fast
const K = 20;
const RUNS = 5;
const BATCH = 500;

function randomVec(): number[] {
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) v[i] = Math.random() * 2 - 1;
  return Array.from(v);
}

function vecToBlob(v: number[]): Buffer {
  const buf = Buffer.alloc(DIM * 4);
  for (let i = 0; i < DIM; i++) buf.writeFloatLE(v[i], i * 4);
  return buf;
}

// --- Setup: table with DiskANN index ---
console.log("Creating table with DiskANN index...");
await db.execute(`CREATE TABLE test_msgs (id INTEGER PRIMARY KEY, embedding F32_BLOB(${DIM}))`);
await db.execute(`CREATE INDEX idx_test ON test_msgs(libsql_vector_idx(embedding, 'metric=cosine'))`);

console.log(`Inserting ${TOTAL} vectors...`);
for (let batch = 0; batch < TOTAL; batch += BATCH) {
  const stmts = [];
  for (let i = 0; i < BATCH && batch + i < TOTAL; i++) {
    const vec = randomVec();
    stmts.push({
      sql: "INSERT INTO test_msgs (id, embedding) VALUES (?, vector32(?))",
      args: [batch + i, vecToBlob(vec) as any],
    });
  }
  await db.batch(stmts);
  if ((batch + BATCH) % 2000 === 0) process.stdout.write(`  ${batch + BATCH}/${TOTAL}\n`);
}
console.log(`  Done inserting ${TOTAL} vectors.\n`);

const queryVec = vecToBlob(randomVec());

// --- Benchmark: DiskANN ---
console.log(`=== DiskANN vector_top_k (${TOTAL} vectors, top ${K}) ===`);
const diskannTimes: number[] = [];
for (let i = 0; i < RUNS; i++) {
  const start = performance.now();
  const result = await db.execute({
    sql: `SELECT v.id FROM vector_top_k('idx_test', vector32(?), ?) AS v`,
    args: [queryVec as any, K],
  });
  const elapsed = performance.now() - start;
  diskannTimes.push(elapsed);
  if (i === 0) console.log(`  Results: ${result.rows.length} rows`);
}
const avgDiskann = diskannTimes.reduce((a, b) => a + b) / RUNS;
console.log(`  Times: ${diskannTimes.map((t) => t.toFixed(1) + "ms").join(", ")}`);
console.log(`  Average: ${avgDiskann.toFixed(1)}ms\n`);

// --- Benchmark: Brute-force ---
console.log(`=== Brute-force vector_distance_cos (${TOTAL} vectors, top ${K}) ===`);
const bruteTimes: number[] = [];
for (let i = 0; i < RUNS; i++) {
  const start = performance.now();
  const result = await db.execute({
    sql: `SELECT id, vector_distance_cos(embedding, vector32(?)) as dist
          FROM test_msgs
          ORDER BY dist ASC
          LIMIT ?`,
    args: [queryVec as any, K],
  });
  const elapsed = performance.now() - start;
  bruteTimes.push(elapsed);
  if (i === 0) console.log(`  Results: ${result.rows.length} rows`);
}
const avgBrute = bruteTimes.reduce((a, b) => a + b) / RUNS;
console.log(`  Times: ${bruteTimes.map((t) => t.toFixed(1) + "ms").join(", ")}`);
console.log(`  Average: ${avgBrute.toFixed(1)}ms\n`);

// --- Check DB size ---
const { rows } = await db.execute("PRAGMA page_size");
const { rows: rows2 } = await db.execute("PRAGMA page_count");
const sizeBytes = Number(rows[0].page_size) * Number(rows2[0].page_count);
const sizeMB = (sizeBytes / 1024 / 1024).toFixed(1);

console.log("=== Summary ===");
console.log(`  DiskANN:     ${avgDiskann.toFixed(1)}ms avg`);
console.log(`  Brute-force: ${avgBrute.toFixed(1)}ms avg`);
console.log(`  Speedup:     ${(avgBrute / avgDiskann).toFixed(1)}x`);
console.log(`  DB size:     ${sizeMB} MB for ${TOTAL} vectors`);
console.log(`  Projected at 140K: ~${((sizeBytes / TOTAL) * 140000 / 1024 / 1024 / 1024).toFixed(1)} GB`);

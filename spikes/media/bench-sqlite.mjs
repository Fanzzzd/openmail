import { DatabaseSync } from "node:sqlite";
import { getLoadablePath } from "sqlite-vec";
import { performance } from "node:perf_hooks";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL(".", import.meta.url));
export function benchmark(runtime = "node") {
  const path = resolve(root, `artifacts/vec-${runtime}.sqlite`);
  mkdirSync(resolve(root, "artifacts"), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
  const db = new DatabaseSync(path, { allowExtension: true });
  const extension = getLoadablePath();
  let start = performance.now();
  db.loadExtension(extension);
  const loadMs = performance.now() - start;
  db.enableLoadExtension(false);
  const versions = db.prepare("SELECT sqlite_version() AS sqlite, vec_version() AS vec").get();
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE VIRTUAL TABLE vectors USING vec0(embedding float[384]);",
  );
  let seed = 0x12345678;
  function random() {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  }
  function vector() {
    const v = Float32Array.from({ length: 384 }, () => random() * 2 - 1);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return v.map((x) => x / norm);
  }
  const vectors = Array.from({ length: 10000 }, vector);
  const insert = db.prepare("INSERT INTO vectors(rowid, embedding) VALUES (?, ?)");
  start = performance.now();
  db.exec("BEGIN");
  for (let i = 0; i < vectors.length; i++)
    insert.run(BigInt(i + 1), new Uint8Array(vectors[i].buffer));
  db.exec("COMMIT");
  const insertMs = performance.now() - start;
  const knn = db.prepare(
    "SELECT rowid, distance FROM vectors WHERE embedding MATCH ? AND k = 10 ORDER BY distance",
  );
  const times = [];
  let firstRows;
  for (let i = 0; i < 51; i++) {
    const q = i === 0 ? vectors[0] : vector();
    start = performance.now();
    const rows = knn.all(new Uint8Array(q.buffer));
    times.push(performance.now() - start);
    assert.equal(rows.length, 10);
    if (i === 0) firstRows = rows;
  }
  assert.equal(firstRows[0].rowid, 1);
  assert.equal(firstRows[0].distance, 0);
  const brute = vectors
    .map((v, i) => ({ id: i + 1, d: v.reduce((s, x, j) => s + (x - vectors[0][j]) ** 2, 0) }))
    .toSorted((a, b) => a.d - b.d)
    .slice(0, 10)
    .map((x) => x.id);
  assert.deepEqual(
    firstRows.map((x) => x.rowid),
    brute,
  );
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  const sorted = times.slice(1).toSorted((a, b) => a - b);
  const result = {
    runtime,
    versions: {
      node: process.versions.node,
      electron: Object.entries(process.versions).find(([name]) => name === "electron")?.[1] ?? null,
      ...versions,
    },
    arch: process.arch,
    rows: 10000,
    dimensions: 384,
    k: 10,
    query_count: 51,
    extension_bytes: statSync(extension).size,
    load_ms: loadMs,
    insert_ms: insertMs,
    first_query_ms: times[0],
    warm_median_ms: sorted[25],
    warm_p95_ms: sorted[47],
    database_bytes: statSync(path).size,
    exact_top10_verified: true,
    query_ms: times,
  };
  writeFileSync(
    resolve(root, `artifacts/sqlite-${runtime}.json`),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  console.log(JSON.stringify(result));
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) benchmark();

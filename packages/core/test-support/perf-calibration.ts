import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * A fixed amount of work timed on this machine, so perf numbers from different runners can be
 * compared. `cpuMs` is a pure JavaScript loop; `sqliteMs` inserts a fixed set of rows into an
 * indexed table on a temporary file database. `ratio` is the geometric mean of both times over
 * the reference machine's (an Apple M3 Max laptop on Node 24), so 2 means this machine ran the
 * fixed work twice as slowly. docs/performance.md explains how to read it.
 */
export interface PerfCalibration {
  readonly cpuMs: number;
  readonly sqliteMs: number;
  readonly referenceCpuMs: number;
  readonly referenceSqliteMs: number;
  readonly ratio: number;
}

const REFERENCE_CPU_MS = 33;
const REFERENCE_SQLITE_MS = 35;

const median = (samples: number[]) => samples.toSorted((a, b) => a - b)[samples.length >> 1] ?? 0;

const cpuLoop = () => {
  const start = performance.now();
  let hash = 2166136261;
  for (let i = 0; i < 30_000_000; i++) hash = Math.imul(hash ^ (i & 0xff), 16777619) >>> 0;
  const ms = performance.now() - start;
  // Keeps the loop from being optimized away.
  if (hash === 0.5) throw new Error("unreachable");
  return ms;
};

const sqliteLoop = (directory: string, round: number) => {
  const db = new DatabaseSync(join(directory, `calibration-${round}.db`));
  try {
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE rows(id INTEGER PRIMARY KEY, key TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX rows_key ON rows(key);`);
    const insert = db.prepare("INSERT INTO rows(key,body) VALUES(?,?)");
    const body = "Project update and delivery schedule. ".repeat(8);
    const start = performance.now();
    for (let batch = 0; batch < 10; batch++) {
      db.exec("BEGIN");
      for (let i = 0; i < 2_000; i++) insert.run(`key${(batch * 2_000 + i) * 7919}`, body);
      db.exec("COMMIT");
    }
    return performance.now() - start;
  } finally {
    db.close();
  }
};

let cached: PerfCalibration | undefined;

/** Measures once per process; later calls return the same numbers. */
export const perfCalibration = (): PerfCalibration => {
  if (cached) return cached;
  const directory = mkdtempSync(join(tmpdir(), "openmail-calibration-"));
  try {
    const cpuMs = median([cpuLoop(), cpuLoop(), cpuLoop()]);
    const sqliteMs = median([0, 1, 2].map((round) => sqliteLoop(directory, round)));
    cached = {
      cpuMs,
      sqliteMs,
      referenceCpuMs: REFERENCE_CPU_MS,
      referenceSqliteMs: REFERENCE_SQLITE_MS,
      ratio: Math.sqrt((cpuMs / REFERENCE_CPU_MS) * (sqliteMs / REFERENCE_SQLITE_MS)),
    };
    return cached;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

/** `ms` as the reference machine would have taken, by the calibration ratio. */
export const calibratedMs = (ms: number) => ms / perfCalibration().ratio;

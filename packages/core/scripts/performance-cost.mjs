// Local-only, committed-transaction comparison. Build core first; no Electron or user database.
import { DatabaseSync } from "node:sqlite";
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { MIGRATIONS, splitStatements } from "../dist/db.js";
import { StoreLive } from "../dist/store.js";
import { Store } from "../dist/services.js";
import { NodeRuntime } from "../dist/platform/node/runtime.js";
import {
  fixtureAccounts,
  fixtureMessage,
  seedMailbox,
} from "../dist/platform/node/fixtures/performance-mailbox.js";

if (process.env.OPENMAIL_PERF !== "1")
  throw new Error("Set OPENMAIL_PERF=1 to generate the 100k fixture.");
const baselineRef = execFileSync(
  "git",
  ["rev-parse", process.env.OPENMAIL_PERF_BASELINE_REF ?? "main"],
  { encoding: "utf8" },
).trim();
const directory = mkdtempSync(join(tmpdir(), "openmail-perf-cost-"));
const baseline = join(directory, "baseline.db");
const upgraded = join(directory, "upgraded.db");
const output = process.env.OPENMAIL_PERF_COST_REPORT ?? "/tmp/openmail-cost.json";

const report = {
  sqlite: {
    synchronous: "FULL",
    walAutocheckpoint: 1000,
    journalSizeLimit: 8388608,
    cacheKiB: 8192,
  },
  node: process.version,
  baselineRef,
  messages: 100000,
  results: [],
};
const log = (value) => process.stdout.write(`${value}\n`);
const bytes = (name) => {
  try {
    return statSync(name).size;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
};
const size = (file) => {
  const dbBytes = bytes(file),
    walBytes = bytes(`${file}-wal`);
  return { dbBytes, walBytes, totalBytes: dbBytes + walBytes };
};
const layer = (file) =>
  StoreLive.pipe(
    Layer.provideMerge(Layer.mergeAll(SqliteClient.layer({ filename: file }), NodeRuntime)),
  );
const summarize = (samples) => {
  const sorted = samples.toSorted((a, b) => a - b);
  return {
    medianMs: sorted[Math.floor(sorted.length / 2)],
    maxMs: sorted.at(-1),
    samplesMs: samples,
  };
};
const configure = (db) =>
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA cache_size=-8192; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=1000; PRAGMA journal_size_limit=8388608",
  );
const migrate35 = (file) => {
  const db = new DatabaseSync(file);
  configure(db);
  const start = performance.now();
  db.exec("BEGIN IMMEDIATE");
  for (const statement of splitStatements(MIGRATIONS[34])) db.exec(statement);
  db.exec("PRAGMA user_version=35; COMMIT");
  const ms = performance.now() - start;
  const afterCommit = size(file);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const afterCheckpoint = size(file);
  const indexes = db
    .prepare(
      "SELECT name, SUM(pgsize) AS bytes FROM dbstat WHERE name IN (SELECT name FROM sqlite_master WHERE type='index') GROUP BY name ORDER BY bytes DESC",
    )
    .all();
  db.exec("ANALYZE; PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  return { ms, afterCommit, afterCheckpoint, indexes };
};
const accountFor = (message) => fixtureAccounts[Number(message.threadId.slice(6)) % 3];
const batch = (store, start, count, step = 1) =>
  store.transaction(
    Effect.gen(function* () {
      for (let offset = 0; offset < count; offset++) {
        const message = fixtureMessage(start + offset * step, true);
        yield* store.upsertMessage(accountFor(message), message);
      }
    }),
  );
const operations = (store) => [
  ["1000 new messages", batch(store, 100000, 1000)],
  ["1000 unchanged upserts", batch(store, 0, 1000, 97)],
  [
    "100 message label change",
    store.transaction(
      Effect.gen(function* () {
        for (let offset = 0; offset < 100; offset++) {
          const message = fixtureMessage(offset * 997, true);
          yield* store.applyLocalOp(`${accountFor(message)}/${message.providerId}`, {
            kind: "label",
            labelId: "Folder_cost",
            value: true,
          });
        }
      }),
    ),
  ],
];

try {
  // Verify that the baseline schema is exactly main's first 34 migrations.
  const mainDb = execFileSync("git", ["show", `${baselineRef}:packages/core/src/db.ts`], {
    encoding: "utf8",
  });
  const { default: ts } = await import("typescript");
  // The three timed write methods are unchanged between main and this branch.
  // Check that before using the current Store against both schema versions.
  const writeNames = ["upsertMessage", "applyLocalOp", "messageIdForProvider"];
  const declarations = (source) => {
    const file = ts.createSourceFile("store.ts", source, ts.ScriptTarget.ES2023, true);
    const found = new Map();
    const printer = ts.createPrinter();
    const visit = (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        writeNames.includes(node.name.text) &&
        node.initializer
      )
        found.set(
          node.name.text,
          printer.printNode(ts.EmitHint.Unspecified, node.initializer, file),
        );
      ts.forEachChild(node, visit);
    };
    visit(file);
    return found;
  };
  const mainWrites = declarations(
    execFileSync("git", ["show", `${baselineRef}:packages/core/src/store.ts`], {
      encoding: "utf8",
    }),
  );
  const currentWrites = declarations(
    readFileSync(new URL("../src/store/store.ts", import.meta.url), "utf8"),
  );
  for (const name of writeNames)
    if (!mainWrites.has(name) || mainWrites.get(name) !== currentWrites.get(name))
      throw new Error(`Historical write implementation differs: ${name}`);
  const historical = join(directory, "historical.mjs");
  // The source prefix is compared without evaluating any Effect platform services.
  const prefixEnd = mainDb.indexOf("/**\n * Splits a migration");
  const literal = mainDb.slice(mainDb.indexOf("export const MIGRATIONS"), prefixEnd);
  writeFileSync(
    historical,
    ts.transpileModule(literal, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 },
    }).outputText,
  );
  const { MIGRATIONS: mainMigrations } = await import(historical);
  if (
    mainMigrations.length !== 34 ||
    JSON.stringify(mainMigrations) !== JSON.stringify(MIGRATIONS.slice(0, 34))
  )
    throw new Error("Baseline must have migration 34 and an identical migration prefix.");
  const initial = new DatabaseSync(baseline);
  configure(initial);
  for (const migration of mainMigrations) initial.exec(migration);
  // A temporary seed-only index avoids the unanalysed provider lookup hotspot.
  // It is removed before any timed work, VACUUM, ANALYZE or size comparison.
  initial.exec(
    "CREATE INDEX performance_seed_provider ON messages(account_id,provider_id,date DESC,id); PRAGMA user_version=34",
  );
  initial.close();
  const seedStart = performance.now();
  await Effect.runPromise(seedMailbox(100000).pipe(Effect.provide(layer(baseline)), Effect.scoped));
  report.seedMs = performance.now() - seedStart;
  const db = new DatabaseSync(baseline);
  configure(db);
  db.exec("DROP INDEX performance_seed_provider; VACUUM; ANALYZE; PRAGMA wal_checkpoint(TRUNCATE)");
  db.exec(
    "INSERT INTO messages_fts(messages_fts,rank) VALUES('integrity-check',1); INSERT INTO messages_words(messages_words,rank) VALUES('integrity-check',1)",
  );
  report.baselineSize = size(baseline);
  db.close();
  log(`Baseline size: ${(report.baselineSize.totalBytes / 1048576).toFixed(2)} MiB`);
  const upgrades = [];
  for (let iteration = 0; iteration < 3; iteration++) {
    const file = join(directory, `upgrade${iteration}.db`);
    cpSync(baseline, file);
    const result = migrate35(file);
    upgrades.push(result.ms);
    if (iteration === 0) {
      report.upgradeSize = result.afterCommit;
      report.upgradedSize = result.afterCheckpoint;
      report.indexes = result.indexes;
      cpSync(file, upgraded);
    }
    rmSync(file, { force: true });
  }
  report.upgrade = summarize(upgrades);
  log(
    `Migration 35: ${report.upgrade.medianMs.toFixed(2)} ms; DB+WAL before explicit truncate ${(report.upgradeSize.totalBytes / 1048576).toFixed(2)} MiB, after ${(report.upgradedSize.totalBytes / 1048576).toFixed(2)} MiB`,
  );
  for (const [version, fixture] of [
    [34, baseline],
    [35, upgraded],
  ]) {
    const results = [];
    // Each sample starts from the same 100k snapshot, with a fresh WAL and warmed reads.
    for (let operation = 0; operation < 3; operation++) {
      const times = [],
        sizes = [];
      let name;
      for (let iteration = 0; iteration < 6; iteration++) {
        const file = join(directory, "sample.db");
        cpSync(fixture, file);
        await Effect.runPromise(
          Effect.gen(function* () {
            const store = yield* Store,
              sql = yield* SqlClient.SqlClient;
            yield* sql`PRAGMA cache_size=-8192`;
            yield* sql`PRAGMA synchronous=FULL`;
            yield* sql`PRAGMA journal_size_limit=8388608`;
            yield* sql`PRAGMA wal_autocheckpoint=1000`;
            yield* sql`PRAGMA foreign_keys=ON`;
            // Warm one bounded lookup and SQLite's schema/statement cache outside timing.
            yield* store.messageIdForProvider(fixtureAccounts[0], "m0");
            const [operationName, effect] = operations(store)[operation];
            name = operationName;
            const start = performance.now();
            yield* effect;
            const ms = performance.now() - start;
            if (iteration) {
              times.push(ms);
              sizes.push(size(file));
            }
            if (operation === 1) {
              const [changes] = yield* sql`SELECT total_changes() AS n`;
              if (changes.n !== 0)
                throw new Error("Unchanged upserts must not update rows or indexes.");
            }
            yield* sql`INSERT INTO messages_fts(messages_fts,rank) VALUES('integrity-check',1)`;
            yield* sql`INSERT INTO messages_words(messages_words,rank) VALUES('integrity-check',1)`;
          }).pipe(Effect.provide(layer(file)), Effect.scoped),
        );
        for (const suffix of ["", "-wal", "-shm"]) rmSync(`${file}${suffix}`, { force: true });
      }
      results.push({ name, ...summarize(times), size: sizes[2], sizeSamples: sizes });
      log(`v${version} ${name}: ${results.at(-1).medianMs.toFixed(2)} ms`);
    }
    report.results.push({ version, results });
  }
  report.writeChanges = report.results[0].results.map((before, i) => ({
    name: before.name,
    percent: (report.results[1].results[i].medianMs / before.medianMs - 1) * 100,
  }));
  report.sizeChangePercent =
    (report.upgradeSize.totalBytes / report.baselineSize.totalBytes - 1) * 100;
  report.checkpointedSizeChangePercent =
    (report.upgradedSize.totalBytes / report.baselineSize.totalBytes - 1) * 100;
  report.writeSizeChanges = report.results[0].results.map((before, i) => ({
    name: before.name,
    percent: (report.results[1].results[i].size.totalBytes / before.size.totalBytes - 1) * 100,
  }));
  report.withinBudgets =
    report.writeChanges.every((result) => result.percent <= 25) &&
    report.sizeChangePercent <= 15 &&
    report.checkpointedSizeChangePercent <= 15 &&
    report.writeSizeChanges.every((result) => result.percent <= 15);
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  log(
    `Write changes: ${JSON.stringify(report.writeChanges)}; size change ${report.sizeChangePercent.toFixed(2)}%, checkpointed ${report.checkpointedSizeChangePercent.toFixed(2)}%; report ${output}`,
  );
  if (!report.withinBudgets)
    throw new Error("Migration 35 exceeds the 25% write or 15% DB+WAL growth budget.");
} finally {
  rmSync(directory, { recursive: true, force: true });
}

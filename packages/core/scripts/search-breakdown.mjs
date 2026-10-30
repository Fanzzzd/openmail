// Times local searches step by step on a database file, as the desktop list runs them (200 rows).
// Build core first. The database is opened read-only; pass a copy, never the live mail profile.
//
//   node packages/core/scripts/search-breakdown.mjs /tmp/copy/mail.db "the" "re*" "meeting" ...
//
// Each query runs on a fresh Store, so the first run is the first search after launch: SQLite's
// page cache is warm from earlier queries, but no visible text is cached. Then four more runs.
// OPENMAIL_BREAKDOWN_FRESH=1 creates a fresh Store for every run and reports their median.
// OPENMAIL_BREAKDOWN_RUNS changes the run count. OPENMAIL_BREAKDOWN_SCOPE=folder searches the
// Inbox only, as the field's "Current folder" scope does; the default searches All Mail.
import { Effect, Layer } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { StoreLive } from "../dist/store/store.js";
import { Store } from "../dist/store/service.js";
import { NodeRuntime } from "../dist/platform/node/runtime.js";
import { SearchProfile } from "../dist/search/search-profile.js";

const [file, ...queries] = process.argv.slice(2);
if (!file || !queries.length) throw new Error("Usage: search-breakdown.mjs <mail.db> <query>...");
const runs = Number(process.env.OPENMAIL_BREAKDOWN_RUNS ?? 6);
const scope =
  process.env.OPENMAIL_BREAKDOWN_SCOPE === "folder"
    ? { mailbox: "inbox", searchScope: "folder" }
    : { mailbox: "all" };
const limit = Number(process.env.OPENMAIL_BREAKDOWN_LIMIT ?? 200);
const fresh = process.env.OPENMAIL_BREAKDOWN_FRESH === "1";

// OPENMAIL_BREAKDOWN_SQL=1 prints every statement over 50 ms with its time.
if (process.env.OPENMAIL_BREAKDOWN_SQL === "1") {
  const { StatementSync } = await import("node:sqlite");
  for (const method of ["all", "get", "run", "iterate"]) {
    const original = StatementSync.prototype[method];
    StatementSync.prototype[method] = function (...args) {
      const start = performance.now();
      try {
        return original.apply(this, args);
      } finally {
        const ms = performance.now() - start;
        if (ms > 50)
          process.stderr.write(
            `SQL ${Math.round(ms)} ms: ${this.sourceSQL.replace(/\s+/g, " ").slice(0, 3000)}\n`,
          );
      }
    };
  }
}

const median = (xs) => {
  const s = xs.toSorted((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

const layer = () =>
  StoreLive.pipe(
    Layer.provideMerge(SqliteClient.layer({ filename: file, readonly: true })),
    Layer.provideMerge(NodeRuntime),
  );

const out = [];
for (const search of queries) {
  const samples = [];
  for (let lifetime = 0; lifetime < (fresh ? runs : 1); lifetime++)
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store;
        for (let i = 0; i < (fresh ? 1 : runs); i++) {
          const steps = new Map();
          const stack = [];
          const begin = (step) => {
            const frame = { step, start: performance.now(), child: 0 };
            stack.push(frame);
            return () => {
              const ms = performance.now() - frame.start;
              stack.pop();
              const parent = stack.at(-1);
              if (parent) parent.child += ms;
              steps.set(step, (steps.get(step) ?? 0) + ms - frame.child);
            };
          };
          const cpu = process.cpuUsage();
          const t0 = performance.now();
          const rows = yield* store
            .listThreads({ search, ...scope, limit })
            .pipe(Effect.provideService(SearchProfile, { begin }));
          const ms = performance.now() - t0;
          const used = process.cpuUsage(cpu);
          const bytes = JSON.stringify(rows).length;
          const countStart = performance.now();
          const count = yield* store.countThreads({ search, ...scope });
          const countMs = performance.now() - countStart;
          samples.push({
            ms,
            count,
            countMs,
            cpuMs: (used.user + used.system) / 1000,
            rows: rows.length,
            bytes,
            steps: Object.fromEntries(steps),
          });
        }
      }).pipe(Effect.provide(layer()), Effect.scoped),
    );
  const [first, ...warm] = samples;
  const stepNames = [...new Set(samples.flatMap((s) => Object.keys(s.steps)))];
  const row = {
    search,
    rows: first.rows,
    kb: Math.round(first.bytes / 1024),
    count: first.count,
    countMs: Math.round(median(samples.map((s) => s.countMs))),
    firstMs: Math.round(fresh ? median(samples.map((s) => s.ms)) : first.ms),
    warmMs: fresh ? null : Math.round(median(warm.map((s) => s.ms))),
    firstSteps: Object.fromEntries(
      stepNames
        .map((n) => [
          n,
          Math.round(fresh ? median(samples.map((s) => s.steps[n] ?? 0)) : (first.steps[n] ?? 0)),
        ])
        .filter(([, v]) => v >= 2)
        .toSorted((a, b) => b[1] - a[1]),
    ),
    warmSteps: Object.fromEntries(
      stepNames
        .map((n) => [n, Math.round(median(warm.map((s) => s.steps[n] ?? 0)))])
        .filter(([, v]) => v >= 2)
        .toSorted((a, b) => b[1] - a[1]),
    ),
  };
  out.push(row);
  process.stdout.write(`${JSON.stringify(row)}\n`);
}
if (process.env.OPENMAIL_BREAKDOWN_OUT)
  (await import("node:fs")).writeFileSync(
    process.env.OPENMAIL_BREAKDOWN_OUT,
    JSON.stringify(out, null, 2),
  );

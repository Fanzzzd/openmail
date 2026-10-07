import { applyNativeMigration } from "../dist/platform/node/migrations.js";
const log = (value) => process.stdout.write(`${value}\n`);
// Node-only benchmark. Never opens a user database or starts Electron.
// Build core first, then run with --expose-gc and OPENMAIL_LOW_MEMORY_TESTS=1.
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Store } from "../dist/services.js";

const historical = process.env.OPENMAIL_PERF_BASELINE_REF;
let directory;
let historicalDirectory;
// oxlint-disable-next-line typescript/unbound-method
const originalPrepare = DatabaseSync.prototype.prepare;
try {
  let moduleRoot = new URL("../dist/", import.meta.url);
  if (historical) {
    // Share dependencies; read historical SQL modules without changing checkout.
    const dist = fileURLToPath(moduleRoot);
    historicalDirectory = mkdtempSync(join(dist, "performance-before-"));
    for (const entry of readdirSync(dist, { withFileTypes: true }))
      if (entry.isFile())
        symlinkSync(join(dist, entry.name), join(historicalDirectory, entry.name));
    const { default: ts } = await import("typescript");
    for (const name of ["db", "store", "store-compose", "store-contacts", "store-invite-status"]) {
      const source = execFileSync("git", ["show", `${historical}:packages/core/src/${name}.ts`], {
        encoding: "utf8",
      });
      const output = join(historicalDirectory, `${name}.js`);
      rmSync(output);
      writeFileSync(
        output,
        ts.transpileModule(source, {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 },
        }).outputText,
      );
    }
    moduleRoot = new URL(`../dist/${historicalDirectory.split("/").at(-1)}/`, import.meta.url);
  }
  const { MIGRATIONS, migrate } = await import(new URL("db.js", moduleRoot));
  const { StoreLive } = await import(new URL("store.js", moduleRoot));

  directory = mkdtempSync(join(tmpdir(), "openmail-perf-"));
  const file = join(directory, "mail.db");
  const report = {
    node: process.version,
    baselineRef: historical ?? null,
    messages: 150000,
    accounts: 3,
    results: [],
  };
  const now = Date.parse("2026-10-03T12:00:00Z");
  const dateOf = (i) => now - Math.floor(i / 3) * 600000;
  const message = (i) => ({
    providerId: `m${i}`,
    threadId: `t${Math.floor(i / 9)}`,
    subject: `Project ${i % 101} ${i % 1000 === 0 ? "预算批准 nebula" : "weekly report"}`,
    from: { address: `person${i % 3000}@example.com`, name: `Person ${i % 3000}` },
    to: [{ address: `recipient${i % 1000}@example.com`, name: `Recipient ${i % 1000}` }],
    cc: [],
    date: dateOf(i),
    snippet: "Weekly project update",
    bodyText: `Project update with delivery schedule ${"The next review is scheduled for Monday. ".repeat(12)} ${i % 1000 === 0 ? "预算批准 nebula" : ""}`,
    bodyHtml: `<p>${"Project update. ".repeat(25)}</p>`,
    labels: [
      i % 10 === 0 ? "SENT" : i % 31 === 0 ? "TRASH" : "INBOX",
      `Label_${i % 20}`,
      ...(i % 5 === 0 ? ["UNREAD"] : []),
      ...(i % 17 === 0 ? ["STARRED"] : []),
    ],
    attachments:
      i % 10 === 0
        ? [{ id: `a${i}`, filename: "report.pdf", mimeType: "application/pdf", size: 32768 }]
        : [],
    isUnread: i % 5 === 0,
    isStarred: i % 17 === 0,
    rfcMessageId: `<m${i}@example.com>`,
    size: 2048,
  });

  // Trace the actual SQL emitted by Store, including statements from cached prepares.
  // Calls below supply the owning connection explicitly and restore this hook.
  let capture;
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = originalPrepare.call(this, sql);
    for (const method of ["all", "get", "run"]) {
      const original = statement[method];
      statement[method] = (...params) => {
        if (capture && !capture.has(sql)) {
          const plan = originalPrepare.call(this, `EXPLAIN QUERY PLAN ${sql}`).all(...params);
          capture.set(sql, { sql, plan: plan.map((row) => row.detail) });
        }
        return original.apply(statement, params);
      };
    }
    return statement;
  };

  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA cache_size=-8192");
    for (const migration of MIGRATIONS.slice(0, 26)) applyNativeMigration(db, migration);
    db.exec("PRAGMA user_version=26");
  } finally {
    db.close();
  }
  const layer = StoreLive.pipe(Layer.provideMerge(SqliteClient.layer({ filename: file })));
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA cache_size=-8192`;
      yield* sql`PRAGMA foreign_keys=ON`;
      for (let a = 0; a < 3; a++) {
        yield* store.upsertAccount("gmail", `a${a}@example.com`);
        yield* store.replaceLabels(
          `gmail:a${a}@example.com`,
          Array.from({ length: 20 }, (_, i) => ({
            id: `Label_${i}`,
            name: `Project ${i}`,
            color: null,
          })),
        );
      }
      const seedStart = performance.now();
      for (let start = 0; start < 150000; start += 500) {
        yield* store.transaction(
          Effect.gen(function* () {
            for (let i = start; i < start + 500; i++)
              yield* store.upsertMessage(`gmail:a${i % 3}@example.com`, message(i));
          }),
        );
        if (start % 15000 === 0) log(`Seeded ${start + 500}/150000`);
      }
      report.seedMs = performance.now() - seedStart;
      const migrationStart = performance.now();
      yield* migrate;
      report.indexUpgradeMs = performance.now() - migrationStart;
      yield* sql`INSERT INTO thread_reminders(account_id,thread_id,due_at) SELECT account_id,thread_id,${now + 86400000} FROM messages WHERE rowid%500=0 GROUP BY account_id,thread_id`;
      // Include server candidates alongside incoming and sent projections.
      for (let a = 0; a < 3; a++)
        yield* store.replaceServerContacts(
          `gmail:a${a}@example.com`,
          Array.from({ length: 1000 }, (_, i) => ({
            name: `Person ${i}`,
            address: `person${i}@example.com`,
            ...(MIGRATIONS.length >= 28 ? { company: `Acme Division ${i % 20}` } : {}),
          })),
          now,
        );
      yield* store.transaction(
        Effect.gen(function* () {
          for (let i = 0; i < 1000; i++)
            yield* store.recordInviteResponse({
              accountId: "gmail:a0@example.com",
              uid: `event-${i}`,
              organizer: "organizer@example.com",
              recurrenceId: "",
              sequence: 1,
              address: { name: "Me", address: "a0@example.com" },
              response: "accepted",
            });
          if (MIGRATIONS.length >= 27) {
            for (let i = 0; i < 1500; i++)
              yield* store.cacheInvites(`gmail:a0@example.com/m${i * 99}`, [
                {
                  key: `key-${i}`,
                  uid: `event-${i % 20}`,
                  sequence: Math.floor(i / 20),
                  method: "REQUEST",
                  cancelled: false,
                  title: "Project review",
                  start: { kind: "date", value: "2026-10-03" },
                  end: { kind: "date", value: "2026-10-04" },
                  location: "Office",
                  organizer: { name: "Organizer", address: "organizer@example.com" },
                  attendees: [],
                  recurrence: [],
                  recurrenceId: null,
                },
              ]);
          }
        }),
      );
      yield* sql`ANALYZE`;
      const measure = (name, effect, iterations = 5) =>
        Effect.gen(function* () {
          const times = [];
          const queries = new Map();
          // Warm the statement cache, then capture plans separately from timing.
          capture = queries;
          yield* effect;
          capture = undefined;
          for (let i = 0; i < iterations; i++) {
            const start = performance.now();
            yield* effect;
            times.push(performance.now() - start);
          }
          times.sort((a, b) => a - b);
          const result = {
            name,
            medianMs: times[Math.floor(times.length / 2)],
            maxMs: times.at(-1),
            queries: [...queries.values()],
          };
          report.results.push(result);
          log(`${name}: ${result.medianMs.toFixed(2)} ms`);
        });
      const folder = {
        accountIds: ["gmail:a0@example.com"],
        mailbox: "inbox",
        label: "Label_1",
        limit: 50,
      };
      yield* measure("label first page", store.listThreads(folder));
      const page = yield* store.listThreads(folder);
      const tail = page.at(-1);
      yield* measure(
        "label next page",
        store.listThreads({ ...folder, before: tail?.date, beforeId: tail?.id }),
      );
      yield* measure(
        "label unread",
        store.listThreads({ ...folder, unreadOnly: true, label: "Label_5" }),
      );
      yield* measure("label flat", store.listThreads({ ...folder, flat: true }));
      yield* measure("inbox first page", store.listThreads({ mailbox: "inbox" }));
      yield* measure(
        "thread count",
        store.countThreads({ mailbox: "inbox", accountIds: ["gmail:a0@example.com"] }),
      );
      yield* measure("unread account badges", store.unreadCounts);
      yield* measure("unread label badges", store.unreadByLabel(undefined, undefined, true));
      yield* measure("inbox label badges", store.unreadByLabel(undefined, "INBOX", true));
      yield* measure("FTS trigram", store.listThreads({ search: "预算批准" }));
      yield* measure("word search", store.listThreads({ search: "nebula" }));
      if (!historical) {
        yield* measure("word search common", store.listThreads({ search: "weekly" }));
        yield* measure("search count common", store.countThreads({ search: "weekly" }));
        yield* sql`UPDATE search_word_index SET ready=0 WHERE kind='messages'`;
        yield* measure("FTS trigram common", store.listThreads({ search: "Project" }));
        yield* sql`UPDATE search_word_index SET ready=1 WHERE kind='messages'`;
      }
      yield* measure(
        "Gmail operators",
        store.listThreads({ search: "from:person1 has:attachment is:unread after:2026-09-01" }),
      );
      yield* measure("contacts prefix", store.suggestContacts("person1", 10));
      yield* measure("contacts empty", store.suggestContacts("", 10));
      if (MIGRATIONS.length >= 28)
        yield* measure("contacts company", store.suggestContacts("Acme Division 1", 10));
      yield* measure(
        "sender history",
        store.senderHistory(["recipient0@example.com", "recipient10@example.com"]),
      );
      yield* measure(
        "invite lookup",
        store.findMessageByRfcId("gmail:a0@example.com", "m149997@example.com"),
      );
      yield* measure("reminder scan", store.wakeSnoozed(now));
      yield* measure(
        "invite response lookup",
        store.inviteResponse({
          accountId: "gmail:a0@example.com",
          uid: "event-1",
          organizer: "organizer@example.com",
          recurrenceId: "",
        }),
      );
      if (MIGRATIONS.length >= 27) {
        yield* measure(
          "cached invite history",
          store.cachedInvites("gmail:a0@example.com", "event-1"),
        );
        yield* measure(
          "invite siblings",
          store.inviteSiblingIds("gmail:a0@example.com", "event-1", "gmail:a0@example.com/m99"),
        );
      }
      yield* measure(
        "cache candidates",
        store.backfillCandidates(
          "gmail:a0@example.com",
          Array.from({ length: 100 }, (_, i) => `m${i * 3}`),
        ),
      );
      yield* measure(
        "rule backfill page",
        store.listThreads({
          accountIds: ["gmail:a0@example.com"],
          mailbox: "all",
          search: "from:person1",
          flat: true,
          limit: 100,
        }),
      );
      // Scan the first cache-eviction batch without changing bodies between runs.
      yield* measure(
        "cache eviction scan",
        sql`SELECT id,date,labels_json FROM messages WHERE account_id='gmail:a0@example.com' AND body_cached=1 AND date < ${now - 30 * 86400000} AND (body_opened_at IS NULL OR body_opened_at < ${now - 86400000}) ORDER BY date,id LIMIT 200`,
      );
      let labelValue = false;
      yield* measure(
        "label change",
        Effect.suspend(() => {
          labelValue = !labelValue;
          return store.transaction(
            Effect.gen(function* () {
              for (let i = 0; i < 100; i++)
                yield* store.applyLocalOp(`gmail:a0@example.com/m${i * 3}`, {
                  kind: "label",
                  labelId: "Label_19",
                  value: labelValue,
                });
            }),
          );
        }),
        3,
      );
      let offset = 150000;
      yield* measure(
        "sync 1000 new",
        Effect.suspend(() => {
          const start = offset;
          offset += 1000;
          return store.transaction(
            Effect.gen(function* () {
              for (let i = start; i < start + 1000; i++)
                yield* store.upsertMessage(`gmail:a${i % 3}@example.com`, message(i));
            }),
          );
        }),
        3,
      );
      yield* measure(
        "sync 1000 re-upsert",
        store.transaction(
          Effect.gen(function* () {
            for (let i = 0; i < 1000; i++)
              yield* store.upsertMessage(`gmail:a${i % 3}@example.com`, message(i));
          }),
        ),
        3,
      );
      report.memory = process.memoryUsage();
      report.databaseBytes = statSync(file).size + statSync(`${file}-wal`).size;
      capture = new Map();
      const evictionStart = performance.now();
      const evicted = yield* store.evictBodies("gmail:a0@example.com", now, true);
      report.results.push({
        name: "full cache eviction",
        medianMs: performance.now() - evictionStart,
        evicted,
        queries: [...capture.values()],
      });
      capture = undefined;
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
  const output = process.argv[2] ?? "/tmp/openmail-performance.json";
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  log(`Report: ${output}`);
} finally {
  DatabaseSync.prototype.prepare = originalPrepare;
  if (directory) rmSync(directory, { recursive: true, force: true });
  if (historicalDirectory) rmSync(historicalDirectory, { recursive: true, force: true });
}

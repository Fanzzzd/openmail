import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import type { ThreadQuery } from "../domain/message.js";
import { traceQueries } from "../platform/node/fixtures/performance-mailbox.js";
import { migrate } from "../db/migrate.js";
import { MemoryPlatform } from "../platform/node/platform-memory.js";
import { Store } from "./service.js";
import { StoreLive } from "./store.js";
import { scaledMs } from "../../test-support/test-time.js";

const START = Date.parse("2020-09-13T12:26:40Z");
const words = ["alpha", "budget", "report", "invoice", "meeting", "travel", "review", "team"];

// Users never run ANALYZE. Without statistics SQLite used to read a date
// predicate through messages_account_date inside threadPage's correlated
// thread lookups: 8k messages took 11 to 16 s per page.
it.effect(
  "date searches use the thread index without planner statistics",
  () => {
    const trace = traceQueries();
    return Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      const a = yield* store.upsertAccount("gmail", "me@example.com");
      const b = yield* store.upsertAccount("gmail", "you@example.com");
      const count = 8000;
      yield* store.transaction(
        Effect.gen(function* () {
          for (let i = 0; i < count; i++) {
            const w = (k: number) => words[(i * 7 + k * 3) % words.length];
            yield* store.upsertMessage(i % 2 ? a.id : b.id, {
              providerId: `p${i}`,
              threadId: `t${Math.floor(i % (count / 3))}`,
              subject: `${w(1)} ${w(2)} ${i}`,
              from: { name: `Sender ${i % 300}`, address: `s${i % 300}@ex${i % 17}.com` },
              to: [{ name: "", address: "me@example.com" }],
              cc: [],
              date: START + i * 60_000,
              snippet: "",
              bodyText: `${w(3)} ${w(4)} lorem ipsum ${i}`,
              bodyHtml: "",
              labels: i % 5 ? ["INBOX", ...(i % 3 ? [] : ["UNREAD"])] : ["SENT"],
              attachments:
                i % 11 ? [] : [{ filename: "a.pdf", mimeType: "application/pdf", size: 10 }],
              isUnread: i % 3 === 0,
              isStarred: i % 13 === 0,
            });
          }
        }),
      );
      while (!(yield* store.backfillWordIndex(5000)).ready) {
        /* drain */
      }
      while (!(yield* store.backfillSearchFlags(5000)).ready) {
        /* drain */
      }
      assert.deepStrictEqual(
        yield* sql`SELECT COUNT(*) AS n FROM sqlite_stat1 WHERE tbl='messages'`,
        [{ n: 0 }],
        "planner statistics would hide the plan this test guards",
      );
      const after = "after:2020-09-15";
      const queries: ThreadQuery[] = [
        { search: after },
        { search: "before:2020-09-15" },
        { search: "after:2020-09-14 before:2020-09-17" },
        { search: "older_than:1d" },
        { search: "newer_than:100y" },
        { search: `from:Sender ${after}` },
        { search: `label:INBOX ${after}` },
        { search: `has:attachment ${after}` },
        { search: `is:unread ${after}` },
        { search: `budget ${after}` },
        { search: "from:Sender" },
        { search: "label:INBOX" },
        { search: "has:attachment" },
        { search: "is:unread" },
        { search: after, accountIds: [a.id] },
        { search: `from:Sender ${after}`, accountIds: [a.id, b.id] },
        { label: "INBOX", search: after, searchScope: "folder" },
      ];
      for (const query of queries) {
        trace.start();
        const started = performance.now();
        const rows = yield* store.listThreads({ ...query, limit: 50 });
        const elapsed = performance.now() - started;
        const plans = trace.stop();
        assert.isAbove(rows.length, 0, JSON.stringify(query));
        // The 100k budget for an operator search is 150 ms; 8k pages took 11 s.
        assert.isBelow(elapsed, scaledMs(300), JSON.stringify(query));
        for (const plan of plans)
          assert.notMatch(
            plan.plan.join("\n"),
            /messages_account_date \(account_id=\? AND date/,
            `${JSON.stringify(query)}\n${plan.sql}`,
          );
      }
    }).pipe(
      Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform()))),
      Effect.ensuring(Effect.sync(trace.restore)),
    );
  },
  { timeout: scaledMs(120_000) },
);

const fillMailbox = Effect.gen(function* () {
  const store = yield* Store;
  const sql = yield* SqlClient.SqlClient;
  const account = yield* store.upsertAccount("gmail", "me@example.com");
  const analyzed = sql<{ n: number }>`SELECT COUNT(*) AS n FROM sqlite_stat1 WHERE tbl='messages'`;
  assert.deepStrictEqual(yield* analyzed, [{ n: 0 }], "an empty mailbox has nothing to analyze");
  for (let i = 0; i < 300; i++)
    yield* store.upsertMessage(account.id, {
      providerId: `p${i}`,
      threadId: `t${i % 50}`,
      subject: "s",
      from: { name: "", address: "a@example.com" },
      to: [],
      cc: [],
      date: START + i,
      snippet: "",
      bodyText: "",
      bodyHtml: "",
      labels: ["INBOX"],
      attachments: [],
      isUnread: false,
      isStarred: false,
    });
  return analyzed;
});

it.effect("the hourly refresh gives the planner statistics for a grown mailbox", () =>
  Effect.gen(function* () {
    const store = yield* Store;
    const analyzed = yield* fillMailbox;
    yield* store.listThreads({ search: "after:2020-09-01", limit: 5 });
    yield* store.refreshPlannerStats;
    assert.isAbove((yield* analyzed)[0]?.n ?? 0, 0);
  }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
);

it.effect("opening the database analyzes tables this connection has not queried", () =>
  Effect.gen(function* () {
    const analyzed = yield* fillMailbox;
    yield* migrate;
    assert.isAbove((yield* analyzed)[0]?.n ?? 0, 0);
  }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
);

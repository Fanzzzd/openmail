import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { traceQueries } from "../platform/node/fixtures/performance-mailbox.js";
import { MemoryPlatform } from "../platform/node/platform-memory.js";
import { Store } from "./service.js";
import { StoreLive } from "./store.js";
import { scaledMs } from "../../test-support/test-time.js";

const words = ["weekly", "alpha", "budget", "report", "invoice", "meeting"];

// The performance fixture stopped running ANALYZE, as a fresh install has no statistics. SQLite
// then read an account's whole messages_account_date range for a search page pinned to a few
// rowids and for a thread sorted by date: MCP search took 838 ms on the 100k mailbox (budget 200).
it.effect(
  "searches and thread reads look rows up by key without planner statistics",
  () => {
    const trace = traceQueries();
    return Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      const accounts = [
        yield* store.upsertAccount("gmail", "a@example.com"),
        yield* store.upsertAccount("outlook", "b@example.com"),
        yield* store.upsertAccount("gmail", "c@example.com"),
      ];
      yield* store.transaction(
        Effect.forEach(
          Array.from({ length: 3000 }, (_, i) => i),
          (i) =>
            store.upsertMessage(accounts[i % 3]?.id ?? "", {
              providerId: `p${i}`,
              threadId: `t${Math.floor(i / 12)}`,
              subject: `${words[i % 6]} ${words[(i + 1) % 6]} ${i}`,
              from: { name: `Sender ${i % 50}`, address: `s${i % 50}@example.com` },
              to: [],
              cc: [],
              date: 1_600_000_000_000 + i * 60_000,
              snippet: "",
              bodyText: `${words[(i + 2) % 6]} project update ${i}`,
              bodyHtml: "",
              labels: ["INBOX"],
              attachments: [],
              isUnread: i % 3 === 0,
              isStarred: false,
            }),
          { discard: true },
        ),
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
        "planner statistics would hide the plans this test guards",
      );
      const accountIds = accounts.map((account) => account.id);
      const reads = {
        thread: store.getThread(`${accounts[0]?.id}/p0`),
        search: store.listThreads({ search: "weekly", limit: 20, accountIds }),
        searchAll: store.listThreads({ search: "weekly", limit: 20 }),
      };
      for (const [name, read] of Object.entries(reads)) {
        trace.start();
        yield* read;
        for (const plan of trace.stop())
          assert.notMatch(
            plan.plan.join("\n"),
            /messages_account_date \(account_id=\?\)/,
            `${name}\n${plan.sql}`,
          );
      }
    }).pipe(
      Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform()))),
      Effect.ensuring(Effect.sync(trace.restore)),
    );
  },
  { timeout: scaledMs(60_000) },
);

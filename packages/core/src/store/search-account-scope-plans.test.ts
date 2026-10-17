import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { traceQueries, type QueryPlan } from "../platform/node/fixtures/performance-mailbox.js";
import { MemoryPlatform } from "../platform/node/platform-memory.js";
import { Store } from "./service.js";
import { StoreLive } from "./store.js";
import { scaledMs } from "../../test-support/test-time.js";

const START = Date.parse("2026-01-01T00:00:00Z");
// `weekly` is in more than 2048 messages, so the search is a text page that walks a date index.
const COUNT = 3000;

/** The account filter sits before the first CASE of the statement or of the named CTE. */
const scopeBeforeCase = (sql: string, from: string) => {
  const part = sql.slice(sql.indexOf(from));
  const scope = part.indexOf("m.account_id IN (");
  const gate = part.indexOf("CASE WHEN");
  return scope >= 0 && gate >= 0 && scope < gate;
};

it.effect(
  "a one-account text page applies the account scope outside the CASE",
  () => {
    const trace = traceQueries();
    return Effect.gen(function* () {
      const store = yield* Store;
      const a = yield* store.upsertAccount("gmail", "me@example.com");
      const b = yield* store.upsertAccount("gmail", "you@example.com");
      yield* store.transaction(
        Effect.gen(function* () {
          for (let i = 0; i < COUNT; i++)
            yield* store.upsertMessage(i % 10 === 0 ? a.id : b.id, {
              providerId: `p${i}`,
              threadId: `t${Math.floor(i / 3)}`,
              subject: `Note ${i % 50}`,
              from: { name: `Sender ${i % 30}`, address: `s${i % 30}@example.com` },
              to: [{ name: "", address: "me@example.com" }],
              cc: [],
              date: START + i * 60_000,
              snippet: "",
              bodyText: `weekly person${i % 400}`,
              bodyHtml: "",
              labels: ["INBOX"],
              attachments: [],
              isUnread: false,
              isStarred: false,
            });
        }),
      );
      while (!(yield* store.backfillWordIndex(5000)).ready) {
        /* drain */
      }
      const planOf = (queries: readonly QueryPlan[], has: string) => {
        const found = queries.filter((query) => query.sql.includes(has));
        assert.isAbove(found.length, 0, `no statement contains ${has}`);
        return found;
      };

      // Thread page: the fast pass's `recent` CTE.
      trace.start();
      const threads = yield* store.listThreads({ search: "weekly", limit: 20, accountIds: [a.id] });
      const threadQueries = planOf(trace.stop(), "recent AS MATERIALIZED");
      assert.strictEqual(threads.length, 20);
      for (const query of threadQueries) {
        assert.isTrue(scopeBeforeCase(query.sql, "recent AS MATERIALIZED"), query.sql);
        assert.match(
          query.plan.join("\n"),
          /messages_account_list_date_id \(account_id=\?/,
          query.plan.join("\n"),
        );
      }

      // Flat page: the message list statement.
      trace.start();
      const flat = yield* store.listThreads({
        search: "weekly",
        limit: 20,
        flat: true,
        accountIds: [a.id],
      });
      const flatQueries = planOf(trace.stop(), "ORDER BY date DESC, m.id DESC LIMIT").filter(
        (query) => query.sql.includes("CASE WHEN"),
      );
      assert.strictEqual(flat.length, 20);
      assert.isAbove(flatQueries.length, 0);
      for (const query of flatQueries) {
        assert.isTrue(scopeBeforeCase(query.sql, "WHERE"), query.sql);
        assert.match(
          query.plan.join("\n"),
          /messages_account_list_date_id \(account_id=\?/,
          query.plan.join("\n"),
        );
      }
    }).pipe(
      Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform()))),
      Effect.ensuring(Effect.sync(trace.restore)),
    );
  },
  scaledMs(60_000),
);

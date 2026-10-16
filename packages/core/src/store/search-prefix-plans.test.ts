import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { ThreadQuery, ThreadSummary } from "../domain/message.js";
import { traceQueries, type QueryPlan } from "../platform/node/fixtures/performance-mailbox.js";
import { MemoryPlatform } from "../platform/node/platform-memory.js";
import { wholeWordMatch } from "../search/fts.js";
import { searchWords } from "../search/search-tokens.js";
import { sqliteTextCompare } from "./sql-rows.js";
import { Store } from "./service.js";
import { StoreLive } from "./store.js";
import { scaledMs } from "../../test-support/test-time.js";

const START = Date.parse("2026-01-01T00:00:00Z");
const COUNT = 3000;
// Every word but `alpine` and `pending` is in more than 2048 messages, so searches for them
// walk the date index; the rare ones start from the word index's rowids.
const body = (i: number) =>
  [
    i % 10 === 7 ? "" : "weekly",
    i % 5 === 1 ? "" : "delivery",
    `person${i % 400}`,
    i % 97 === 3 ? "alpine" : "",
    i % 31 === 5 ? "pending" : "",
    i % 2 ? "report" : "review",
  ].join(" ");

const Row = Schema.Struct({
  id: Schema.String,
  account_id: Schema.String,
  thread_id: Schema.String,
  subject: Schema.String,
  from_name: Schema.String,
  from_addr: Schema.String,
  body_text: Schema.String,
  list_date: Schema.Number,
  is_unread: Schema.Number,
  is_starred: Schema.Number,
});
type Row = typeof Row.Type;

const newestFirst = (a: Row, b: Row) => b.list_date - a.list_date || sqliteTextCompare(b.id, a.id);

/** The rows a search shows, from the message text alone: no SQL condition is reused. */
function reference(rows: readonly Row[], search: string, flat: boolean, limit: number) {
  const words = searchWords(search);
  const matching = rows
    .filter((row) =>
      words.every((word) =>
        [row.subject, row.from_name, row.from_addr, row.body_text].some((text) =>
          wholeWordMatch(text, word),
        ),
      ),
    )
    .toSorted(newestFirst);
  if (flat) return matching.slice(0, limit).map((row) => ({ id: row.id }));
  const threads = new Map<string, Row[]>();
  for (const row of matching) {
    const key = `${row.account_id}\u0000${row.thread_id}`;
    threads.set(key, [...(threads.get(key) ?? []), row]);
  }
  const sizes = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.account_id}\u0000${row.thread_id}`;
    sizes.set(key, (sizes.get(key) ?? 0) + 1);
  }
  return [...threads]
    .map(([key, group]) => ({ key, head: group[0], group }))
    .flatMap(({ key, head, group }) => (head ? [{ key, head, group }] : []))
    .toSorted((a, b) => newestFirst(a.head, b.head))
    .slice(0, limit)
    .map(({ key, head, group }) => ({
      id: head.id,
      isUnread: group.some((row) => row.is_unread === 1),
      isStarred: group.some((row) => row.is_starred === 1),
      threadCount: sizes.get(key) ?? 0,
    }));
}

const shown = (threads: readonly ThreadSummary[], flat: boolean) =>
  threads.map((thread) =>
    flat
      ? { id: thread.id }
      : {
          id: thread.id,
          isUnread: thread.isUnread,
          isStarred: thread.isStarred,
          threadCount: thread.threadCount,
        },
  );

const plan = (queries: readonly QueryPlan[]) =>
  queries.map((query) => `${query.sql}\n${query.plan.join("\n")}`).join("\n");
/** A MATCH constrained by the outer row's rowid: FTS opens one cursor for each walked row. */
const ROW_PROBE = /SCAN messages_words (?:EXISTS )?VIRTUAL TABLE INDEX \d+:=/;

it.effect(
  "prefix and multi-word searches return the same rows on every plan",
  () => {
    const trace = traceQueries();
    return Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      const a = yield* store.upsertAccount("gmail", "me@example.com");
      const b = yield* store.upsertAccount("gmail", "you@example.com");
      yield* store.transaction(
        Effect.gen(function* () {
          for (let i = 0; i < COUNT; i++)
            yield* store.upsertMessage(i % 2 ? a.id : b.id, {
              providerId: `p${i}`,
              // Threads of three to five messages; newer replies often lack a word.
              threadId: `t${Math.floor(i / (3 + (i % 3)))}`,
              subject: `Note ${i % 50}`,
              from: { name: `Sender ${i % 30}`, address: `s${i % 30}@example.com` },
              to: [{ name: "", address: "me@example.com" }],
              cc: [],
              // Ties on the date order by id.
              date: START + Math.floor(i / 2) * 60_000,
              snippet: "",
              bodyText: body(i),
              bodyHtml: "",
              labels: ["INBOX", ...(i % 3 ? [] : ["UNREAD"])],
              attachments: [],
              isUnread: i % 3 === 0,
              isStarred: i % 17 === 0,
            });
        }),
      );
      while (!(yield* store.backfillWordIndex(5000)).ready) {
        /* drain */
      }
      const rows =
        yield* sql`SELECT id,account_id,thread_id,subject,from_name,from_addr,body_text,list_date,is_unread,is_starred FROM messages`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Row))),
        );
      const searches = [
        "weekly",
        "weekl*",
        "we*",
        "pe*",
        "person1*",
        "alpine",
        "alp*",
        "weekly de*",
        "weekly delivery",
        "delivery we*",
        "weekly alpine",
        "pending we*",
      ];
      const plans = new Map<string, string>();
      for (const search of searches)
        for (const flat of [false, true]) {
          trace.start();
          const page = yield* store.listThreads({ search, limit: 40, flat });
          const queries = trace.stop();
          // The thread page itself; snippets and attachments run their own queries.
          if (!flat)
            plans.set(
              search,
              plan(
                queries.filter(
                  (query) =>
                    query.sql.includes("flag_candidates AS NOT MATERIALIZED") &&
                    !query.sql.includes("json_each(?)"),
                ),
              ),
            );
          assert.deepStrictEqual(shown(page, flat), reference(rows, search, flat, 40), search);
          const last = page.at(-1);
          assert.ok(last, search);
          const next = yield* store.listThreads({
            search,
            limit: 40,
            flat,
            before: last.date,
            beforeId: last.id,
          } satisfies ThreadQuery);
          const all = reference(rows, search, flat, 80);
          assert.deepStrictEqual(shown(next, flat), all.slice(page.length), `${search} page 2`);
          const scoped = yield* store.listThreads({ search, limit: 40, flat, accountIds: [a.id] });
          assert.deepStrictEqual(
            shown(scoped, flat),
            reference(
              rows.filter((row) => row.account_id === a.id),
              search,
              flat,
              40,
            ),
            `${search} in one account`,
          );
          // A common search counts from its MATCH; the count must agree with the list.
          assert.strictEqual(
            yield* store.countThreads({ search, flat }),
            reference(rows, search, flat, COUNT).length,
            `${search} count`,
          );
        }
      // The exact common word probes each walked row; prefixes read their rowids once.
      assert.match(plans.get("weekly") ?? "", ROW_PROBE);
      for (const search of ["weekl*", "we*", "pe*", "weekly de*", "delivery we*"]) {
        const shape = plans.get(search) ?? "";
        // An exact word next to the prefix may still probe each row; the prefix may not.
        if (!search.includes(" ")) assert.notMatch(shape, ROW_PROBE, search);
        assert.include(shape, "(m.rowid+0) IN (SELECT rowid FROM messages_words", search);
        assert.include(shape, "SCAN m USING COVERING INDEX messages_list_date_id", search);
      }
      // Common words together walk the date index instead of every message of one word.
      for (const search of ["weekly delivery", "weekly de*"])
        assert.include(plans.get(search) ?? "", "messages m INDEXED BY messages_list_date_id");
      assert.notInclude(plans.get("weekly alpine") ?? "", "INDEXED BY messages_list_date_id");
      // OCR text in older mail: its conversations are not in the first mail page, so the
      // search looks their representatives up by id.
      for (let i = 0; i < 400; i += 40) {
        const messageId = `${i % 2 ? a.id : b.id}/p${i}`;
        yield* sql`INSERT INTO derived_chunks(message_id,text,provenance_json) VALUES(${messageId},${"weekly pending scan"},${JSON.stringify(
          {
            messageId,
            text: "weekly pending scan",
            source: { kind: "attachment", index: 0, name: "scan.pdf", mimeType: "application/pdf" },
            page: 1,
            region: null,
            pipelineVersion: "test",
            visionRevision: 1,
          },
        )})`;
      }
      while (!(yield* store.backfillWordIndex(5000)).ready) {
        /* drain */
      }
      trace.start();
      const withAttachments = yield* store.listThreads({ search: "we*", limit: 5 });
      const lookups = trace
        .stop()
        .filter(
          (query) =>
            query.sql.includes("candidates AS NOT MATERIALIZED") &&
            query.sql.includes("m.id IN (SELECT value FROM json_each"),
        );
      assert.ok(
        withAttachments.some((thread) => thread.derivedMatches?.length),
        "an attachment-only conversation joins the results",
      );
      assert.isAbove(lookups.length, 0);
      for (const query of lookups) assert.notInclude(plan([query]), "messages_list_date_id");
    }).pipe(
      Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform()))),
      Effect.ensuring(Effect.sync(trace.restore)),
    );
  },
  scaledMs(60_000),
);

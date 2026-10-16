import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { ThreadQuery, ThreadSummary } from "../domain/message.js";
import { traceQueries, type QueryPlan } from "../platform/node/fixtures/performance-mailbox.js";
import { MemoryPlatform } from "../platform/node/platform-memory.js";
import { wholeWordMatch } from "../search/fts.js";
import { sqliteTextCompare } from "./sql-rows.js";
import { Store } from "./service.js";
import { StoreLive } from "./store.js";
import { scaledMs } from "../../test-support/test-time.js";

const START = Date.parse("2026-01-01T00:00:00Z");
const COUNT = 3000;
// `weekly` is in more than 2048 messages, so a search for it walks the date index.
const body = (i: number) =>
  [i % 10 === 7 ? "" : "weekly", i % 5 === 1 ? "" : "delivery", i % 97 === 3 ? "alpine" : ""].join(
    " ",
  );
// Label_1 is "Projects" in account A and "Receipts" in account B; B calls Label_3 "PROJECTS".
// Labels change within a thread, so a thread's newest message often lacks the label.
const labelsOf = (i: number) => [
  i % 41 === 0 ? "SPAM" : i % 43 === 0 ? "TRASH" : "INBOX",
  ...(i % 5 === 0 ? ["Label_1"] : []),
  ...(i % 7 === 0 ? ["Label_2"] : []),
  ...(i % 13 === 0 ? ["Label_3"] : []),
  ...(i % 11 === 0 ? ["IMPORTANT"] : []),
  ...(i % 3 === 0 ? ["UNREAD"] : []),
];

const Row = Schema.Struct({
  id: Schema.String,
  account_id: Schema.String,
  thread_id: Schema.String,
  subject: Schema.String,
  from_name: Schema.String,
  from_addr: Schema.String,
  body_text: Schema.String,
  labels_json: Schema.String,
  list_date: Schema.Number,
  is_unread: Schema.Number,
  is_starred: Schema.Number,
});
type Row = typeof Row.Type;

const decodeLabels = (row: Row) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))(row.labels_json);

const newestFirst = (a: Row, b: Row) => b.list_date - a.list_date || sqliteTextCompare(b.id, a.id);

/** label: and words over the stored labels and text alone: no SQL condition is reused. */
function matcher(names: ReadonlyMap<string, ReadonlyMap<string, string>>, search: string) {
  const hasLabel = (row: Row, label: string) =>
    decodeLabels(row).some(
      (id) =>
        id === label || names.get(row.account_id)?.get(id)?.toLowerCase() === label.toLowerCase(),
    );
  const term = (token: string): ((row: Row) => boolean) => {
    if (token.startsWith("-")) {
      const inner = term(token.slice(1));
      return (row) => !inner(row);
    }
    if (token.startsWith("label:")) {
      const label = token.slice("label:".length).replaceAll('"', "");
      return (row) => hasLabel(row, label);
    }
    if (token === "is:unread") return (row) => row.is_unread === 1;
    if (token === "is:starred") return (row) => row.is_starred === 1;
    return (row) =>
      [row.subject, row.from_name, row.from_addr, row.body_text].some((text) =>
        wholeWordMatch(text, token),
      );
  };
  const tokens = (part: string) => part.match(/-?label:"[^"]*"|\S+/g) ?? [];
  const alternatives = search
    .split(" OR ")
    .map((part) => tokens(part).map(term))
    .map((terms) => (row: Row) => terms.every((test) => test(row)));
  return (row: Row) =>
    !hasLabel(row, "SPAM") && !hasLabel(row, "TRASH") && alternatives.some((test) => test(row));
}

function reference(
  rows: readonly Row[],
  matches: (row: Row) => boolean,
  flat: boolean,
  limit: number,
) {
  const matching = rows.filter(matches).toSorted(newestFirst);
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
    .flatMap(([key, group]) => (group[0] ? [{ key, head: group[0], group }] : []))
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

/** The CTE that walks rows for thread heads, up to its ORDER BY. */
const headWalks = (query: string) =>
  ["recent AS MATERIALIZED (", "page AS MATERIALIZED ("].flatMap((start) => {
    const at = query.indexOf(start);
    if (at < 0) return [];
    const walk = query.slice(at, query.indexOf("ORDER BY", at));
    return walk.includes("FROM candidates n") ? [walk] : [];
  });

it.effect(
  "label: searches and label lists return the same rows on every plan",
  () => {
    const trace = traceQueries();
    return Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      const a = yield* store.upsertAccount("gmail", "me@example.com");
      const b = yield* store.upsertAccount("gmail", "you@example.com");
      yield* store.replaceLabels(a.id, [
        { id: "Label_1", name: "Projects", color: null },
        { id: "Label_2", name: "Folder 5", color: null },
      ]);
      yield* store.replaceLabels(b.id, [
        { id: "Label_1", name: "Receipts", color: null },
        { id: "Label_2", name: "Folder 5", color: null },
        { id: "Label_3", name: "PROJECTS", color: null },
      ]);
      const names = new Map([
        [
          a.id,
          new Map([
            ["Label_1", "Projects"],
            ["Label_2", "Folder 5"],
          ]),
        ],
        [
          b.id,
          new Map([
            ["Label_1", "Receipts"],
            ["Label_2", "Folder 5"],
            ["Label_3", "PROJECTS"],
          ]),
        ],
      ]);
      yield* store.transaction(
        Effect.gen(function* () {
          for (let i = 0; i < COUNT; i++)
            yield* store.upsertMessage(i % 2 ? a.id : b.id, {
              providerId: `p${i}`,
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
              labels: labelsOf(i),
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
        yield* sql`SELECT id,account_id,thread_id,subject,from_name,from_addr,body_text,labels_json,list_date,is_unread,is_starred FROM messages`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Row))),
        );
      const check = (name: string, query: ThreadQuery, matches: (row: Row) => boolean) =>
        Effect.gen(function* () {
          const flat = query.flat ?? false;
          const scoped = (row: Row) =>
            matches(row) && (query.accountIds?.includes(row.account_id) ?? true);
          const page = yield* store.listThreads({ ...query, limit: 40 });
          assert.deepStrictEqual(shown(page, flat), reference(rows, scoped, flat, 40), name);
          const last = page.at(-1);
          if (last) {
            const next = yield* store.listThreads({
              ...query,
              limit: 40,
              before: last.date,
              beforeId: last.id,
            });
            assert.deepStrictEqual(
              shown(next, flat),
              reference(rows, scoped, flat, 80).slice(page.length),
              `${name} page 2`,
            );
          }
          assert.strictEqual(
            yield* store.countThreads(query),
            reference(rows, scoped, flat, COUNT).length,
            `${name} count`,
          );
        });
      const searches = [
        "label:Projects",
        "label:projects",
        "label:PROJECTS",
        "label:Label_1",
        "label:receipts",
        'label:"Folder 5"',
        'label:"folder 5"',
        "label:INBOX",
        "label:IMPORTANT",
        "label:nothing",
        "-label:Projects",
        "label:Projects OR label:receipts",
        "label:Projects OR alpine",
        "label:Projects weekly",
        "label:projects we*",
        "label:Projects weekly delivery",
        "label:Projects alpine",
        "label:Projects -weekly",
        "label:Projects label:IMPORTANT",
        "is:unread label:Projects",
        "is:starred label:projects",
      ];
      trace.start();
      for (const search of searches)
        for (const flat of [false, true])
          for (const accountIds of [undefined, [a.id]])
            yield* check(
              `${search}${flat ? " flat" : ""}${accountIds ? " in A" : ""}`,
              { search, flat, ...(accountIds ? { accountIds } : {}) },
              matcher(names, search),
            );
      const labelSearches = trace.stop();
      // A label list filters by label id, a mailbox view by its system label. Both walk the
      // global date index, which covers labels_json, also in one account.
      trace.start();
      for (const label of ["Label_1", "Label_3", "IMPORTANT"])
        for (const flat of [false, true])
          for (const accountIds of [undefined, [a.id]]) {
            const has = (row: Row) => decodeLabels(row).includes(label);
            yield* check(
              `list ${label}${flat ? " flat" : ""}${accountIds ? " in A" : ""}`,
              { mailbox: "all", label, flat, ...(accountIds ? { accountIds } : {}) },
              (row) => has(row) && matcher(names, "")(row),
            );
            yield* check(
              `inbox ${label}${flat ? " flat" : ""}${accountIds ? " in A" : ""}`,
              { mailbox: "inbox", label, flat, ...(accountIds ? { accountIds } : {}) },
              (row) => has(row) && row.labels_json.includes('"INBOX"'),
            );
            if (label === "IMPORTANT")
              yield* check(
                `important${flat ? " flat" : ""}${accountIds ? " in A" : ""}`,
                { mailbox: "important", flat, ...(accountIds ? { accountIds } : {}) },
                has,
              );
          }
      const labelLists = trace.stop();

      const nameLookups = labelSearches.filter((query) => query.sql.includes("FROM labels WHERE"));
      assert.isAbove(nameLookups.length, 0);
      for (const query of nameLookups) {
        // The name lookup does not refer to the message row, so SQLite builds it once.
        assert.notInclude(query.sql, "account_id=m.account_id AND name=");
        for (const [at, line] of query.plan.entries())
          if (/^(SEARCH|SCAN) labels\b/.test(line))
            assert.notMatch(query.plan[at - 1] ?? "", /^CORRELATED/, `${line}\n${query.sql}`);
      }
      const walks = (queries: readonly QueryPlan[]) =>
        queries.flatMap((query) => headWalks(query.sql));
      // A date walk tests the row's own labels before it looks for newer matches in the thread.
      const listWalks = walks(labelLists);
      assert.isAbove(listWalks.length, 0);
      for (const walk of listWalks) {
        assert.include(walk, "messages m INDEXED BY messages_list_date_id", walk);
        assert.include(walk, "CASE WHEN", walk);
        const label = walk.indexOf("json_each(m.labels_json)");
        assert.isAtLeast(label, 0, walk);
        assert.isBelow(label, walk.indexOf("FROM candidates n"), walk);
      }
      // label: next to a common word walks the date index too; MATCH stays after the
      // newest-in-thread check.
      const textWalks = walks(
        labelSearches.filter(
          (query) =>
            query.sql.includes("INDEXED BY messages_list_date_id") &&
            query.sql.includes("messages_words WHERE rowid=m.rowid"),
        ),
      );
      assert.isAbove(textWalks.length, 0);
      for (const walk of textWalks) {
        const label = walk.indexOf("json_each(m.labels_json)");
        const newest = walk.indexOf("FROM candidates n");
        assert.isAtLeast(label, 0, walk);
        assert.isBelow(label, newest, walk);
        const probe = walk.indexOf("messages_words WHERE rowid=m.rowid");
        if (probe >= 0) assert.isBelow(newest, probe, walk);
      }
    }).pipe(
      Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform()))),
      Effect.ensuring(Effect.sync(trace.restore)),
    );
  },
  scaledMs(120_000),
);

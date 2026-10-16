import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { IncomingMessage, ThreadQuery, ThreadSummary } from "../domain/message.js";
import { traceQueries } from "../platform/node/fixtures/performance-mailbox.js";
import { MemoryPlatform } from "../platform/node/platform-memory.js";
import { wholeWordMatch } from "../search/fts.js";
import { expressionMedia } from "./store-query.js";
import { sqliteTextCompare } from "./sql-rows.js";
import { Store } from "./service.js";
import { StoreLive } from "./store.js";
import { scaledMs } from "../../test-support/test-time.js";

const START = Date.parse("2026-01-01T00:00:00Z");
const COUNT = 3000;
// `report` is in the subject of 8 in 9 messages, more than the 2048 rows that make a term
// common, so subject:report walks the date index. Thread 0 has 60 messages: the newest-in-thread
// check reads many replies there. invoice and ledger are only in attachment text.
const threadOf = (i: number) => (i % 50 === 0 ? 0 : 1 + Math.floor(i / (3 + (i % 3))));
const subjectOf = (i: number) =>
  i % 9 === 4 ? `Planning ${i % 40}` : `Weekly report ${i % 40}${i % 7 === 0 ? " draft" : ""}`;
const bodyOf = (i: number) =>
  [i % 10 === 7 ? "" : "weekly", i % 5 === 1 ? "" : "delivery", i % 97 === 3 ? "alpine" : ""].join(
    " ",
  );
const message = (i: number, revision = 0): IncomingMessage => ({
  providerId: `p${i}`,
  threadId: `t${threadOf(i)}`,
  subject: subjectOf(i),
  from: { name: `Sender ${i % 30}`, address: `s${i % 30}@example.com` },
  to:
    i % 11 === 0
      ? []
      : [
          {
            name: `Recipient ${(i + revision) % 7}`,
            address: `r${(i + revision) % 7}@example.com`,
          },
          ...(i % 8 === 0 ? [{ name: "Team Lead", address: "lead@corp.example" }] : []),
        ],
  cc: i % 4 === 0 ? [{ name: "Team", address: `team${(i + revision) % 5}@example.com` }] : [],
  date: START + Math.floor(i / 2) * 60_000,
  snippet: "",
  bodyText: bodyOf(i),
  bodyHtml: "",
  ...(i % 13 === 0
    ? {}
    : {
        headers: [
          ...(i % 6 === 0 ? [{ name: "List-Id", value: `<news${revision}.example.com>` }] : []),
          ...(i % 12 === 0 ? [{ name: "List-Post", value: "<mailto:news@example.com>" }] : []),
          { name: "X-Mailer", value: "nolist" },
        ],
      }),
  labels: [
    i % 41 === 0 ? "SPAM" : i % 43 === 0 ? "TRASH" : "INBOX",
    ...(i % 3 === 0 ? ["UNREAD"] : []),
  ],
  attachments: [
    ...(i % 10 === 0
      ? [{ filename: `report${(i + revision) % 3}.pdf`, mimeType: "application/pdf", size: 10 }]
      : []),
    // An unescaped `_` in notes_1 would also match notesA1.
    ...(i % 25 === 0 ? [{ filename: `notes_${i % 4}.txt`, mimeType: "text/plain", size: 1 }] : []),
    ...(i % 25 === 5 ? [{ filename: `notesA${i % 4}.txt`, mimeType: "text/plain", size: 1 }] : []),
  ],
  isUnread: i % 3 === 0,
  isStarred: i % 17 === 0,
});
// One attachment text chunk for every tenth message.
const chunkText = (i: number) => (i % 20 === 0 ? "Invoice ledger" : "invoice total due");

const Address = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
  address: Schema.optional(Schema.NullOr(Schema.String)),
});
const Row = Schema.Struct({
  id: Schema.String,
  account_id: Schema.String,
  thread_id: Schema.String,
  subject: Schema.String,
  from_name: Schema.String,
  from_addr: Schema.String,
  body_text: Schema.String,
  labels_json: Schema.fromJsonString(Schema.Array(Schema.String)),
  to_json: Schema.fromJsonString(Schema.Array(Address)),
  cc_json: Schema.fromJsonString(Schema.Array(Address)),
  attachments_json: Schema.fromJsonString(Schema.Array(Schema.Struct({ filename: Schema.String }))),
  headers_json: Schema.NullOr(
    Schema.fromJsonString(
      Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
    ),
  ),
  chunks_json: Schema.fromJsonString(Schema.Array(Schema.String)),
  list_date: Schema.Number,
  is_unread: Schema.Number,
  is_starred: Schema.Number,
});
type Row = typeof Row.Type;

const newestFirst = (a: Row, b: Row) => b.list_date - a.list_date || sqliteTextCompare(b.id, a.id);
/** LIKE '%value%' for ASCII text. */
const contains = (text: string | null | undefined, value: string) =>
  (text ?? "").toLowerCase().includes(value.toLowerCase());

/** The search over the stored rows alone: no SQL condition is reused. */
function matcher(search: string) {
  const media = expressionMedia(search);
  const atom = (token: string): ((row: Row) => boolean) => {
    const [, key, rawValue] = /^([a-z]+):(.*)$/.exec(token) ?? [];
    const value = rawValue?.replaceAll('"', "") ?? "";
    switch (key) {
      case "subject":
        return (row) => wholeWordMatch(row.subject, value);
      case "from":
        return (row) => contains(row.from_addr, value) || contains(row.from_name, value);
      case "to":
      case "cc":
        return (row) =>
          (key === "to" ? row.to_json : row.cc_json).some(
            (a) => contains(a.address, value) || contains(a.name, value),
          );
      case "filename":
        return (row) => row.attachments_json.some((a) => contains(a.filename, value));
      case "list":
        return (row) =>
          (row.headers_json ?? []).some((h) => {
            const name = h.name.toLowerCase();
            return (
              (name === "list-id" || name === "list-post") &&
              (contains(h.value, value) ||
                (name === "list-id" && contains(h.value, value.replace("@", "."))))
            );
          });
      case "is":
        return value === "unread" ? (row) => row.is_unread === 1 : (row) => row.is_starred === 1;
      default:
        return (row) =>
          [row.subject, row.from_name, row.from_addr, row.body_text].some((text) =>
            wholeWordMatch(text, token),
          ) ||
          (media && row.chunks_json.some((text) => wholeWordMatch(text, token)));
    }
  };
  const tokens = search.match(/\(|\)|-?[a-z]+:"[^"]*"|[^\s()]+/g) ?? [];
  let at = 0;
  const or = (): ((row: Row) => boolean) => {
    const parts = [and()];
    while (tokens[at] === "OR") {
      at++;
      parts.push(and());
    }
    return (row) => parts.some((part) => part(row));
  };
  const and = (): ((row: Row) => boolean) => {
    const parts: ((row: Row) => boolean)[] = [];
    while (at < tokens.length && tokens[at] !== ")" && tokens[at] !== "OR") {
      const token = tokens[at++] ?? "";
      if (token === "(") {
        parts.push(or());
        at++;
      } else if (token.startsWith("-")) {
        const inner = atom(token.slice(1));
        parts.push((row) => !inner(row));
      } else parts.push(atom(token));
    }
    return (row) => parts.every((part) => part(row));
  };
  const matches = or();
  return (row: Row) =>
    !row.labels_json.includes("SPAM") && !row.labels_json.includes("TRASH") && matches(row);
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
const byId = <A extends { id: string }>(rows: readonly A[]) =>
  rows.toSorted((a, b) => sqliteTextCompare(a.id, b.id));

/** A CTE of `query` from its start to its ORDER BY. */
const cte = (query: string, start: string) => {
  const at = query.indexOf(start);
  return at < 0 ? undefined : query.slice(at, query.indexOf("ORDER BY", at));
};

const loadRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT id,account_id,thread_id,subject,from_name,from_addr,body_text,labels_json,to_json,cc_json,attachments_json,headers_json,
      (SELECT json_group_array(text) FROM derived_chunks d WHERE d.message_id=m.id) AS chunks_json,list_date,is_unread,is_starred FROM messages m`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Row))),
  );
});

const seed = Effect.gen(function* () {
  const store = yield* Store;
  const sql = yield* SqlClient.SqlClient;
  const a = yield* store.upsertAccount("gmail", "me@example.com");
  const b = yield* store.upsertAccount("gmail", "you@example.com");
  const accountOf = (i: number) => (i % 2 ? a.id : b.id);
  yield* store.transaction(
    Effect.gen(function* () {
      for (let i = 0; i < COUNT; i++) yield* store.upsertMessage(accountOf(i), message(i));
      for (let i = 0; i < COUNT; i += 10) {
        const messageId = `${accountOf(i)}/p${i}`;
        const text = chunkText(i);
        yield* sql`INSERT INTO derived_chunks(message_id,text,provenance_json) VALUES(${messageId},${text},${JSON.stringify(
          {
            messageId,
            text,
            source: {
              kind: "attachment",
              index: 0,
              name: "report.pdf",
              mimeType: "application/pdf",
            },
            page: 1,
            region: null,
            pipelineVersion: "test",
            visionRevision: 1,
          },
        )})`;
      }
    }),
  );
  while (!(yield* store.backfillWordIndex(5000)).ready) {
    /* drain */
  }
  return { a: a.id, b: b.id, accountOf };
});

const check = (rows: readonly Row[], name: string, query: ThreadQuery, ordered: boolean) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const flat = query.flat ?? false;
    const matches = matcher(query.search ?? "");
    const scoped = (row: Row) =>
      matches(row) && (query.accountIds?.includes(row.account_id) ?? true);
    const result = yield* store.listThreads({ ...query, limit: 40 });
    const page = shown(result, flat);
    const expected = reference(rows, scoped, flat, 40);
    // Attachment text hits rank a page by relevance; the page holds the same conversations.
    if (ordered) assert.deepStrictEqual(page, expected, name);
    else assert.deepStrictEqual(byId(page), byId(expected), name);
    const last = result.at(-1);
    if (ordered && last) {
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

const checkAll = (
  rows: readonly Row[],
  searches: readonly (readonly [search: string, ordered: boolean])[],
  account: string,
) =>
  Effect.gen(function* () {
    for (const [search, ordered] of searches)
      for (const flat of [false, true])
        for (const accountIds of [undefined, [account]])
          yield* check(
            rows,
            `${search}${flat ? " flat" : ""}${accountIds ? " in A" : ""}`,
            { search, flat, ...(accountIds ? { accountIds } : {}) },
            ordered,
          );
  });

const layer = StoreLive.pipe(Layer.provideMerge(MemoryPlatform()));

it.effect(
  "subject: searches return the same rows on every plan",
  () => {
    const trace = traceQueries();
    return Effect.gen(function* () {
      const { a } = yield* seed;
      const rows = yield* loadRows;
      const subjects = [
        "subject:report",
        'subject:"weekly report"',
        "subject:REPORT",
        "subject:rep*",
        "subject:planning",
        "subject:draft",
        "subject:report weekly",
        "subject:report is:unread",
        "subject:report -from:s3",
        "subject:nothing",
      ].map((search) => [search, true] as const);
      trace.start();
      yield* checkAll(rows, subjects, a);
      const queries = trace.stop();
      // Unread and starred of the page come from the outer query over at most `limit` rows,
      // not from the CTE that walks every matching row.
      const pages = queries.flatMap((query) => cte(query.sql, "page AS MATERIALIZED (") ?? []);
      assert.isAbove(pages.length, 0);
      for (const page of pages) assert.notInclude(page, "flag_candidates", page);
      // A common subject: word walks the date index and leaves the word index out of the
      // newest-in-thread superset.
      const walks = queries.flatMap((query) => cte(query.sql, "recent AS MATERIALIZED (") ?? []);
      assert.isAbove(walks.length, 0);
      for (const walk of walks) {
        assert.match(walk, /INDEXED BY messages_(account_)?list_date_id/, walk);
        assert.notInclude(walk, "messages_words", walk);
      }
      assert.isTrue(
        queries.some((query) =>
          query.sql.includes("messages_words WHERE rowid=m.rowid AND messages_words MATCH"),
        ),
      );
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(trace.restore)));
  },
  scaledMs(180_000),
);

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { IncomingMessage, ThreadQuery, ThreadSummary } from "../domain/message.js";
import { traceQueries, type QueryPlan } from "../platform/node/fixtures/performance-mailbox.js";
import { MemoryPlatform } from "../platform/node/platform-memory.js";
import { operatorTextValues } from "../db/operator-text.js";
import { databaseLayer, MIGRATIONS } from "../platform/node/db.js";
import { applyNativeMigration } from "../platform/node/migrations.js";
import { NodeSystem } from "../platform/node/platform-node.js";
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
      // A count reads every match, so it starts from the word index's rowids instead of
      // probing the index once per message.
      const counts = queries.filter((query) => query.sql.startsWith("SELECT COUNT(*) AS n FROM"));
      assert.isAbove(counts.length, 0);
      for (const count of counts) assert.notInclude(count.sql, "rowid=m.rowid", count.sql);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(trace.restore)));
  },
  scaledMs(180_000),
);

it.effect(
  "OR searches over mail and attachment text return the same rows",
  () => {
    const trace = traceQueries();
    return Effect.gen(function* () {
      const { a } = yield* seed;
      const rows = yield* loadRows;
      // Attachment text hits rank a page by relevance, so those pages compare as sets.
      const ors = [
        ["weekly OR alpine", true],
        ["(weekly OR delivery) is:unread", true],
        ["alpine OR planning", true],
        ["invoice OR alpine", false],
        ["invoice OR weekly", false],
        ["ledger OR nothing", false],
        ["invoice -weekly", false],
        ["subject:planning OR ledger", false],
      ] as const;
      trace.start();
      yield* checkAll(rows, ors, a);
      const queries = trace.stop();
      // Attachment text answers from one set of message ids per statement: no derived chunk
      // lookup per tested message, and none per selected id.
      const derived = queries.filter((query) => query.sql.includes("derived_words MATCH"));
      assert.isAbove(derived.length, 0);
      const perRow = (query: QueryPlan) =>
        query.plan.some((line) =>
          line.includes("derived_chunks_message (message_id=? AND rowid=?)"),
        );
      for (const query of derived) assert.isFalse(perRow(query), query.plan.join("\n"));
      assert.isTrue(
        queries.some((query) =>
          query.sql.includes("+m.id IN (SELECT d.message_id FROM derived_chunks d WHERE d.id IN"),
        ),
      );
      // The attachment matches of a page start from the chunks. Without statistics on 100k
      // messages a plain `m.id IN` made SQLite probe each selected id for every matching chunk;
      // this small mailbox does not reproduce that plan, so the statement text is checked.
      const pageChunks = queries.filter((query) =>
        query.sql.includes("JOIN derived_chunks d ON d.id=derived_words.rowid"),
      );
      assert.isAbove(pageChunks.length, 0);
      for (const query of pageChunks) assert.include(query.sql, "AND +m.id IN (", query.sql);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(trace.restore)));
  },
  scaledMs(180_000),
);

const operatorSearches = [
  "to:nobody@example.com",
  "cc:nobody",
  "filename:none.pdf",
  "list:nolist",
  "to:r3",
  "to:R3@EXAMPLE",
  "to:recipient",
  "to:lead",
  "cc:team2",
  "filename:report1",
  "filename:notes_1",
  "filename:.txt",
  "list:news@example.com",
  "list:news1.example",
  "list:mailto",
  "-to:r3",
  "-to:r3 weekly",
  "to:r3 OR cc:team2",
  "to:nobody OR cc:nobody",
  "to:r3 filename:report",
  "-filename:report from:s3",
  "(to:r2 OR list:news) is:unread",
  "subject:report to:lead",
].map((search) => [search, true] as const);

const OperatorRow = Schema.Struct({
  row_id: Schema.Number,
  to_text: Schema.String,
  cc_text: Schema.String,
  file_text: Schema.String,
  list_id_text: Schema.String,
  list_post_text: Schema.String,
});

it.effect(
  "to:, cc:, filename: and list: return the same rows before, during and after the backfill",
  () => {
    const trace = traceQueries();
    return Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      const { a, accountOf } = yield* seed;
      const operatorQueries = (queries: readonly QueryPlan[]) =>
        queries.filter((query) => query.sql.includes("FROM messages m"));
      const usesSideTable = (queries: readonly QueryPlan[], expected: boolean) => {
        const lists = operatorQueries(queries);
        assert.isAbove(lists.length, 0);
        for (const query of lists) {
          const scans = /json_each\(m\.(to_json|cc_json|attachments_json|headers_json)\)/.test(
            query.sql,
          );
          const side = query.sql.includes("message_operator_text");
          if (expected) assert.isFalse(scans, query.sql);
          else assert.isFalse(side, query.sql);
        }
        assert.strictEqual(
          lists.some((query) => query.sql.includes("message_operator_text")),
          expected,
        );
      };
      // The text of every row, recomputed from the messages: the triggers keep it current.
      const sideTableCurrent = Effect.gen(function* () {
        const stored = yield* sql`SELECT * FROM message_operator_text ORDER BY row_id`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(OperatorRow))),
        );
        const fresh =
          yield* sql`WITH fresh(row_id,to_text,cc_text,file_text,list_id_text,list_post_text) AS (
            SELECT rowid,${sql.literal(operatorTextValues("m"))} FROM messages m)
            SELECT * FROM fresh ORDER BY row_id`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(OperatorRow))),
          );
        assert.isAbove(fresh.length, COUNT - 100);
        assert.deepStrictEqual(stored, fresh);
      });

      // A new database has nothing to backfill.
      assert.isTrue(yield* store.operatorTextReady);
      yield* sideTableCurrent;
      let rows = yield* loadRows;
      trace.start();
      yield* checkAll(rows, operatorSearches, a);
      usesSideTable(trace.stop(), true);

      // A database from before migration 57: older rows have no operator text yet.
      yield* sql`DELETE FROM message_operator_text WHERE row_id % 3 = 0`;
      yield* sql`UPDATE message_operator_text_backfill SET cursor=0,end_rowid=(SELECT MAX(rowid) FROM messages),ready=0`;
      assert.isFalse(yield* store.operatorTextReady);
      trace.start();
      yield* checkAll(rows, operatorSearches, a);
      usesSideTable(trace.stop(), false);
      assert.deepStrictEqual(yield* store.backfillOperatorText(1000), {
        processed: 1000,
        ready: false,
      });
      assert.isFalse(yield* store.operatorTextReady);
      trace.start();
      yield* checkAll(rows, operatorSearches, a);
      usesSideTable(trace.stop(), false);
      assert.deepStrictEqual(yield* store.backfillOperatorText(1000), {
        processed: 1000,
        ready: false,
      });
      assert.deepStrictEqual(yield* store.backfillOperatorText(1000), {
        processed: 1000,
        ready: true,
      });
      assert.deepStrictEqual(yield* store.backfillOperatorText(1000), {
        processed: 0,
        ready: true,
      });
      yield* sideTableCurrent;
      trace.start();
      yield* checkAll(rows, operatorSearches, a);
      usesSideTable(trace.stop(), true);

      // Changed recipients, attachments and headers, flag-only changes, deletes and new mail.
      yield* store.transaction(
        Effect.gen(function* () {
          for (let i = 0; i < COUNT; i++) {
            if (i % 5 === 0) yield* store.upsertMessage(accountOf(i), message(i, 1));
            else if (i % 7 === 1)
              yield* store.upsertMessage(accountOf(i), { ...message(i), isUnread: i % 3 !== 0 });
            if (i % 37 === 0) yield* store.deleteMessage(accountOf(i), `p${i}`);
          }
          for (let i = COUNT; i < COUNT + 50; i++)
            yield* store.upsertMessage(accountOf(i), message(i, 2));
        }),
      );
      yield* sideTableCurrent;
      rows = yield* loadRows;
      trace.start();
      yield* checkAll(rows, operatorSearches, a);
      usesSideTable(trace.stop(), true);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(trace.restore)));
  },
  scaledMs(180_000),
);

it("migration 57 leaves older rows to the background backfill", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmail-operator-text-"));
  const file = join(directory, "mail.sqlite");
  try {
    const legacy = new DatabaseSync(file);
    for (const [index, migration] of MIGRATIONS.slice(0, 56).entries())
      applyNativeMigration(legacy, migration, index + 1);
    legacy
      .prepare("INSERT INTO accounts(id,provider,email,created_at) VALUES(?,?,?,?)")
      .run("gmail:me@example.com", "gmail", "me@example.com", 1);
    const insert = legacy.prepare(
      `INSERT INTO messages(id,account_id,provider_id,thread_id,subject,from_name,from_addr,to_json,cc_json,date,snippet,body_text,body_html,labels_json,attachments_json,headers_json,is_unread,is_starred)
       VALUES(?,'gmail:me@example.com',?,?,'Hello','','x@example.com',?,'[]',?,'','','','["INBOX"]',?,?,0,0)`,
    );
    for (let i = 0; i < 7; i++)
      insert.run(
        `gmail:me@example.com/p${i}`,
        `p${i}`,
        `t${i}`,
        JSON.stringify([{ name: `Person ${i}`, address: `p${i}@example.com` }]),
        i,
        JSON.stringify(
          i % 2 ? [{ filename: `f${i}.pdf`, mimeType: "application/pdf", size: 1 }] : [],
        ),
        // Messages stored before headers were kept have NULL headers.
        i === 4 ? null : JSON.stringify([{ name: "List-Id", value: `<l${i}.example>` }]),
      );
    legacy.close();
    const layer = StoreLive.pipe(
      Layer.provideMerge(databaseLayer(file).pipe(Layer.provide(NodeSystem))),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store;
        const sql = yield* SqlClient.SqlClient;
        const ids = (search: string) =>
          store
            .listThreads({ search, flat: true })
            .pipe(
              Effect.map((rows) => rows.map((row) => row.subject && row.id.slice(-2)).toSorted()),
            );
        const expectResults = Effect.gen(function* () {
          assert.deepStrictEqual(yield* ids("to:p5@"), ["p5"]);
          assert.deepStrictEqual(yield* ids("filename:.pdf"), ["p1", "p3", "p5"]);
          assert.deepStrictEqual(yield* ids("list:l6.example"), ["p6"]);
          assert.deepStrictEqual(yield* ids("to:nobody"), []);
        });
        const [pending] = yield* sql`SELECT COUNT(*) AS n FROM message_operator_text`;
        assert.deepStrictEqual(pending, { n: 0 });
        assert.isFalse(yield* store.operatorTextReady);
        yield* expectResults;
        assert.deepStrictEqual(yield* store.backfillOperatorText(4), {
          processed: 4,
          ready: false,
        });
        yield* expectResults;
        assert.deepStrictEqual(yield* store.backfillOperatorText(4), { processed: 3, ready: true });
        assert.isTrue(yield* store.operatorTextReady);
        yield* expectResults;
        const [filled] = yield* sql`SELECT COUNT(*) AS n FROM message_operator_text`;
        assert.deepStrictEqual(filled, { n: 7 });
      }).pipe(Effect.provide(layer)),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

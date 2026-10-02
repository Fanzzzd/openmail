import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { IncomingMessage } from "./domain.js";
import { MemoryPlatform } from "./platform-memory.js";
import { Store } from "./services.js";
import { StoreLive } from "./store.js";

const message: IncomingMessage = {
  providerId: "one",
  threadId: "thread",
  subject: "Report",
  from: { name: "Alice", address: "alice@example.com" },
  to: [],
  cc: [],
  date: 1,
  snippet: "Report",
  bodyText: "Report",
  bodyHtml: "",
  attachments: [],
  labels: ["INBOX", "UNREAD", "Label_1"],
  isUnread: true,
  isStarred: false,
};

it.effect("hot metadata lookups use the replacement covering indexes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const plans = [
      [
        "messages_unread_threads",
        sql`EXPLAIN QUERY PLAN SELECT account_id,COUNT(DISTINCT thread_id) FROM messages WHERE is_unread=1 GROUP BY account_id`,
      ],
      [
        "messages_thread_labels",
        sql`EXPLAIN QUERY PLAN SELECT labels_json FROM messages WHERE account_id='account' AND thread_id='thread'`,
      ],
      [
        "messages_provider",
        sql`EXPLAIN QUERY PLAN SELECT provider_id FROM messages WHERE account_id='account' AND provider_id='message'`,
      ],
      [
        "messages_rfc_trimmed",
        sql`EXPLAIN QUERY PLAN SELECT id FROM messages WHERE account_id='account' AND trim(rfc_message_id,'<>')='rfc' ORDER BY date DESC LIMIT 1`,
      ],
      [
        "pending_ops_account",
        sql`EXPLAIN QUERY PLAN SELECT provider_id FROM pending_ops WHERE account_id='account'`,
      ],
    ] as const;
    for (const [index, statement] of plans) {
      const rows = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ detail: Schema.String })))(
        yield* statement,
      );
      const detail = rows.map((row) => row.detail).join("\n");
      assert.include(detail, index);
      assert.notMatch(detail, /SCAN (?:messages|pending_ops)(?:$|\n)|TEMP B-TREE/);
    }
    const indexes =
      yield* sql`SELECT name FROM sqlite_master WHERE type='index' AND name IN ('messages_account_thread','messages_rfc_id')`;
    assert.deepStrictEqual(indexes, []);
  }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
);

it.effect(
  "badge projection follows flags, thread regrouping and deletes; identical upserts write nothing",
  () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      const account = yield* store.upsertAccount("gmail", "me@example.com");
      yield* store.upsertMessage(account.id, message);
      const before = yield* sql`SELECT total_changes() AS n`;
      yield* store.upsertMessage(account.id, message);
      assert.deepStrictEqual(yield* sql`SELECT total_changes() AS n`, before);
      yield* store.upsertMessage(account.id, { ...message, providerId: "two", threadId: "other" });
      assert.strictEqual((yield* store.unreadByLabel(undefined, "INBOX", true))["INBOX"], 2);
      yield* store.upsertMessage(account.id, { ...message, providerId: "two" });
      assert.strictEqual((yield* store.unreadByLabel(undefined, "INBOX", true))["INBOX"], 1);
      assert.strictEqual((yield* store.unreadByLabel(undefined, "INBOX", false))["INBOX"], 2);
      yield* store.applyLocalOp(`${account.id}/one`, { kind: "read", value: true });
      assert.strictEqual((yield* store.unreadByLabel(undefined, "INBOX", false))["INBOX"], 1);
      yield* store.applyLocalOp(`${account.id}/one`, { kind: "star", value: true });
      assert.strictEqual((yield* store.unreadByLabel(undefined, "INBOX", false))["STARRED"], 1);
      yield* store.applyLocalOp(`${account.id}/one`, { kind: "archive" });
      assert.isUndefined((yield* store.unreadByLabel(undefined, "INBOX", false))["STARRED"]);
      yield* store.deleteMessage(account.id, "two");
      assert.isUndefined((yield* store.unreadByLabel(undefined, undefined, true))["INBOX"]);
      yield* store.removeAccount(account.id);
      assert.deepStrictEqual(yield* sql`SELECT * FROM message_badges`, []);
    }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
);

it.effect("completed folder and account resets preserve delivered IDs and other accounts", () =>
  Effect.gen(function* () {
    const store = yield* Store;
    const account = yield* store.upsertAccount("outlook", "one@example.com");
    const other = yield* store.upsertAccount("outlook", "two@example.com");
    for (const providerId of ["kept", "stale"])
      yield* store.upsertMessage(account.id, { ...message, providerId });
    yield* store.upsertMessage(account.id, { ...message, providerId: "sent", labels: ["SENT"] });
    yield* store.upsertMessage(other.id, { ...message, providerId: "stale" });
    yield* store.deleteMessagesWithLabel(account.id, "INBOX", ["kept"]);
    assert.isTrue(yield* store.hasMessage(`${account.id}/kept`));
    assert.isFalse(yield* store.hasMessage(`${account.id}/stale`));
    assert.isTrue(yield* store.hasMessage(`${account.id}/sent`));
    yield* store.deleteAccountMessages(account.id, ["kept"]);
    assert.isTrue(yield* store.hasMessage(`${account.id}/kept`));
    assert.isFalse(yield* store.hasMessage(`${account.id}/sent`));
    assert.isTrue(yield* store.hasMessage(`${other.id}/stale`));
  }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
);

it.effect("completion follows company/name updates and deletes without crossing accounts", () =>
  Effect.gen(function* () {
    const store = yield* Store;
    const sql = yield* SqlClient.SqlClient;
    const one = yield* store.upsertAccount("gmail", "one@example.com");
    const two = yield* store.upsertAccount("gmail", "two@example.com");
    yield* store.replaceServerContacts(
      one.id,
      [{ name: "John Smith", address: "john@example.com", company: "Acme Division" }],
      1,
    );
    yield* store.replaceServerContacts(
      two.id,
      [{ name: "John Smith", address: "john@example.com", company: "Other Company" }],
      1,
    );
    assert.strictEqual(
      (yield* store.suggestContacts("john acme", 10, undefined, [one.id])).length,
      1,
    );
    assert.deepStrictEqual(yield* store.suggestContacts("john acme", 10, undefined, [two.id]), []);
    yield* sql`UPDATE contact_organizations SET company='New Division' WHERE account_id=${one.id}`;
    assert.deepStrictEqual(yield* store.suggestContacts("john acme", 10), []);
    assert.strictEqual((yield* store.suggestContacts("john new", 10)).length, 1);
    yield* sql`UPDATE contact_candidates SET name='Jane Smith' WHERE account_id=${one.id}`;
    assert.strictEqual((yield* store.suggestContacts("jane new", 10)).length, 1);
    yield* sql`DELETE FROM contact_organizations WHERE account_id=${one.id}`;
    assert.deepStrictEqual(yield* store.suggestContacts("jane new", 10), []);
    yield* store.removeAccount(one.id);
    assert.deepStrictEqual(yield* store.suggestContacts("jane", 10), []);
    yield* sql`INSERT INTO contact_completion_fts(contact_completion_fts) VALUES('integrity-check')`;
  }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
);

it.effect("common terms preserve grouped/flat pagination and the trigram fallback", () =>
  Effect.gen(function* () {
    const store = yield* Store;
    const sql = yield* SqlClient.SqlClient;
    const account = yield* store.upsertAccount("gmail", "common@example.com");
    yield* store.transaction(
      Effect.gen(function* () {
        for (let i = 0; i < 2100; i++)
          yield* store.upsertMessage(account.id, {
            ...message,
            providerId: `common-${i}`,
            threadId: `group-${Math.floor(i / 3)}`,
            date: i,
            subject: "Weekly report",
            bodyText: "weekly report",
          });
      }),
    );
    const query = { search: "weekly", accountIds: [account.id], limit: 5 };
    assert.strictEqual(yield* store.countThreads({ ...query, search: "-weekly" }), 0);
    assert.strictEqual(yield* store.countThreads({ ...query, search: "-weekly", flat: true }), 0);
    const page = yield* store.listThreads(query);
    assert.deepStrictEqual(
      page.map((row) => row.date),
      [2099, 2096, 2093, 2090, 2087],
    );
    assert.deepStrictEqual(
      (yield* store.listThreads({ ...query, before: 2087, beforeId: page.at(-1)?.id })).map(
        (row) => row.date,
      ),
      [2084, 2081, 2078, 2075, 2072],
    );
    assert.deepStrictEqual(
      (yield* store.listThreads({ ...query, flat: true })).map((row) => row.date),
      [2099, 2098, 2097, 2096, 2095],
    );
    yield* sql`UPDATE search_word_index SET ready=0 WHERE kind='messages'`;
    assert.deepStrictEqual(
      (yield* store.listThreads(query)).map((row) => row.date),
      page.map((row) => row.date),
    );
    assert.strictEqual(yield* store.countThreads(query), 700);
    assert.strictEqual(yield* store.countThreads({ ...query, flat: true }), 2100);
    for (const i of [2097, 2098, 2099])
      yield* store.applyLocalOp(`${account.id}/common-${i}`, { kind: "trash" });
    assert.strictEqual(yield* store.countThreads(query), 699);
    assert.strictEqual(yield* store.countThreads({ ...query, flat: true }), 2097);
    yield* store.removeAccount(account.id);
    assert.deepStrictEqual(yield* sql`SELECT * FROM message_search_meta`, []);
  }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
);

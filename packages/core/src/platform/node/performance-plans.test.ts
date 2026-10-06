import { applyNativeMigration } from "./migrations.js";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { Store, Providers, Secrets, type ProviderAdapter } from "../../services.js";
import {
  PerformanceMailbox,
  fixtureAccounts,
  fixtureNow,
  seedMailbox,
  traceQueries,
} from "./fixtures/performance-mailbox.js";
import { CurrentTransformer, type Transformer } from "effect/sql/Statement";
import { StoreLive } from "../../store.js";
import { MemoryPlatform } from "./platform-memory.js";
import { type IncomingMessage } from "../../domain.js";
import { DatabaseSync } from "node:sqlite";
import { databaseLayer, MIGRATIONS } from "./db.js";
import { Mailbox } from "../../mailbox.js";
import { fakeServer } from "./testing.js";
import { makeFakeProvider, type FakeServer } from "./fake-provider.js";
import { MailboxLive } from "../../mailbox-live.js";
import { invitesFromRaw } from "./portable-helpers.js";
import { first } from "../../sql-rows.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSemanticIndexer } from "../../semantic-indexer.js";
import { type ModelRuntime, unavailableVision } from "../../media.js";
import { vi } from "vitest";
import { NodeSystem } from "./platform-node.js";
it.effect("actual health, stale, reset and budget queries use indexed metadata", () => {
  const trace = traceQueries();
  return Effect.gen(function* () {
    yield* seedMailbox(120);
    const store = yield* Store;
    const imap = fixtureAccounts[2],
      gmail = fixtureAccounts[0];
    trace.start();
    yield* store.messageIdForProvider(gmail, "absent");
    yield* store.syncHealthLocal(imap, "Folder_2", true);
    yield* store.syncHealthLocal(gmail, "Folder_0", false);
    yield* store.staleCandidates(imap, ["Folder_2"], true, "7:9:Folder_2", 2);
    yield* store.staleCandidates(gmail, ["INBOX", "DRAFT"], false, "m5", 2);
    yield* store.resetCandidates(imap, {
      _tag: "RebuildFolder",
      previous: { path: "Folder_2", uidValidity: "7" },
      keep: [],
      since: fixtureNow - 86400000,
    });
    yield* store.resetCandidates(gmail, { _tag: "Reset", keep: [], since: fixtureNow - 86400000 });
    yield* store.listThreads({ search: '"alpha AROUND 0 beta"', limit: 5 });
    const initialQueries = trace.stop();
    trace.start();
    yield* store.listThreads({ search: '"alpha AROUND 3 beta"', limit: 5 });
    const proximityQueries = trace.stop();
    trace.start();
    yield* store.bodySizes;
    yield* store.evictBodyBudget(1, true);
    const queries = [...initialQueries, ...proximityQueries, ...trace.stop()];
    assert.isAbove(queries.length, 8);
    for (const query of queries) {
      const plan = query.plan.join("\n");
      assert.notMatch(plan, /\bSCAN (?:messages|m)(?:$|\n)/, query.sql);
      if (query.sql.includes("ranks AS MATERIALIZED"))
        assert.notMatch(
          plan,
          /messages_(?:words|fts) VIRTUAL TABLE INDEX[^:]*:[^\n]*=/,
          "BM25 must use one MATCH cursor, not a rowid probe for each candidate",
        );
    }
    const lookup = queries.find((q) => q.sql.includes("ORDER BY date DESC,id LIMIT 1"));
    assert.ok(lookup);
    assert.include(
      lookup.plan.join("\n"),
      "COVERING INDEX messages_provider (account_id=? AND provider_id=?)",
    );
    assert.notInclude(lookup.plan.join("\n"), "TEMP B-TREE");
    const health = queries.find((q) => q.sql.includes("AS total") && q.sql.includes("substr"));
    assert.ok(health);
    assert.include(health.plan.join("\n"), "messages_imap_scope");
    const stale = queries.filter((q) => q.sql.includes("draftOnly"));
    assert.isAbove(stale.length, 0);
    for (const query of stale) {
      assert.notInclude(query.plan.join("\n"), "TEMP B-TREE FOR ORDER BY", query.sql);
      assert.match(query.plan.join("\n"), /messages_provider|messages_imap_scope/);
    }
    const window = queries.find(
      (q) =>
        q.sql.includes("AS providerId") && /date\s*>=/.test(q.sql) && !q.sql.includes("substr"),
    );
    assert.ok(window);
    assert.include(window.plan.join("\n"), "messages_account_date");
    const sizes = queries.find((q) => q.sql.includes("SUM(body_bytes)"));
    assert.ok(sizes);
    assert.include(sizes.plan.join("\n"), "COVERING INDEX messages_body_sizes");
    const proximity = queries.find((q) => q.sql.includes("WITH candidates AS NOT MATERIALIZED"));
    assert.ok(proximity);
    assert.match(proximity.plan.join("\n"), /SCAN m USING INDEX messages_list_date_id/);
    assert.notMatch(proximity.plan.join("\n"), /word_positions|MATERIALIZE positions/);
    assert.include(proximity.plan.join("\n"), "SCAN messages_words VIRTUAL TABLE INDEX");
    assert.notInclude(proximity.plan.join("\n"), "MATERIALIZE matches");
    assert.include(proximity.plan.join("\n"), "MATERIALIZE page");
    assert.notInclude(proximity.plan.join("\n"), "TEMP B-TREE FOR GROUP BY");
    assert.include(proximity.plan.join("\n"), "SEARCH m USING INDEX messages_thread_list_date_id");
    const spacedProximity = proximityQueries.find(
      (q) => q.sql.includes("WITH matches AS MATERIALIZED") && q.sql.includes("positions AS"),
    );
    assert.ok(spacedProximity);
    assert.include(spacedProximity.sql, "AND (rowid+0) IN (");
    assert.include(spacedProximity.sql, "SELECT rowid FROM messages WHERE id IN");
    assert.include(
      spacedProximity.plan.join("\n"),
      "SEARCH m USING INDEX sqlite_autoindex_messages_1 (id=?)",
    );
    assert.notInclude(spacedProximity.plan.join("\n"), "SCAN m USING INDEX messages_list_date_id");
    assert.strictEqual(
      spacedProximity.plan.filter((line) => line.includes("SCAN messages_word_positions")).length,
      1,
    );
    const nearPage = proximityQueries.find(
      (query) =>
        query.sql.includes("WITH candidates AS NOT MATERIALIZED") &&
        !query.sql.includes("positions AS"),
    );
    assert.ok(nearPage);
    assert.match(nearPage.plan.join("\n"), /SCAN m USING INDEX messages_list_date_id/);
    assert.notInclude(nearPage.plan.join("\n"), "SCAN messages_words VIRTUAL TABLE INDEX");
    assert.match(
      nearPage.plan.join("\n"),
      /SEARCH m USING (?:COVERING )?INDEX messages_thread_list_date_id/,
    );
    assert.notMatch(
      nearPage.plan.join("\n"),
      /word_positions|MATERIALIZE matches|TEMP B-TREE FOR GROUP BY/,
    );
    // The materialized page and each selected thread's participants may sort;
    // the mailbox walk itself must retain its date index and bounded LIMIT.
    assert.include(nearPage.sql, "ORDER BY m.list_date DESC,m.id DESC LIMIT");
    assert.isAtMost(
      nearPage.plan.filter((line) => line.includes("TEMP B-TREE FOR ORDER BY")).length,
      2,
    );
    const lru = queries.find((q) => q.sql.includes("AS opened_at"));
    assert.ok(lru);
    assert.include(lru.plan.join("\n"), "messages_body_lru");
    const nextLru = queries.find(
      (q) => q.sql.includes("AS opened_at") && q.sql.includes("date),id)>"),
    );
    assert.ok(nextLru);
    assert.match(nextLru.plan.join("\n"), /SEARCH messages USING INDEX messages_body_lru/);
  }).pipe(Effect.provide(PerformanceMailbox()), Effect.ensuring(Effect.sync(trace.restore)));
});

it.effect("stale keyset pages wrap and include distinct orphan drafts", () =>
  Effect.gen(function* () {
    yield* seedMailbox(120);
    const store = yield* Store,
      gmail = fixtureAccounts[0];
    const expected = (yield* store.staleCandidates(gmail, ["INBOX"], false, "", 1000)).map(
      (row) => row.providerId,
    );
    let after = "";
    const actual: string[] = [];
    while (actual.length < expected.length) {
      const rows = yield* store.staleCandidates(gmail, ["INBOX"], false, after, 7);
      actual.push(...rows.map((row) => row.providerId));
      after = rows.at(-1)?.providerId ?? "";
    }
    assert.deepStrictEqual(actual.slice(0, expected.length), expected);
    assert.deepStrictEqual(
      actual.slice(expected.length),
      expected.slice(0, actual.length - expected.length),
    );
    assert.deepStrictEqual(yield* store.staleCandidates(gmail, [], false, "", 10), []);
    const last = expected.at(-1);
    assert.ok(last);
    assert.deepStrictEqual(
      (yield* store.staleCandidates(gmail, ["INBOX"], false, last, 3)).map((row) => row.providerId),
      expected.slice(0, 3),
    );
    const draftMessage = {
      to: [],
      cc: [],
      bcc: [],
      subject: "Draft",
      text: "Text",
      attachments: [],
    };
    for (const [id, remote] of [
      ["one", "😀"],
      ["two", "\ue000"],
      ["duplicate", "😀"],
      ["cached", "m0"],
    ]) {
      if (!id || !remote) continue;
      yield* store.putDraft({ id, accountId: gmail, message: draftMessage });
      yield* store.setDraftRemote(id, { draftId: id, messageId: remote }, null);
    }
    const sql = yield* SqlClient.SqlClient;
    const sorted =
      yield* sql`SELECT DISTINCT remote_message_id FROM drafts WHERE remote_message_id NOT IN ('m0') ORDER BY remote_message_id`;
    assert.deepStrictEqual(
      (yield* store.staleCandidates(gmail, ["DRAFT"], false, "", 10)).map((row) => row.providerId),
      sorted.map((row) => row.remote_message_id),
    );
    const mixed = yield* store.staleCandidates(gmail, ["INBOX", "DRAFT"], false, last, 4);
    assert.deepStrictEqual(
      mixed.map((row) => row.providerId),
      ["\ue000", "😀", ...expected.slice(0, 2)],
    );
  }).pipe(Effect.provide(PerformanceMailbox())),
);

{
  const layer = StoreLive.pipe(Layer.provideMerge(MemoryPlatform()));

  it.effect(
    "contact completion starts from FTS rowids and expands companies using the address index",
    () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const sql = yield* SqlClient.SqlClient;
        const account = yield* store.upsertAccount("gmail", "one@example.com");
        yield* store.replaceServerContacts(
          account.id,
          [{ name: "John Smith", address: "john@example.com", company: "Acme" }],
          1,
        );
        yield* sql`WITH RECURSIVE entries(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM entries WHERE n<160000)
      INSERT INTO contact_candidates(id,account_id,address,name,date,weight,source)
      SELECT 'fixture:'||n,${account.id},'person'||n||'@example.org','Correspondent '||n,0,1,1 FROM entries`;
        const statements: (readonly [string, ReadonlyArray<unknown>])[] = [];
        const capture: Transformer = (statement) =>
          Effect.sync(() => {
            statements.push(statement.compile());
            return statement;
          });
        assert.deepStrictEqual(
          yield* store
            .suggestContacts("john acme", 10)
            .pipe(Effect.provideService(CurrentTransformer, capture)),
          [{ name: "John Smith", address: "john@example.com" }],
        );
        const query = statements.find(([text]) => text.includes("contact_completion_fts"));
        assert.ok(query);
        const [text, parameters] = query;
        const plan = yield* sql.unsafe(`EXPLAIN QUERY PLAN ${text}`, parameters);
        const details = Schema.decodeUnknownSync(
          Schema.Array(Schema.Struct({ detail: Schema.String })),
        )(plan)
          .map((row) => row.detail)
          .join("\n");
        assert.match(details, /SEARCH c USING INTEGER PRIMARY KEY/);
        assert.match(details, /contact_candidates_(?:address|score)/);
        assert.match(details, /contact_completion_fts/);
        assert.strictEqual(/SCAN (?:c|cc|contact_candidates)\b/.test(details), false, details);
        const started = performance.now();
        assert.deepStrictEqual(yield* store.suggestContacts("john acme", 10), [
          { name: "John Smith", address: "john@example.com" },
        ]);
        yield* Effect.logInfo(
          `160k contact completion: ${Math.round(performance.now() - started)} ms`,
        );
      }).pipe(Effect.provide(layer)),
  );
}

{
  it.effect("hot metadata lookups use the replacement covering indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const plans = [
        [
          "messages_unread_threads",
          sql`EXPLAIN QUERY PLAN SELECT account_id,COUNT(DISTINCT thread_id) FROM messages WHERE is_unread=1 GROUP BY account_id`,
        ],
        [
          "messages_starred_threads",
          sql`EXPLAIN QUERY PLAN SELECT 1 FROM messages WHERE account_id='account' AND thread_id='thread' AND is_starred=1 LIMIT 1`,
        ],
        [
          "messages_thread_participants",
          sql`EXPLAIN QUERY PLAN SELECT from_name,from_addr,MIN(date) FROM messages WHERE account_id='account' AND thread_id='thread' GROUP BY from_addr`,
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
        const rows = Schema.decodeUnknownSync(
          Schema.Array(Schema.Struct({ detail: Schema.String })),
        )(yield* statement);
        const detail = rows.map((row) => row.detail).join("\n");
        assert.include(detail, index);
        if (index === "messages_starred_threads")
          assert.include(detail, "USING COVERING INDEX messages_starred_threads");
        assert.notMatch(detail, /SCAN (?:messages|pending_ops)(?:$|\n)|TEMP B-TREE/);
      }
      const indexes =
        yield* sql`SELECT name FROM sqlite_master WHERE type='index' AND name IN ('messages_account_thread','messages_rfc_id')`;
      assert.deepStrictEqual(indexes, []);
    }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
  );
}

{
  it.effect(
    "known senders return only requested addresses with indexed lookups and account isolation",
    () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const sql = yield* SqlClient.SqlClient;
        const account = yield* store.upsertAccount("gmail", "me@gmail.com");
        const other = yield* store.upsertAccount("gmail", "other@gmail.com");
        yield* store.replaceServerContacts(
          account.id,
          [{ name: "Known", address: "contact@example.com" }],
          1,
        );
        yield* store.replaceServerContacts(
          other.id,
          [{ name: "Other", address: "other-contact@example.com" }],
          1,
        );
        yield* store.rememberMailedAddresses(account.id, [
          "recipient@example.com",
          ...Array.from({ length: 2000 }, (_, index) => `history${index}@example.com`),
        ]);
        yield* store.rememberMailedAddresses(other.id, ["other-recipient@example.com"]);
        const statements: (readonly [string, ReadonlyArray<unknown>])[] = [];
        const capture: Transformer = (statement) =>
          Effect.sync(() => {
            statements.push(statement.compile());
            return statement;
          });
        const known = yield* store
          .knownSenders(account.id, [
            " CONTACT@example.com ",
            "recipient@example.com",
            "recipient@example.com",
            "other-contact@example.com",
            "other-recipient@example.com",
            "unknown@example.com",
          ])
          .pipe(Effect.provideService(CurrentTransformer, capture));
        assert.deepStrictEqual(known.toSorted(), ["contact@example.com", "recipient@example.com"]);
        assert.deepStrictEqual(yield* store.knownSenders(account.id, []), []);
        assert.deepStrictEqual(yield* store.knownSenders(account.id, [account.email]), [
          account.email,
        ]);
        assert.strictEqual(statements.length, 1);
        const query = statements[0];
        assert.ok(query);
        const plan = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ detail: Schema.String })),
        )(yield* sql.unsafe(`EXPLAIN QUERY PLAN ${query[0]}`, query[1]));
        assert.strictEqual(plan.filter((row) => /SEARCH .*address=\?/.test(row.detail)).length, 2);
        assert.ok(
          !plan.some((row) => /SCAN (messages|server_contacts|mailed_addresses)/.test(row.detail)),
        );
      }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
  );
}

{
  it.effect(
    "incoming pending lookup uses the account index, filters ids and keeps queue order",
    () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const sql = yield* SqlClient.SqlClient;
        const account = yield* store.upsertAccount("gmail", "me@example.com");
        const other = yield* store.upsertAccount("gmail", "other@example.com");
        yield* store.enqueueOp(account.id, "one", { kind: "star", value: true });
        yield* store.enqueueOp(account.id, "ignored", { kind: "archive" });
        yield* store.enqueueOp(other.id, "one", { kind: "trash" });
        yield* store.enqueueOp(account.id, "one", { kind: "read", value: true });
        const statements: (readonly [string, ReadonlyArray<unknown>])[] = [];
        const capture: Transformer = (statement) =>
          Effect.sync(() => {
            statements.push(statement.compile());
            return statement;
          });
        const pending = yield* store
          .pendingOpsForMessages(account.id, ["one"])
          .pipe(Effect.provideService(CurrentTransformer, capture));
        assert.deepStrictEqual(
          pending.map((item) => item.op),
          [
            { kind: "star", value: true },
            { kind: "read", value: true },
          ],
        );
        assert.isTrue(
          pending.every((item) => item.accountId === account.id && item.providerId === "one"),
        );
        assert.strictEqual(statements.length, 1);
        const statement = statements[0];
        assert.ok(statement);
        const plan = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ detail: Schema.String })),
        )(yield* sql.unsafe(`EXPLAIN QUERY PLAN ${statement[0]}`, statement[1]));
        assert.isTrue(plan.some((row) => row.detail.includes("pending_ops_account")));
        statements.length = 0;
        assert.deepStrictEqual(
          yield* store
            .pendingOpsForMessages(account.id, [])
            .pipe(Effect.provideService(CurrentTransformer, capture)),
          [],
        );
        assert.strictEqual(statements.length, 0);
      }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
  );
}

{
  it.effect(
    "invitation history uses the UID index, has bounded results, and invalidates when the cached content changes",
    () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const sql = yield* SqlClient.SqlClient;
        const account = yield* store.upsertAccount("gmail", "me@example.com");
        const [parsed] = yield* invitesFromRaw(raw("indexed"));
        assert.ok(parsed);
        for (let i = 0; i < 225; i++) {
          const message = incoming(`cached-${i}`);
          yield* store.upsertMessage(account.id, message);
          yield* store.cacheInvites(`${account.id}/${message.providerId}`, [
            { ...parsed.invite, sequence: i },
          ]);
        }
        const history = yield* store.cachedInvites(account.id, "indexed");
        assert.strictEqual(history.length, 200);
        assert.strictEqual(history[0]?.sequence, 25);
        assert.strictEqual(history.at(-1)?.sequence, 224);
        assert.strictEqual(
          (yield* store.inviteSiblingIds(account.id, "indexed", "none")).length,
          20,
        );
        assert.deepStrictEqual(yield* store.cachedInvites("another-account", "indexed"), []);
        const plan =
          yield* sql`EXPLAIN QUERY PLAN SELECT invite_json FROM calendar_invites WHERE account_id=${account.id} AND uid='indexed' ORDER BY sequence DESC,message_date DESC LIMIT 200`;
        const rows = Schema.decodeUnknownSync(
          Schema.Array(Schema.Struct({ detail: Schema.String })),
        )(plan);
        assert.ok(rows.some((row) => row.detail.includes("calendar_invites_uid")));
        assert.ok(!rows.some((row) => row.detail.includes("SCAN messages")));
        yield* store.upsertMessage(account.id, { ...incoming("cached-224"), bodyText: "Changed" });
        assert.strictEqual(
          (yield* store.cachedInvites(account.id, "indexed")).at(-1)?.sequence,
          223,
        );
      }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
  );

  const incoming = (id: string): IncomingMessage => ({
    providerId: id,
    threadId: id,
    subject: "Meeting",
    date: 1,
    snippet: "",
    from: { name: "", address: "organizer@example.com" },
    to: [{ name: "", address: "me@example.com" }],
    cc: [],
    bodyText: "",
    bodyHtml: "",
    labels: ["INBOX"],
    attachments: [{ filename: "meeting.ics", mimeType: "text/calendar", size: 1 }],
    hasCalendar: true,
    isUnread: false,
    isStarred: false,
  });

  const raw = (uid: string, sequence = 1, method = "REQUEST") =>
    Buffer.from(
      `From: organizer@example.com\r\nContent-Type: text/calendar; method=${method}\r\n\r\nBEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:${method}\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nSEQUENCE:${sequence}\r\nDTSTART:20261026T090000Z\r\nORGANIZER:mailto:organizer@example.com\r\nATTENDEE;PARTSTAT=ACCEPTED:mailto:me@example.com\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`,
    );
}

{
  const old = -400 * 86_400_000;

  const mail = (providerId: string, change: Partial<IncomingMessage> = {}): IncomingMessage => ({
    providerId,
    threadId: providerId,
    date: old,
    subject: providerId,
    from: { name: "", address: "sender@example.com" },
    to: [],
    cc: [],
    bodyText: "1234567890",
    bodyHtml: "",
    labels: ["ARCHIVE"],
    isStarred: false,
    isUnread: false,
    snippet: "header",
    attachments: [],
    ...change,
  });

  it.effect(
    "byte accounting survives Unicode updates, eviction and deletes; LRU order uses the index",
    () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const sql = yield* SqlClient.SqlClient;
        const account = yield* store.upsertAccount("gmail", "bytes@example.com");
        const values = first(
          Schema.Struct({ bytes: Schema.Number, total: Schema.Number, rowid: Schema.Number }),
        )(
          sql`SELECT m.body_bytes AS bytes,b.total_bytes AS total,m.rowid FROM messages m CROSS JOIN body_cache_budget b WHERE m.id=${`${account.id}/bytes`} AND b.id=1`,
        );
        yield* store.upsertMessage(
          account.id,
          mail("bytes", { bodyText: "世界", bodyHtml: "<b>é</b>" }),
        );
        const before = yield* values;
        assert.ok(before._tag === "Some");
        assert.strictEqual(before.value.bytes, 15);
        assert.strictEqual(before.value.total, 15);
        yield* store.upsertMessage(account.id, mail("bytes", { bodyText: "z", bodyHtml: "" }));
        const updated = yield* values;
        assert.ok(updated._tag === "Some");
        assert.strictEqual(updated.value.bytes, 1);
        assert.strictEqual(updated.value.total, 1);
        assert.strictEqual(updated.value.rowid, before.value.rowid);
        const plan = yield* first(Schema.Struct({ detail: Schema.String }))(
          sql`EXPLAIN QUERY PLAN SELECT id FROM messages WHERE body_cached=1 AND body_bytes>0 ORDER BY COALESCE(body_opened_at,date),id LIMIT 100`,
        );
        assert.ok(plan._tag === "Some" && plan.value.detail.includes("messages_body_lru"));
        yield* store.upsertMessage(account.id, mail("extra"));
        yield* store.evictBodyBudget(5);
        const evicted = yield* values;
        assert.ok(evicted._tag === "Some");
        assert.strictEqual(evicted.value.bytes, 0);
        assert.strictEqual(evicted.value.total, 0);
        assert.strictEqual(evicted.value.rowid, before.value.rowid);
        yield* store.upsertMessage(account.id, mail("bytes", { bodyText: "z", bodyHtml: "" }));
        yield* store.deleteMessage(account.id, "bytes");
        const deleted = yield* first(Schema.Struct({ total_bytes: Schema.Number }))(
          sql`SELECT total_bytes FROM body_cache_budget WHERE id=1`,
        );
        assert.ok(deleted._tag === "Some");
        assert.strictEqual(deleted.value.total_bytes, 0);
      }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
  );
}

{
  const mail = (id: string, overrides: Partial<IncomingMessage> = {}): IncomingMessage => ({
    providerId: id,
    threadId: id,
    subject: `Header ${id}`,
    from: { name: "Alice", address: "a@example.com" },
    to: [],
    cc: [],
    date: 1,
    snippet: "preview",
    bodyText: "unique-body-term",
    bodyHtml: "<p>body</p>",
    labels: ["ARCHIVE"],
    attachments: [],
    isUnread: false,
    isStarred: false,
    ...overrides,
  });

  const withMailbox = <A, E>(
    server: FakeServer,
    program: Effect.Effect<A, E, Mailbox | Store | SqlClient.SqlClient | Secrets>,
    adapt: (base: ProviderAdapter, store: Store["Service"]) => ProviderAdapter = (base) => base,
  ) => {
    const providers = Layer.effect(
      Providers,
      Effect.gen(function* () {
        const store = yield* Store;
        const adapter = adapt(makeFakeProvider(server), store);
        return Providers.of({ get: () => adapter });
      }),
    ).pipe(Layer.provideMerge(StoreLive), Layer.provideMerge(MemoryPlatform()));
    return program.pipe(
      Effect.provide(MailboxLive({ backgroundFlush: false }).pipe(Layer.provideMerge(providers))),
    );
  };

  it.effect(
    "eviction uses a date index and runs daily, with an explicit policy-change override",
    () => {
      const server = fakeServer("a@example.com");
      return withMailbox(
        server,
        Effect.gen(function* () {
          const s = yield* Store;
          const sql = yield* SqlClient.SqlClient;
          const account = yield* s.upsertAccount("gmail", server.email);
          const now = 500 * 86_400_000;
          yield* s.upsertMessage(account.id, mail("old"));
          assert.strictEqual(yield* s.evictBodies(account.id, now), 1);
          yield* s.upsertMessage(account.id, mail("later"));
          assert.strictEqual(yield* s.evictBodies(account.id, now + 1), 0);
          assert.strictEqual((yield* s.getMessage(`${account.id}/later`)).bodyCached, true);
          assert.strictEqual(yield* s.evictBodies(account.id, now + 86_400_000), 1);
          const plan = yield* sql`EXPLAIN QUERY PLAN SELECT id,date,labels_json FROM messages
      WHERE account_id=${account.id} AND body_cached=1 AND date < ${now - 30 * 86_400_000} ORDER BY date,id LIMIT 200`;
          assert.ok(JSON.stringify(plan).includes("messages_cache_page"));
          assert.ok(!JSON.stringify(plan).includes("TEMP B-TREE"));
          yield* s.upsertMessage(account.id, mail("policy"));
          assert.strictEqual(yield* s.evictBodies(account.id, now + 86_400_001, true), 1);
        }),
      );
    },
  );
}

{
  const withStore = <A, E>(body: Effect.Effect<A, E, Store | SqlClient.SqlClient>) =>
    body.pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform()))));

  const vector = (dim: number, index = 0) =>
    Array.from({ length: dim }, (_, i) => (i === index ? 1 : 0));

  const message = (overrides: Partial<IncomingMessage> = {}): IncomingMessage => ({
    providerId: "m",
    threadId: "t",
    subject: "Mail",
    from: { name: "Alice", address: "alice@example.com" },
    to: [],
    cc: [],
    date: 1000,
    snippet: "",
    bodyText: "Airport passport boarding pass.",
    bodyHtml: "",
    attachments: [],
    labels: ["INBOX"],
    isUnread: true,
    isStarred: false,
    ...overrides,
  });

  const fakeModels = (calls: string[], version = "test-v1"): ModelRuntime => ({
    version,
    status: Effect.succeed({ kind: "ready", total: 1, version }),
    ensure: (download) =>
      Effect.sync(() => {
        calls.push(`ensure:${download}`);
      }),
    stop: () => Effect.void,
    embedder: {
      version,
      text: (text, mode) =>
        Effect.sync(() => {
          calls.push(`${mode}:${text}`);
          return vector(384);
        }),
    },
    images: {
      version,
      query: () => Effect.succeed(vector(512)),
      image: () =>
        Effect.succeed([
          {
            vector: vector(512),
            region: {
              imageWidth: 800,
              imageHeight: 5200,
              box: { x: 0, y: 0, width: 800, height: 5200 },
              tile: { x: 0, y: 0, width: 800, height: 5200 },
            },
          },
          {
            vector: vector(512),
            region: {
              imageWidth: 800,
              imageHeight: 5200,
              box: { x: 0, y: 896, width: 800, height: 1024 },
              tile: { x: 0, y: 896, width: 800, height: 1024 },
            },
          },
        ]),
    },
  });

  const indexer = (store: Store["Service"], models: ModelRuntime, battery = false, busy = false) =>
    makeSemanticIndexer(
      {
        store: store.media,
        vision: unavailableVision,
        onBattery: () => battery,
        busy: Effect.succeed(busy),
        changed: Effect.void,
        message: (id) => store.getMessage(id).pipe(Effect.orDie),
        attachment: () => Effect.succeed(new Uint8Array([1])),
        inline: () => Effect.succeed([]),
      },
      store,
      models,
    );

  const setup = Effect.gen(function* () {
    const store = yield* Store;
    const account = yield* store.upsertAccount("gmail", "test@example.com");
    yield* store.upsertMessage(account.id, message());
    return { store, account, id: `${account.id}/m` };
  });

  it.effect("body chunk cap and indexed queue ordering bound backfill work", () =>
    withStore(
      Effect.gen(function* () {
        const { store, account } = yield* setup;
        const sql = yield* SqlClient.SqlClient;
        yield* store.upsertMessage(
          account.id,
          message({ bodyText: "body sentence. ".repeat(10000) }),
        );
        yield* store.semantics.setEnabled(true);
        const calls: string[] = [];
        yield* (yield* indexer(store, fakeModels(calls))).batch();
        assert.strictEqual(calls.filter((call) => call.startsWith("passage:")).length, 256);
        const plan =
          yield* sql`EXPLAIN QUERY PLAN SELECT j.message_id FROM semantic_jobs j INDEXED BY semantic_jobs_priority CROSS JOIN messages m ON m.id=j.message_id CROSS JOIN accounts a ON a.id=m.account_id
    WHERE j.status='queued' AND j.retry_at<=0 AND j.attempts<5 AND a.needs_reauth=0 ORDER BY j.priority_at DESC,j.message_id LIMIT 1`;
        assert.ok(!plan.some((row) => String(row.detail).includes("TEMP B-TREE")));
      }),
    ),
  );
}

for (const messageCount of [50, 150_000]) {
  const testMigration =
    messageCount === 50 ? it.effect : it.effect.skipIf(process.env.OPENMAIL_PERF !== "1");
  testMigration(
    `${messageCount === 50 ? "50" : "150k"}-message migration backfills sent history; suggestions use the recipient index and track upserts/deletion`,
    () =>
      Effect.gen(function* () {
        const dir = yield* Effect.acquireRelease(
          Effect.sync(() => mkdtempSync(join(tmpdir(), "openmail-sent-recipients-"))),
          (folder) => Effect.sync(() => rmSync(folder, { recursive: true, force: true })),
        );
        const file = join(dir, "mail.db");
        yield* Effect.sync(() => {
          const db = new DatabaseSync(file);
          for (const migration of MIGRATIONS.slice(0, 21)) applyNativeMigration(db, migration);
          db.exec("PRAGMA user_version=21");
          db.exec(
            "INSERT INTO accounts(id,provider,email,created_at) VALUES ('gmail:me@example.com','gmail','me@example.com',0)",
          );
          db.exec(`WITH RECURSIVE fixture(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM fixture WHERE n<${messageCount})
      INSERT INTO messages(id,account_id,provider_id,thread_id,subject,from_name,from_addr,to_json,cc_json,date,snippet,body_text,body_html,labels_json,attachments_json,is_unread,is_starred)
      SELECT 'gmail:me@example.com/'||n,'gmail:me@example.com',CAST(n AS TEXT),CAST(n AS TEXT),'','','alias@example.org','[{"name":"Alice","address":"ALICE@example.com"}]','[]',n,'','','',CASE WHEN n=1 THEN '["SENT"]' ELSE '["INBOX"]' END,'[]',0,0 FROM fixture`);
          db.exec("UPDATE messages SET to_json='invalid legacy JSON' WHERE provider_id='2'");
          db.close();
        });
        yield* Effect.gen(function* () {
          const store = yield* Store;
          const spy = yield* Effect.acquireRelease(
            Effect.sync(() => vi.spyOn(DatabaseSync.prototype, "prepare")),
            (spy) => Effect.sync(() => spy.mockRestore()),
          );
          const rows = yield* store.senderHistory(["alice@example.com"]);
          assert.deepStrictEqual(rows, [
            {
              accountId: "gmail:me@example.com",
              address: "alias@example.org",
              recipient: "alice@example.com",
              count: 1,
              lastSent: 1,
            },
          ]);
          const query = spy.mock.calls.find(([sql]) => sql.includes("AS last_sent"))?.[0];
          assert.ok(query);
          const plan = yield* Effect.sync(() => {
            const db = new DatabaseSync(file);
            try {
              return Schema.decodeUnknownSync(
                Schema.Array(Schema.Struct({ detail: Schema.String })),
              )(
                db
                  .prepare(`EXPLAIN QUERY PLAN ${query}`)
                  .all(JSON.stringify(["alice@example.com"])),
              );
            } finally {
              db.close();
            }
          });
          assert.ok(
            plan.some((row) => row.detail.includes("sent_recipients_address")),
            JSON.stringify(plan),
          );
          spy.mockClear();
          assert.deepStrictEqual(yield* store.senderHistory([]), []);
          assert.strictEqual(spy.mock.calls.length, 0);
          const updated = {
            providerId: "1",
            threadId: "1",
            subject: "",
            from: { name: "", address: "other@example.org" },
            to: [{ name: "Bob", address: "bob@example.com" }],
            cc: [{ name: "Alice", address: "alice@example.com" }],
            date: 2,
            snippet: "",
            bodyText: "",
            bodyHtml: "",
            labels: ["SENT"],
            attachments: [],
            isUnread: false,
            isStarred: false,
          };
          yield* store.upsertMessage("gmail:me@example.com", updated);
          assert.deepStrictEqual(yield* store.senderHistory(["ALICE@example.com"]), [
            {
              accountId: "gmail:me@example.com",
              address: "other@example.org",
              recipient: "alice@example.com",
              count: 1,
              lastSent: 2,
            },
          ]);
          const corrupt = yield* Effect.sync(() => {
            const db = new DatabaseSync(file);
            try {
              db.exec(
                "UPDATE messages SET to_json='invalid legacy JSON',cc_json='[42,\"broken\"]' WHERE provider_id='1'",
              );
              return true;
            } finally {
              db.close();
            }
          });
          assert.ok(corrupt);
          assert.strictEqual(yield* store.hasMessage("gmail:me@example.com/1"), true);
          assert.deepStrictEqual(
            yield* store.senderHistory(["alice@example.com", "bob@example.com"]),
            [],
          );
          yield* store.upsertMessage("gmail:me@example.com", updated);
          assert.strictEqual((yield* store.senderHistory(["alice@example.com"])).length, 1);
          yield* store.upsertMessage("gmail:me@example.com", { ...updated, labels: ["INBOX"] });
          assert.deepStrictEqual(yield* store.senderHistory(["alice@example.com"]), []);
          yield* store.upsertMessage("gmail:me@example.com", updated);
          assert.strictEqual((yield* store.senderHistory(["alice@example.com"])).length, 1);
          yield* store.deleteMessage("gmail:me@example.com", "1");
          assert.deepStrictEqual(yield* store.senderHistory(["alice@example.com"]), []);
        }).pipe(
          Effect.provide(
            StoreLive.pipe(Layer.provide(databaseLayer(file).pipe(Layer.provide(NodeSystem)))),
          ),
        );
      }),
    { timeout: 120_000 },
  );
}

it.effect("missing vector repair probes jobs by message id within its bounded scan", () => {
  const trace = traceQueries();
  return Effect.gen(function* () {
    const store = yield* Store;
    const sql = yield* SqlClient.SqlClient;
    const account = yield* store.upsertAccount("gmail", "repair@example.com");
    yield* store.upsertMessage(account.id, {
      providerId: "m",
      threadId: "t",
      subject: "",
      from: { name: "", address: "a@example.com" },
      to: [],
      cc: [],
      date: 1,
      snippet: "",
      bodyText: "Refilled",
      bodyHtml: "",
      attachments: [],
      labels: ["INBOX"],
      isUnread: false,
      isStarred: false,
    });
    yield* sql`INSERT INTO vector_items(message_id,kind,version,provenance_json) SELECT id,'text','v1','{}' FROM messages`;
    yield* sql`UPDATE semantic_jobs SET status='done'`;
    trace.start();
    assert.strictEqual(yield* store.semantics.repairMissingVectors, 1);
    const queries = trace.stop();
    const checks = queries.find((query) => query.sql.includes("CROSS JOIN semantic_jobs"));
    assert.ok(checks);
    assert.include(checks.plan.join("\n"), "sqlite_autoindex_semantic_jobs_1 (message_id=?)");
    assert.notMatch(checks.plan.join("\n"), /semantic_jobs_(?:priority|pending) \(status=/);
    const writes = queries.filter((query) => query.sql.startsWith("UPDATE semantic_jobs"));
    assert.isAbove(writes.length, 0);
    for (const query of writes) {
      assert.include(query.plan.join("\n"), "sqlite_autoindex_semantic_jobs_1 (message_id=?)");
      assert.notMatch(query.plan.join("\n"), /semantic_jobs_(?:priority|pending) \(status=/);
    }
  }).pipe(
    Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform()))),
    Effect.ensuring(Effect.sync(trace.restore)),
  );
});

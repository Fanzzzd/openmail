import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/sql";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, splitStatements } from "./platform/node/db.js";
import type { IncomingMessage } from "./domain.js";
import { ProviderError } from "./errors.js";
import { fakeServer, makeFakeProvider, type FakeServer } from "./platform/node/fake-provider.js";
import { Mailbox } from "./mailbox.js";
import { MailboxLive } from "./mailbox-live.js";
import { MemoryPlatform } from "./platform/node/platform-memory.js";
import { Providers, Secrets, Store, type ProviderAdapter } from "./services.js";
import { StoreLive } from "./store.js";
import { startStoredUpdates, UPDATE_TOKEN_KEY, type UpdateClient } from "./updates.js";

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

it("cache migration and flags/snooze dates leave existing FTS segments untouched", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const migration of MIGRATIONS.slice(0, 12))
      for (const statement of splitStatements(migration)) db.exec(statement);
    db.exec(
      "INSERT INTO accounts(id,provider,email,created_at) VALUES ('a','gmail','a@example.com',0)",
    );
    const insert =
      db.prepare(`INSERT INTO messages(id,account_id,provider_id,thread_id,subject,from_name,from_addr,to_json,cc_json,date,snippet,body_text,body_html,labels_json,attachments_json,is_unread,is_starred)
      VALUES (?,'a',?,?,'Header','Alice','a@example.com','[]','[]',1,'','Body text','','[]','[]',0,0)`);
    db.exec("BEGIN");
    for (let i = 0; i < 2000; i++) insert.run(String(i), String(i), String(i));
    db.exec("COMMIT");
    const segments = () => db.prepare("SELECT id,block FROM messages_fts_data ORDER BY id").all();
    const before = segments();
    const migration = MIGRATIONS[12];
    assert.ok(migration);
    for (const statement of splitStatements(migration)) db.exec(statement);
    assert.deepStrictEqual(segments(), before);
    db.exec("UPDATE messages SET is_unread=1,is_starred=1,list_date=2,body_opened_at=3");
    assert.deepStrictEqual(segments(), before);
    db.exec("UPDATE messages SET subject='Changed header',body_text='changed body' WHERE id='0'");
    assert.ok(JSON.stringify(segments()) !== JSON.stringify(before));
    assert.strictEqual(
      db
        .prepare("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'Changed'")
        .get()?.["n"],
      1,
    );
    db.exec("INSERT INTO messages_fts(messages_fts,rank) VALUES ('integrity-check',1)");
  } finally {
    db.close();
  }
});

it.effect(
  "eviction/refetch retains OCR chunks and job generations; recent readers are protected",
  () => {
    const original = mail("old", {
      bodyHtml: '<img src="cid:scan">',
      attachments: [{ filename: "scan.pdf", mimeType: "application/pdf", size: 10 }],
    });
    const server = fakeServer("a@example.com", [original]);
    return withMailbox(
      server,
      Effect.gen(function* () {
        const s = yield* Store;
        const sql = yield* SqlClient.SqlClient;
        const m = yield* Mailbox;
        const account = yield* s.upsertAccount("gmail", server.email);
        const id = `${account.id}/old`;
        yield* s.upsertMessage(account.id, original);
        yield* sql`INSERT INTO derived_chunks(message_id,text,provenance_json) VALUES (${id},'retained OCR','{}')`;
        yield* sql`UPDATE derived_jobs SET status='done' WHERE message_id=${id}`;
        const job = yield* sql`SELECT generation,status FROM derived_jobs WHERE message_id=${id}`;
        yield* TestClock.adjust("500 days");
        const now = 500 * 86_400_000;
        assert.strictEqual(yield* s.evictBodies(account.id, now), 1);
        assert.strictEqual((yield* m.thread(id))[0]?.bodyCached, false);
        yield* m.readerThread(id);
        assert.strictEqual((yield* m.thread(id))[0]?.bodyCached, true);
        assert.deepStrictEqual(
          yield* sql`SELECT generation,status FROM derived_jobs WHERE message_id=${id}`,
          job,
        );
        assert.strictEqual(
          (yield* sql`SELECT text FROM derived_chunks WHERE message_id=${id}`).length,
          1,
        );
        assert.strictEqual(yield* s.evictBodies(account.id, now, true), 0);
        assert.strictEqual(yield* s.evictBodies(account.id, now + 25 * 3_600_000, true), 1);
        assert.deepStrictEqual(
          yield* sql`SELECT generation,status FROM derived_jobs WHERE message_id=${id}`,
          job,
        );
        // Genuine content edits with unchanged cache state still invalidate derived text.
        yield* s.upsertMessage(account.id, {
          ...original,
          bodyCached: false,
          bodyHtml: '<img src="cid:new">',
        });
        assert.strictEqual(
          (yield* sql`SELECT text FROM derived_chunks WHERE message_id=${id}`).length,
          0,
        );
      }),
    );
  },
);

it.effect(
  "local CLI/model reads have no writes/network; one missing reader body cannot fail the thread",
  () => {
    const server = fakeServer("a@example.com", [
      mail("a", { threadId: "t" }),
      mail("b", { threadId: "t" }),
    ]);
    return withMailbox(
      server,
      Effect.gen(function* () {
        const s = yield* Store;
        const sql = yield* SqlClient.SqlClient;
        const m = yield* Mailbox;
        const account = yield* s.upsertAccount("gmail", server.email);
        for (const message of server.messages.values())
          yield* s.upsertMessage(account.id, {
            ...message,
            bodyText: "",
            bodyHtml: "",
            bodyCached: false,
          });
        const id = `${account.id}/a`;
        const before = yield* sql`SELECT body_cached,body_opened_at FROM messages ORDER BY id`;
        assert.strictEqual((yield* m.thread(id)).length, 2);
        yield* m.threadForModel(id);
        assert.deepStrictEqual(
          yield* sql`SELECT body_cached,body_opened_at FROM messages ORDER BY id`,
          before,
        );
        assert.deepStrictEqual(server.bodyFetched, []);
        const messages = yield* m.readerThread(id);
        assert.strictEqual(messages.length, 2);
        assert.strictEqual(messages.find((row) => row.id === id)?.bodyCached, false);
        assert.strictEqual(
          messages.find((row) => row.id.endsWith("/b"))?.bodyText,
          "unique-body-term",
        );
      }),
      (base) => ({
        ...base,
        fetchMessage: (account, id) =>
          id === "a"
            ? Effect.fail(new ProviderError({ message: "offline" }))
            : base.fetchMessage(account, id),
      }),
    );
  },
);

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

it.effect(
  "backfill starts at the oldest cached date and excludes cached or pending draft ids before fetching",
  () => {
    const server = fakeServer("a@example.com", [
      mail("cached", { date: 0 }),
      mail("missing", { date: 1 }),
      mail("deleted", { date: 2 }),
    ]);
    return withMailbox(
      server,
      Effect.gen(function* () {
        const s = yield* Store;
        const m = yield* Mailbox;
        const account = yield* s.upsertAccount("gmail", server.email);
        yield* s.saveSyncCursor(account.id, "normal");
        yield* s.upsertMessage(account.id, mail("oldest", { date: 100 }));
        const state = yield* s.getBackfillState(account.id);
        assert.strictEqual(state.before, 100);
        yield* s.saveBackfillState({ ...state, cursor: "0" });
        yield* s.upsertMessage(account.id, mail("cached", { date: 0 }));
        yield* s.enqueueOp(account.id, "draft-id", {
          kind: "deleteDraft",
          remote: { draftId: "draft-id", messageId: "deleted" },
        });
        yield* m.fetchOlder({});
        assert.deepStrictEqual(server.backfillFetched, ["missing"]);
        assert.strictEqual(
          (yield* s.messageRef(`${account.id}/deleted`).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.deepStrictEqual(yield* s.getSyncCursor(account.id), Option.some("normal"));
      }),
    );
  },
);

it.effect("a draft deleted while its historical body is in flight is not reinserted", () => {
  const server = fakeServer("a@example.com", [mail("deleted")]);
  return withMailbox(
    server,
    Effect.gen(function* () {
      const s = yield* Store;
      const m = yield* Mailbox;
      const account = yield* s.upsertAccount("gmail", server.email);
      yield* s.saveSyncCursor(account.id, "normal");
      yield* TestClock.adjust("2 seconds");
      yield* m.fetchOlder({});
      assert.strictEqual(
        (yield* s.messageRef(`${account.id}/deleted`).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.strictEqual((yield* s.listPendingOps).length, 1);
    }),
    (base, s) => ({
      ...base,
      backfill: (account, state, select) =>
        base.backfill(account, state, select).pipe(
          Effect.tap(() =>
            s.enqueueOp(account.id, "draft-id", {
              kind: "deleteDraft",
              remote: { draftId: "draft-id", messageId: "deleted" },
            }),
          ),
        ),
    }),
  );
});

it.effect("update tokens live in Secrets and no token skips signature verification", () => {
  const server = fakeServer("a@example.com");
  return withMailbox(
    server,
    Effect.gen(function* () {
      const m = yield* Mailbox;
      const secrets = yield* Secrets;
      const s = yield* Store;
      assert.strictEqual(yield* m.updateTokenConfigured, false);
      yield* m.setUpdateToken("private-release-token");
      assert.deepStrictEqual(
        yield* secrets.get(UPDATE_TOKEN_KEY),
        Option.some("private-release-token"),
      );
      assert.strictEqual(yield* m.updateTokenConfigured, true);
      assert.ok(!JSON.stringify(yield* s.prefs).includes("private-release-token"));
      yield* m.setUpdateToken("");
      assert.strictEqual(yield* m.updateTokenConfigured, false);
      let verifies = 0;
      let checks = 0;
      const client: UpdateClient = {
        autoDownload: false,
        autoInstallOnAppQuit: false,
        logger: null,
        setFeedURL: () => null,
        checkForUpdates: () => {
          checks++;
          return Promise.resolve(null);
        },
        on: () => null,
        removeListener: () => null,
      };
      const stop = yield* startStoredUpdates(
        client,
        { packaged: true, bundle: "/tmp/test.app" },
        secrets.get(UPDATE_TOKEN_KEY),
        () => {
          verifies++;
          return Promise.resolve(true);
        },
      );
      stop();
      assert.strictEqual(verifies, 0);
      assert.strictEqual(checks, 0);
    }),
  );
});

it.effect(
  "semantic vectors and job generations survive eviction/hydration and reset on real edits",
  () => {
    const server = fakeServer("a@example.com", [mail("old")]);
    return withMailbox(
      server,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const s = yield* Store;
        const m = yield* Mailbox;
        yield* m.setIndexingPaused(true);
        const account = yield* s.upsertAccount("gmail", server.email);
        const id = `${account.id}/old`;
        yield* s.upsertMessage(account.id, mail("old"));
        yield* sql`INSERT INTO vector_items(message_id,kind,version,provenance_json) VALUES (${id},'text','test','{}')`;
        yield* sql`UPDATE semantic_jobs SET status='done' WHERE message_id=${id}`;
        const job = yield* sql`SELECT generation,status FROM semantic_jobs WHERE message_id=${id}`;
        yield* TestClock.adjust("500 days");
        yield* s.evictBodies(account.id, 500 * 86_400_000);
        yield* m.readerThread(id);
        assert.strictEqual(
          (yield* sql`SELECT id FROM vector_items WHERE message_id=${id}`).length,
          1,
        );
        assert.deepStrictEqual(
          yield* sql`SELECT generation,status FROM semantic_jobs WHERE message_id=${id}`,
          job,
        );
        yield* s.upsertMessage(account.id, mail("old", { bodyText: "genuine edit" }));
        assert.strictEqual(
          (yield* sql`SELECT id FROM vector_items WHERE message_id=${id}`).length,
          0,
        );
        assert.ok(
          JSON.stringify(
            yield* sql`SELECT generation,status FROM semantic_jobs WHERE message_id=${id}`,
          ) !== JSON.stringify(job),
        );
      }),
    );
  },
);

it.effect("reader retains legacy cached messages when a status-zero refetch fails", () => {
  const server = fakeServer("cached@example.com", [mail("legacy")]);
  return withMailbox(
    server,
    Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      const account = yield* store.upsertAccount("outlook", server.email);
      yield* store.upsertMessage(account.id, mail("legacy"));
      const id = `${account.id}/legacy`;
      yield* sql`UPDATE messages SET reply_to_json=NULL WHERE id=${id}`;
      const [cached] = yield* (yield* Mailbox).readerThread(id);
      assert.strictEqual(cached?.bodyText, "unique-body-term");
      assert.strictEqual(cached?.bodyRefresh, "failed");
      assert.isUndefined(cached?.replyTo);
      assert.strictEqual((yield* store.getAccount(account.id)).needsReauth, false);
    }),
    (base) => ({
      ...base,
      fetchMessage: () => Effect.fail(new ProviderError({ status: 0, message: "offline" })),
    }),
  );
});

it.effect(
  "reader bounds the entire refetch and returns cached messages when a provider never responds",
  () => {
    const server = fakeServer("cached@example.com", [
      mail("legacy", { bodyCached: false, bodyText: "", bodyHtml: "" }),
    ]);
    return withMailbox(
      server,
      Effect.gen(function* () {
        const store = yield* Store;
        const account = yield* store.upsertAccount("outlook", server.email);
        yield* store.upsertMessage(
          account.id,
          mail("legacy", { bodyCached: false, bodyText: "", bodyHtml: "" }),
        );
        const fiber = yield* (yield* Mailbox)
          .readerThread(`${account.id}/legacy`)
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("5 seconds");
        const [cached] = yield* Fiber.join(fiber);
        assert.strictEqual(cached?.snippet, "preview");
        assert.strictEqual(cached?.bodyRefresh, "failed");
      }),
      (base) => ({ ...base, fetchMessage: () => Effect.never }),
    );
  },
);

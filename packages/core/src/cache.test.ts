import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, Stream } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/sql";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BackfillState, keepBody } from "./cache.js";
import { databaseLayer, MIGRATIONS, splitStatements } from "./db.js";
import type { IncomingMessage } from "./domain.js";
import { ProviderError } from "./errors.js";
import { fakeServer, makeFakeProvider } from "./fake-provider.js";
import { listWindow } from "./list-window.js";
import { MailboxLive } from "./mailbox-live.js";
import { Mailbox } from "./mailbox.js";
import { MemoryPlatform } from "./platform-memory.js";
import { Providers, Store } from "./services.js";
import { StoreLive } from "./store.js";
import { startAutoUpdates, type UpdateClient } from "./updates.js";

const message = (id: string, overrides: Partial<IncomingMessage> = {}): IncomingMessage => ({
  providerId: id,
  threadId: id,
  subject: `Header ${id}`,
  from: { name: "Alice", address: "alice@example.com" },
  to: [],
  cc: [],
  date: 1000,
  snippet: "preview",
  bodyText: "unique-body-term",
  bodyHtml: "<p>Body</p>",
  labels: ["INBOX"],
  attachments: [{ filename: "report.pdf", mimeType: "application/pdf", size: 12 }],
  isUnread: false,
  isStarred: false,
  ...overrides,
});
const withStore = <A, E>(body: Effect.Effect<A, E, Store | SqlClient.SqlClient>) =>
  body.pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform()))));

it.effect("date/id pagination visits ties once in grouped, flat, search and draft views", () =>
  withStore(
    Effect.gen(function* () {
      const s = yield* Store;
      const a = yield* s.upsertAccount("gmail", "me@example.com");
      for (const id of ["a", "b", "c", "d", "e"]) yield* s.upsertMessage(a.id, message(id));
      yield* s.upsertMessage(a.id, message("older-a", { threadId: "a", date: 0 }));
      yield* s.upsertMessage(
        a.id,
        message("sent-a", { threadId: "a", date: 2000, labels: ["SENT"] }),
      );
      for (const query of [
        { mailbox: "inbox" },
        { mailbox: "inbox", flat: true },
        { search: "Header" },
      ] satisfies import("./domain.js").ThreadQuery[]) {
        const ids: string[] = [];
        let cursor: { before: number; beforeId: string } | undefined;
        for (;;) {
          const page = yield* s.listThreads({ ...query, ...cursor, limit: 2 });
          ids.push(...page.map((m) => m.id));
          const tail = page.at(-1);
          if (!tail) break;
          cursor = { before: tail.date, beforeId: tail.id };
        }
        assert.strictEqual(new Set(ids).size, ids.length);
        const all = yield* s.listThreads({ ...query, limit: 100 });
        assert.deepStrictEqual(
          ids,
          all.map((m) => m.id),
        );
      }
    }),
  ),
);

it("cache policy keeps drafts and the longest matching label, and honors boundaries", () => {
  const now = 500 * 86_400_000;
  const windows = [
    { label: "ALL", days: 365 },
    { label: "INBOX", days: null },
    { label: "SPAM", days: 30 },
  ];
  assert.strictEqual(keepBody(message("x", { date: 0 }), windows, now), true);
  assert.strictEqual(keepBody(message("x", { date: 0, labels: ["SPAM"] }), windows, now), false);
  assert.strictEqual(keepBody(message("x", { date: 0, labels: ["DRAFT"] }), windows, now), true);
  assert.strictEqual(
    keepBody(message("x", { date: now - 30 * 86_400_000, labels: ["SPAM"] }), windows, now),
    true,
  );
  assert.strictEqual(
    keepBody(message("x", { date: 0, labels: ["SPAM", "INBOX"] }), windows, now),
    true,
  );
});

it.effect("eviction preserves rowid, attachment metadata and header FTS, removing body terms", () =>
  withStore(
    Effect.gen(function* () {
      const s = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      const a = yield* s.upsertAccount("gmail", "me@example.com");
      yield* s.upsertMessage(a.id, message("old", { labels: ["SPAM"] }));
      const before = yield* sql`SELECT rowid FROM messages`;
      assert.strictEqual(yield* s.evictBodies(a.id, 400 * 86_400_000), 1);
      const cached = yield* s.getMessage(`${a.id}/old`);
      assert.strictEqual(cached.bodyCached, false);
      assert.strictEqual(cached.bodyHtml, "");
      assert.strictEqual(cached.attachments[0]?.filename, "report.pdf");
      assert.deepStrictEqual(yield* sql`SELECT rowid FROM messages`, before);
      assert.strictEqual(
        (yield* s.listThreads({ search: "Header", searchScope: "folder", mailbox: "spam" })).length,
        1,
      );
      assert.strictEqual(
        (yield* s.listThreads({
          search: "unique-body-term",
          searchScope: "folder",
          mailbox: "spam",
        })).length,
        0,
      );
      yield* sql`INSERT INTO messages_fts(messages_fts,rank) VALUES ('integrity-check',1)`;
      yield* s.upsertMessage(a.id, message("old", { labels: ["SPAM"] }));
      assert.deepStrictEqual(yield* sql`SELECT rowid FROM messages`, before);
      assert.strictEqual(
        (yield* s.listThreads({
          search: "unique-body-term",
          searchScope: "folder",
          mailbox: "spam",
        })).length,
        1,
      );
    }),
  ),
);

it.effect(
  "backfill resumes after rebuilding Mailbox, is throttled/pausable, and hydrates on open",
  () => {
    const server = fakeServer(
      "me@example.com",
      Array.from({ length: 120 }, (_, i) =>
        message(String(i).padStart(3, "0"), { date: 1, labels: ["ARCHIVE"] }),
      ),
    );
    const provider = makeFakeProvider(server);
    const dependencies = Layer.mergeAll(
      StoreLive,
      Layer.succeed(Providers, { get: () => provider }),
    ).pipe(Layer.provideMerge(MemoryPlatform()));
    return Effect.gen(function* () {
      const store = yield* Store;
      const a = yield* store.upsertAccount("gmail", server.email);
      yield* store.saveSyncCursor(a.id, "normal-cursor");
      // Old mail exceeds the account window.
      yield* TestClock.adjust("500 days");
      const first = yield* Effect.gen(function* () {
        const m = yield* Mailbox;
        yield* m.fetchOlder({ accountIds: [a.id] });
        const state = (yield* m.backfillState)[0];
        assert.strictEqual(state?.fetched, 50);
        yield* m.fetchOlder({ accountIds: [a.id] });
        assert.strictEqual((yield* m.backfillState)[0]?.fetched, 50);
        yield* m.pauseBackfill(a.id, true);
        return state;
      }).pipe(Effect.provide(MailboxLive({ backgroundFlush: false })));
      assert.ok(first?.cursor);
      yield* TestClock.adjust("20 seconds");
      yield* Effect.gen(function* () {
        const m = yield* Mailbox;
        assert.strictEqual((yield* m.backfillState)[0]?.paused, true);
        yield* m.fetchOlder({ accountIds: [a.id] });
        assert.strictEqual((yield* m.backfillState)[0]?.cursor, first.cursor);
        yield* m.pauseBackfill(a.id, false);
        yield* m.fetchOlder({ accountIds: [a.id] });
        assert.strictEqual((yield* m.backfillState)[0]?.fetched, 100);
        const [head] = yield* m.threads({ mailbox: "all" });
        assert.ok(head);
        assert.strictEqual((yield* store.getMessage(head.id)).bodyCached, false);
        const full = (yield* m.readerThread(head.id))[0];
        assert.strictEqual(full?.bodyText, "unique-body-term");
        assert.strictEqual(full?.bodyCached, true);
        yield* TestClock.adjust("10 seconds");
        yield* m.fetchOlder({ accountIds: [a.id] });
        assert.strictEqual((yield* m.backfillState)[0]?.done, true);
        assert.strictEqual((yield* m.threads({ mailbox: "all", limit: 1000 })).length, 120);
        assert.deepStrictEqual(yield* store.getSyncCursor(a.id), Option.some("normal-cursor"));
      }).pipe(Effect.provide(MailboxLive({ backgroundFlush: false })));
    }).pipe(Effect.provide(dependencies));
  },
);

it.effect(
  "failed historical pages do not advance; retry waits and local edits survive overlap",
  () => {
    const server = fakeServer("me@example.com", [message("old")]);
    const adapter = makeFakeProvider(server);
    const deps = Layer.mergeAll(StoreLive, Layer.succeed(Providers, { get: () => adapter })).pipe(
      Layer.provideMerge(MemoryPlatform()),
    );
    return Effect.gen(function* () {
      const s = yield* Store;
      const account = yield* s.upsertAccount("gmail", server.email);
      yield* s.saveSyncCursor(account.id, "normal");
      yield* TestClock.adjust("2 seconds");
      const m = yield* Mailbox;
      server.failNext = new ProviderError({ message: "limited", status: 429 });
      yield* m.fetchOlder({});
      assert.strictEqual((yield* m.backfillState)[0]?.fetched, 0);
      assert.strictEqual((yield* m.backfillState)[0]?.lastError, "limited");
      yield* m.fetchOlder({});
      assert.strictEqual((yield* m.backfillState)[0]?.fetched, 0);
      yield* s.upsertMessage(
        account.id,
        message("old", { isUnread: true, labels: ["INBOX", "UNREAD"] }),
      );
      yield* TestClock.adjust("5 minutes");
      yield* m.fetchOlder({});
      assert.strictEqual((yield* m.thread(`${account.id}/old`))[0]?.isUnread, true);
      assert.strictEqual((yield* m.backfillState)[0]?.done, true);
    }).pipe(Effect.provide(MailboxLive({ backgroundFlush: false }).pipe(Layer.provideMerge(deps))));
  },
);

it.effect("normal sync gets priority over a requested historical page", () => {
  const server = fakeServer("me@example.com");
  const base = makeFakeProvider(server);
  return Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let calls = 0;
    const provider = {
      ...base,
      pull: (a: import("./domain.js").Account, c: Option.Option<string>) =>
        Stream.fromEffect(
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ).pipe(Stream.flatMap(() => base.pull(a, c))),
      backfill: (a: import("./domain.js").Account, s: Pick<BackfillState, "cursor" | "before">) =>
        Effect.sync(() => calls++).pipe(Effect.andThen(base.backfill(a, s))),
    };
    const deps = Layer.mergeAll(StoreLive, Layer.succeed(Providers, { get: () => provider })).pipe(
      Layer.provideMerge(MemoryPlatform()),
    );
    yield* Effect.gen(function* () {
      const store = yield* Store;
      const a = yield* store.upsertAccount("gmail", server.email);
      yield* store.saveSyncCursor(a.id, "old");
      const m = yield* Mailbox;
      const sync = yield* Effect.forkScoped(m.sync());
      yield* Deferred.await(started);
      const older = yield* Effect.forkScoped(m.fetchOlder({}));
      yield* Effect.yieldNow;
      assert.strictEqual(calls, 0);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(sync);
      yield* Fiber.join(older);
      assert.strictEqual(calls, 1);
    }).pipe(Effect.provide(MailboxLive({ backgroundFlush: false }).pipe(Layer.provideMerge(deps))));
  });
});

it.effect(
  "100k threads use bounded keyset pages and constant-size render windows",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* Effect.acquireRelease(
          Effect.sync(() => mkdtempSync(path.join(os.tmpdir(), "openmail-100k-"))),
          (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
        );
        const filename = path.join(dir, "mail.db");
        yield* Effect.sync(() => {
          const db = new DatabaseSync(filename);
          for (const migration of MIGRATIONS)
            for (const statement of splitStatements(migration)) db.exec(statement);
          db.exec(`PRAGMA user_version=${MIGRATIONS.length}`);
          db.prepare(
            "INSERT INTO accounts(id,provider,email,created_at) VALUES ('gmail:test','gmail','test@example.com',0)",
          ).run();
          const insert = db.prepare(
            `INSERT INTO messages(id,account_id,provider_id,thread_id,subject,from_name,from_addr,to_json,cc_json,date,snippet,body_text,body_html,labels_json,attachments_json,is_unread,is_starred,list_date) VALUES (?, 'gmail:test', ?, ?, 'Header', 'A', 'a@example.com', '[]','[]',?, '', '', '', '["INBOX"]','[]',0,0,?)`,
          );
          // This fixture benchmarks list reads, not 100k semantic queue insertions.
          const semanticInsert = db
            .prepare("SELECT sql FROM sqlite_master WHERE name='semantic_message_insert'")
            .get()?.["sql"];
          assert.ok(typeof semanticInsert === "string");
          db.exec("DROP TRIGGER semantic_message_insert");
          db.exec("BEGIN");
          for (let i = 0; i < 100_000; i++) {
            const id = String(i).padStart(6, "0");
            insert.run(`gmail:test/${id}`, id, id, Math.floor(i / 10), Math.floor(i / 10));
          }
          db.exec("COMMIT");
          db.exec(semanticInsert);
          db.close();
        });
        const sql = databaseLayer(filename).pipe(
          Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
        );
        yield* Effect.gen(function* () {
          const store = yield* Store;
          let cursor: { before: number; beforeId: string } | undefined;
          const started = performance.now();
          for (let i = 0; i < 10; i++) {
            const page = yield* store.listThreads({ ...cursor, limit: 100 });
            assert.strictEqual(page.length, 100);
            const tail = page.at(-1);
            assert.ok(tail);
            cursor = { before: tail.date, beforeId: tail.id };
          }
          // Generous CI ceiling; rejects whole-table ranking for each page.
          assert.ok(
            performance.now() - started < 2000,
            "ten pages should complete in under two seconds",
          );
          yield* store.setCacheWindow({ accountId: "gmail:test", label: "INBOX", days: 30 });
          const state = yield* store.getBackfillState("gmail:test");
          yield* store.saveBackfillState({ ...state, cursor: "page-2", fetched: 50 });
          yield* store.setBackfillPaused("gmail:test", true);
        }).pipe(Effect.provide(StoreLive.pipe(Layer.provide(sql))));
        // Reopen the real file, not an in-memory substitute.
        yield* Effect.gen(function* () {
          const store = yield* Store;
          assert.strictEqual((yield* store.cacheWindows)[0]?.days, 30);
          const state = yield* store.getBackfillState("gmail:test");
          assert.strictEqual(state.cursor, "page-2");
          assert.strictEqual(state.paused, true);
        }).pipe(Effect.provide(StoreLive.pipe(Layer.provide(sql))));
        for (const top of [0, 1000, 4_200_000, 8_399_916]) {
          const range = listWindow(100_000, top, 600);
          assert.ok(range.end - range.first <= 21);
          assert.strictEqual(range.total, 8_400_000);
          assert.strictEqual(range.offset, range.first * 84);
        }
      }),
    ),
  { timeout: 30_000 },
);

it("unsigned, unpackaged and unauthenticated builds never configure or check updates", () => {
  let checks = 0;
  let feeds = 0;
  const client: UpdateClient = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    logger: null,
    setFeedURL: () => {
      feeds++;
    },
    checkForUpdates: () => {
      checks++;
      return Promise.resolve(null);
    },
    on: () => null,
    removeListener: () => null,
  };
  startAutoUpdates(client, { signed: false, packaged: true, token: "secret" })();
  startAutoUpdates(client, { signed: true, packaged: false, token: "secret" })();
  startAutoUpdates(client, { signed: true, packaged: true, token: undefined })();
  assert.strictEqual(checks, 0);
  assert.strictEqual(feeds, 0);
  const stop = startAutoUpdates(client, { signed: true, packaged: true, token: "secret" });
  assert.strictEqual(client.autoInstallOnAppQuit, true);
  stop();
  assert.strictEqual(client.autoDownload, false);
  assert.strictEqual(client.autoInstallOnAppQuit, false);
  assert.strictEqual(checks, 1);
  assert.strictEqual(feeds, 1);
});

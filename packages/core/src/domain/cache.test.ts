import { applyNativeMigration } from "../platform/node/migrations.js";
import { incoming as makeIncoming, TestMailbox } from "../platform/node/testing.js";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { lowMemoryTests } from "../../vitest.low-memory.js";
import { Deferred, Effect, Fiber, FileSystem, Layer, Option, Path, Stream } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/sql";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BackfillState, keepBody } from "./cache.js";
import { databaseLayer, MIGRATIONS, splitStatements } from "../platform/node/db.js";
import { type IncomingMessage } from "./domain.js";
import { ProviderError } from "./errors.js";
import { fakeServer, makeFakeProvider, type FakeServer } from "../platform/node/fake-provider.js";
import { listWindow } from "../app/list-window.js";
import { MailboxLive } from "../mailbox/mailbox-live.js";
import { Mailbox } from "../mailbox/mailbox.js";
import { MemoryPlatform } from "../platform/node/platform-memory.js";
import { replyRecipients } from "../compose/recipients.js";
import { Providers, Store, Secrets, type ProviderAdapter } from "../services.js";
import { StoreLive } from "../store/store.js";
import {
  startAutoUpdates,
  type UpdateClient,
  startStoredUpdates,
  UPDATE_TOKEN_KEY,
} from "../app/updates.js";
{
  const message = (id: string, overrides: Partial<IncomingMessage> = {}): IncomingMessage =>
    makeIncoming(id, {
      threadId: id,
      subject: `Header ${id}`,
      to: [],
      snippet: "preview",
      bodyText: "unique-body-term",
      bodyHtml: "<p>Body</p>",
      labels: ["INBOX"],
      attachments: [{ filename: "report.pdf", mimeType: "application/pdf", size: 12 }],
      isUnread: false,
      ...overrides,
    });

  const withStore = <A, E>(body: Effect.Effect<A, E, Store | SqlClient.SqlClient>) =>
    body.pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform()))));

  for (const provider of ["gmail", "outlook", "imap"] as const) {
    it.effect(
      `${provider} refills unknown Reply-To on cached mail before selecting reply targets`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const paths = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "openmail-reply-refill-" });
          const remote = message("legacy", {
            to: [{ name: "Me", address: "me@example.com" }],
            replyTo: [{ name: "Forms", address: "forms@example.com" }],
          });
          const server = fakeServer("me@example.com", [remote, message("empty", { replyTo: [] })]);
          const dependencies = Layer.mergeAll(
            StoreLive,
            Layer.succeed(Providers, { get: () => makeFakeProvider(server) }),
          ).pipe(
            Layer.provideMerge(
              Layer.merge(
                MemoryPlatform(),
                databaseLayer(paths.join(dir, "mail.db")).pipe(
                  Layer.provide(NodeFileSystem.layer),
                  Layer.provide(NodePath.layer),
                ),
              ),
            ),
          );
          yield* Effect.gen(function* () {
            const store = yield* Store;
            const sql = yield* SqlClient.SqlClient;
            const account = yield* store.upsertAccount(provider, server.email);
            const mailbox = yield* Mailbox;
            for (const original of server.messages.values()) {
              const id = `${account.id}/${original.providerId}`;
              yield* store.upsertMessage(account.id, {
                ...original,
                cc: [{ name: "", address: "undisclosed-recipients:" }],
                isStarred: true,
              });
              yield* sql`UPDATE messages SET reply_to_json=NULL WHERE id=${id}`;
              const before = yield* sql`SELECT rowid FROM messages WHERE id=${id}`;
              assert.strictEqual((yield* store.getMessage(id)).bodyCached, true);
              assert.isUndefined((yield* store.getMessage(id)).replyTo);
              server.failNext = new ProviderError({ message: "Offline", status: 503 });
              assert.strictEqual((yield* mailbox.readerThread(id))[0]?.bodyRefresh, "failed");
              assert.isUndefined((yield* store.getMessage(id)).replyTo);
              const [ready] = yield* mailbox.readerThread(id);
              assert.ok(ready);
              assert.deepStrictEqual(ready.replyTo, original.replyTo);
              assert.deepStrictEqual(ready.to, original.to);
              assert.deepStrictEqual(ready.cc, original.cc);
              assert.isTrue(ready.isStarred);
              assert.deepStrictEqual(
                replyRecipients(ready, [account.email], false).to,
                original.replyTo?.length ? original.replyTo : [original.from],
              );
              assert.deepStrictEqual(yield* sql`SELECT rowid FROM messages WHERE id=${id}`, before);
              yield* mailbox.readerThread(id);
            }
            assert.deepStrictEqual(server.bodyFetched, ["legacy", "empty"]);
            // Known headers continue to support offline reading of an evicted body.
            const knownId = `${account.id}/empty`;
            yield* sql`UPDATE messages SET body_cached=0 WHERE id=${knownId}`;
            server.failNext = new ProviderError({ message: "Offline", status: 503 });
            assert.deepStrictEqual((yield* mailbox.readerThread(knownId))[0]?.replyTo, []);
            yield* sql`INSERT INTO messages_fts(messages_fts,rank) VALUES ('integrity-check',1)`;
            assert.strictEqual(
              (yield* store.listThreads({ search: "unique-body-term" })).length,
              2,
            );
          }).pipe(
            Effect.provide(
              MailboxLive({ backgroundFlush: false }).pipe(Layer.provideMerge(dependencies)),
            ),
          );
        }).pipe(Effect.provide(NodeFileSystem.layer), Effect.provide(NodePath.layer)),
    );
  }

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

  it.effect(
    "eviction preserves rowid, attachment metadata and header FTS, removing body terms",
    () =>
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
            (yield* s.listThreads({ search: "Header", searchScope: "folder", mailbox: "spam" }))
              .length,
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
          const ref = yield* store.messageRef(head.id);
          const remote = server.messages.get(ref.providerId);
          assert.ok(remote);
          const replyTo = [{ name: "Reply", address: "reply@example.com" }];
          server.messages.set(ref.providerId, { ...remote, replyTo });
          const full = (yield* m.readerThread(head.id))[0];
          assert.deepStrictEqual(full?.replyTo, replyTo);
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
      }).pipe(Effect.provide(TestMailbox.withAdapter(adapter)));
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
      }).pipe(Effect.provide(TestMailbox.withAdapter(provider)));
    });
  });

  it.effect(
    "small cache fixtures reopen windows and backfill state with bounded list geometry",
    () =>
      Effect.gen(function* () {
        const dir = yield* Effect.acquireRelease(
          Effect.sync(() => mkdtempSync(path.join(os.tmpdir(), "openmail-cache-reopen-"))),
          (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
        );
        const filename = path.join(dir, "mail.db");
        const layer = () =>
          StoreLive.pipe(Layer.provideMerge(MemoryPlatform({ database: filename })));
        const accountId = yield* Effect.gen(function* () {
          const store = yield* Store;
          const account = yield* store.upsertAccount("gmail", "test@example.com");
          for (let i = 0; i < 50; i++) {
            const id = String(i).padStart(6, "0");
            yield* store.upsertMessage(
              account.id,
              makeIncoming(id, {
                threadId: id,
                date: Math.floor(i / 10),
                labels: ["INBOX"],
                isUnread: false,
              }),
            );
          }
          assert.strictEqual((yield* store.listThreads({ limit: 50 })).length, 50);
          yield* store.setCacheWindow({ accountId: account.id, label: "INBOX", days: 30 });
          const state = yield* store.getBackfillState(account.id);
          yield* store.saveBackfillState({ ...state, cursor: "page-2", fetched: 50 });
          yield* store.setBackfillPaused(account.id, true);
          return account.id;
        }).pipe(Effect.provide(layer()));
        yield* Effect.gen(function* () {
          const store = yield* Store;
          assert.strictEqual((yield* store.cacheWindows)[0]?.days, 30);
          const state = yield* store.getBackfillState(accountId);
          assert.strictEqual(state.cursor, "page-2");
          assert.strictEqual(state.fetched, 50);
          assert.strictEqual(state.paused, true);
        }).pipe(Effect.provide(layer()));
        assert.deepStrictEqual(listWindow(50, 0, 600), {
          first: 0,
          end: 14,
          offset: 0,
          total: 4200,
        });
        for (const count of [50, 100_000]) {
          for (const top of [0, 1000, count * 42, count * 84 - 84]) {
            const range = listWindow(count, top, 600);
            assert.ok(range.end - range.first <= 21);
            assert.strictEqual(range.total, count * 84);
            assert.strictEqual(range.offset, range.first * 84);
          }
        }
      }),
  );

  it.effect.skipIf(process.env.OPENMAIL_PERF !== "1")(
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
            for (const migration of MIGRATIONS) applyNativeMigration(db, migration);
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
    // The disk fixture can swap on shared Macs; the two-second paging assertion stays strict.
    { timeout: lowMemoryTests.testTimeout === undefined ? 30_000 : 300_000 },
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
    assert.strictEqual(client.autoInstallOnAppQuit, false);
    stop();
    assert.strictEqual(client.autoDownload, false);
    assert.strictEqual(client.autoInstallOnAppQuit, false);
    assert.strictEqual(checks, 1);
    assert.strictEqual(feeds, 1);
  });
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

  it("cache migration and flags/snooze dates leave existing FTS segments untouched", () => {
    const db = new DatabaseSync(":memory:");
    try {
      for (const migration of MIGRATIONS.slice(0, 12)) applyNativeMigration(db, migration);
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
    "eviction and refetch preserve OCR chunks and generations; recent readers are protected",
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
          assert.deepStrictEqual(
            yield* sql`SELECT generation,status FROM derived_jobs WHERE message_id=${id}`,
            job,
          );
          assert.strictEqual(
            (yield* sql`SELECT text FROM derived_chunks WHERE message_id=${id}`).length,
            1,
          );
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
          const refilledJob =
            yield* sql`SELECT generation,status FROM derived_jobs WHERE message_id=${id}`;
          assert.strictEqual(yield* s.evictBodies(account.id, now, true), 0);
          assert.strictEqual(yield* s.evictBodies(account.id, now + 25 * 3_600_000, true), 1);
          assert.deepStrictEqual(
            yield* sql`SELECT generation,status FROM derived_jobs WHERE message_id=${id}`,
            refilledJob,
          );
          // Changing the attachment set invalidates OCR even with an evicted body.
          yield* s.upsertMessage(account.id, {
            ...original,
            bodyCached: false,
            bodyHtml: '<img src="cid:new">',
            attachments: [{ filename: "new.pdf", mimeType: "application/pdf", size: 20 }],
          });
          assert.deepStrictEqual(
            yield* sql`SELECT generation,status FROM derived_jobs WHERE message_id=${id}`,
            [{ generation: Number(refilledJob[0]?.generation) + 1, status: "queued" }],
          );
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
    "semantic vectors survive eviction and hydration requeues indexing before real edits",
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
          const job =
            yield* sql`SELECT generation,status FROM semantic_jobs WHERE message_id=${id}`;
          yield* TestClock.adjust("500 days");
          yield* s.evictBodies(account.id, 500 * 86_400_000);
          assert.deepStrictEqual(
            yield* sql`SELECT generation,status FROM semantic_jobs WHERE message_id=${id}`,
            job,
          );
          assert.strictEqual(
            (yield* sql`SELECT id FROM vector_items WHERE message_id=${id}`).length,
            1,
          );
          yield* m.readerThread(id);
          assert.strictEqual(
            (yield* sql`SELECT id FROM vector_items WHERE message_id=${id}`).length,
            0,
          );
          assert.deepStrictEqual(
            yield* sql`SELECT generation,status FROM semantic_jobs WHERE message_id=${id}`,
            [{ generation: Number(job[0]?.generation) + 1, status: "queued" }],
          );
          const refilledJob =
            yield* sql`SELECT generation,status FROM semantic_jobs WHERE message_id=${id}`;
          yield* s.upsertMessage(account.id, mail("old", { bodyText: "genuine edit" }));
          assert.strictEqual(
            (yield* sql`SELECT id FROM vector_items WHERE message_id=${id}`).length,
            0,
          );
          assert.ok(
            JSON.stringify(
              yield* sql`SELECT generation,status FROM semantic_jobs WHERE message_id=${id}`,
            ) !== JSON.stringify(refilledJob),
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
}

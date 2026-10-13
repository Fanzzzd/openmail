import { applyNativeMigration } from "./migrations.js";
import { assert, it } from "@effect/vitest";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Clock, ConfigProvider, Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { mkdtempSync, rmSync, writeFileSync, linkSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { adaptiveBodyLimit, cacheAccounting } from "../../domain/cache.js";
import { MIGRATIONS } from "../../db/db.js";
import { Mailbox } from "../../mailbox/mailbox.js";
import { makeMailboxRuntimeState } from "../../mailbox/mailbox-runtime.js";
import { makeStorageMailbox } from "../../mailbox/mailbox-storage.js";
import { CacheStorage } from "../cache-storage.js";
import { Store } from "../../services.js";
import { StoreLive } from "../../store/store.js";
import { makeCompactionStore } from "../../store/store-compaction.js";
import { measureCacheStorage } from "./cache-storage.js";
import { MemoryPlatform } from "./platform-memory.js";
import { incoming, TestMailbox, fakeServer } from "./testing.js";

const temporary = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "openmail-cache-management-"))),
  (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
);
const storeLayer = (database?: string) =>
  StoreLive.pipe(Layer.provideMerge(MemoryPlatform(database ? { database } : {})));

it("accounts for page payloads, reusable pages, WAL, attachments and recovery copies once", () => {
  const size = cacheAccounting({ totalBytes: 10000, reusableBytes: 2000 }, 3000, 4000, {
    walBytes: 600,
    recoveryBytes: 1000,
    disk: null,
  });
  assert.strictEqual(size.otherBytes, 5000);
  assert.strictEqual(size.footprintBytes, 15600);
  assert.strictEqual(
    size.bodyBytes +
      size.otherBytes +
      size.reusableBytes +
      size.attachmentBytes +
      size.walBytes +
      size.recoveryBytes,
    size.footprintBytes,
  );
  assert.deepStrictEqual(adaptiveBodyLimit(size, null, { bodyCacheBytes: 0, totalCacheBytes: 0 }), {
    lowDisk: false,
    effectiveBodyBytes: null,
  });
  assert.strictEqual(
    adaptiveBodyLimit(size, null, { bodyCacheBytes: 2000, totalCacheBytes: 15000 })
      .effectiveBodyBytes,
    2000,
  );
  assert.strictEqual(
    adaptiveBodyLimit(size, null, { bodyCacheBytes: 0, totalCacheBytes: 14000 }).effectiveBodyBytes,
    3000,
  );
  assert.strictEqual(
    adaptiveBodyLimit(
      size,
      { freeBytes: 20, totalBytes: 1000 },
      { bodyCacheBytes: 0, totalCacheBytes: 0 },
    ).effectiveBodyBytes,
    3000,
  );
  assert.isFalse(
    adaptiveBodyLimit(
      size,
      { freeBytes: 100, totalBytes: 1000 },
      { bodyCacheBytes: 0, totalCacheBytes: 0 },
    ).lowDisk,
  );
  assert.strictEqual(
    adaptiveBodyLimit(
      size,
      { freeBytes: 5 * 1024 ** 3 - 100, totalBytes: 100 * 1024 ** 3 },
      { bodyCacheBytes: 0, totalCacheBytes: 0 },
    ).effectiveBodyBytes,
    3000,
  );
});

it.effect(
  "measures volume space and actual WAL/recovery files without symlinks or duplicate hard links",
  () =>
    Effect.gen(function* () {
      const directory = yield* temporary;
      const file = join(directory, "mail.db");
      yield* Effect.sync(() => {
        writeFileSync(file, "main");
        writeFileSync(`${file}-wal`, "wal");
        writeFileSync(`${file}.corrupt-one`, "backup");
        writeFileSync(`${file}.corrupt-one-wal`, "oldwal");
        writeFileSync(`${file}.recovery-one`, "recovery");
        writeFileSync(join(directory, "unrelated"), "ignore");
        linkSync(file, `${file}.corrupt-hardlink`);
        symlinkSync(join(directory, "unrelated"), `${file}.corrupt-symlink`);
      });
      const size = yield* Effect.promise(() => measureCacheStorage(file));
      assert.strictEqual(size.walBytes, 3);
      assert.strictEqual(size.recoveryBytes, 20);
      assert.ok(size.disk && size.disk.totalBytes > 0 && size.disk.freeBytes >= 0);
    }).pipe(Effect.scoped),
);

it.effect(
  "low disk tightens a disabled budget to zero while keeping every exemption and LRU order",
  () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const runtime = yield* makeMailboxRuntimeState;
      const account = yield* store.upsertAccount("gmail", "cache@example.com");
      const now = yield* Clock.currentTimeMillis;
      yield* store.setCacheWindow({ accountId: account.id, label: "Keep", days: null });
      const protectedMail = [
        incoming("star", { isStarred: true }),
        incoming("draft", { labels: ["DRAFT"] }),
        incoming("outbox", { labels: ["OUTBOX"] }),
        incoming("permanent", { labels: ["Keep"] }),
        incoming("retained", { date: now, labels: [] }),
        incoming("remote-draft", { labels: [] }),
      ];
      for (const message of [
        ...protectedMail,
        incoming("old", { labels: [] }),
        incoming("recent", { labels: [] }),
      ])
        yield* store.upsertMessage(account.id, {
          ...message,
          date: message.providerId === "retained" ? now : now - 500 * 86400000,
          bodyText: "cachetext",
          bodyHtml: "",
        });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO drafts(id,account_id,message_json,updated_at,remote_message_id) VALUES('local',${account.id},'{}',0,'remote-draft')`;
      yield* store.touchBody(`${account.id}/old`, 1);
      yield* store.touchBody(`${account.id}/recent`, 2);
      const bodyBytes = (yield* store.bodySizes)[0]?.bytes ?? 0;
      // Tighten by exactly one message, then to zero even within the hourly gate.
      let freeBytes = 100 - 9;
      const storage = yield* makeStorageMailbox(store, runtime, undefined, false, Effect.void).pipe(
        Effect.provideService(CacheStorage, {
          measure: () =>
            Effect.sync(() => ({
              walBytes: 0,
              recoveryBytes: 0,
              disk: { totalBytes: 1000, freeBytes },
            })),
        }),
      );
      assert.strictEqual((yield* storage.cacheDatabaseSize).effectiveBodyBytes, bodyBytes - 9);
      yield* storage.enforceCacheBudget();
      assert.isFalse((yield* store.getMessage(`${account.id}/old`)).bodyCached);
      assert.isTrue((yield* store.getMessage(`${account.id}/recent`)).bodyCached);
      freeBytes = 0;
      yield* storage.enforceCacheBudget();
      assert.isFalse((yield* store.getMessage(`${account.id}/recent`)).bodyCached);
      for (const message of protectedMail)
        assert.isTrue(
          (yield* store.getMessage(`${account.id}/${message.providerId}`)).bodyCached,
          message.providerId,
        );
      assert.isTrue((yield* storage.cacheDatabaseSize).lowDisk);
    }).pipe(Effect.scoped, Effect.provide(storeLayer())),
);

it.effect(
  "first explicit compaction preserves sparse message/FTS rowids, dependent data and searches; later compaction is incremental",
  () =>
    Effect.gen(function* () {
      const directory = yield* temporary;
      const file = join(directory, "mail.db");
      yield* Effect.sync(() => {
        const db = new DatabaseSync(file);
        try {
          for (const migration of MIGRATIONS.slice(0, 36)) applyNativeMigration(db, migration);
          db.exec("PRAGMA user_version=36; PRAGMA foreign_keys=ON");
          db.exec(
            "INSERT INTO accounts(id,provider,email,created_at) VALUES('a','gmail','cache@example.com',0)",
          );
          for (const [rowid, id] of [
            [7, "one"],
            [41, "two"],
          ] satisfies [number, string][])
            db.prepare(
              "INSERT INTO messages(rowid,id,account_id,provider_id,thread_id,subject,from_name,from_addr,to_json,cc_json,date,snippet,body_text,body_html,labels_json,attachments_json,is_unread,is_starred) VALUES(?,?,'a',?,?,'searchneedle','Alice','alice@example.com','[]','[]',0,'','bodyneedle','','[]','[]',0,0)",
            ).run(rowid, id, id, id);
          db.exec(
            "INSERT INTO derived_chunks(id,message_id,text,provenance_json) VALUES(29,'one','derivedneedle','{}')",
          );
          db.exec(
            "INSERT INTO contact_organizations(rowid,account_id,address,company) VALUES(57,'a','alice@example.com','companyneedle')",
          );
        } finally {
          db.close();
        }
      });
      yield* Effect.gen(function* () {
        const store = yield* Store;
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql`SELECT rowid,id FROM messages ORDER BY rowid`;
        assert.deepStrictEqual(rows, [
          { rowid: 7, id: "one" },
          { rowid: 41, id: "two" },
        ]);
        const contacts = yield* sql`SELECT rowid,id FROM contact_candidates ORDER BY rowid`;
        yield* sql`INSERT INTO messages_fts(messages_fts,rank) VALUES('integrity-check',1)`;
        yield* sql`INSERT INTO contact_candidates_fts(contact_candidates_fts,rank) VALUES('integrity-check',1)`;
        assert.strictEqual((yield* sql`PRAGMA auto_vacuum`)[0]?.auto_vacuum, 0);
        assert.strictEqual(yield* store.compactCache(false), "done");
        assert.deepStrictEqual(yield* sql`SELECT rowid,id FROM messages ORDER BY rowid`, rows);
        assert.deepStrictEqual(
          yield* sql`SELECT rowid,id FROM contact_candidates ORDER BY rowid`,
          contacts,
        );
        assert.strictEqual((yield* sql`PRAGMA auto_vacuum`)[0]?.auto_vacuum, 2);
        assert.strictEqual((yield* store.listThreads({ search: "bodyneedle" })).length, 2);
        assert.deepStrictEqual(
          yield* sql`SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'bodyneedle' ORDER BY rowid`,
          [{ rowid: 7 }, { rowid: 41 }],
        );
        assert.deepStrictEqual(
          yield* sql`SELECT rowid FROM contact_organizations_fts WHERE contact_organizations_fts MATCH 'companyneedle'`,
          [{ rowid: 57 }],
        );
        assert.deepStrictEqual(yield* sql`SELECT id FROM derived_chunks`, [{ id: 29 }]);
        assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
        assert.strictEqual((yield* sql`PRAGMA foreign_keys`)[0]?.foreign_keys, 1);
        assert.strictEqual(yield* store.compactCache(false), "done");
        yield* store.upsertMessage("a", incoming("next", { labels: [], bodyText: "laterneedle" }));
        assert.strictEqual((yield* store.listThreads({ search: "laterneedle" })).length, 1);
        yield* sql`INSERT INTO messages_fts(messages_fts,rank) VALUES('integrity-check',1)`;
      }).pipe(Effect.provide(storeLayer(file)));
    }).pipe(Effect.scoped),
);

it.effect("refuses full VACUUM for implicit content rowids", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE messages(id TEXT PRIMARY KEY)`;
    const maintenance = makeCompactionStore(sql);
    assert.strictEqual(yield* maintenance.compactCache(false), "unsafe");
    assert.strictEqual((yield* sql`PRAGMA auto_vacuum`)[0]?.auto_vacuum, 0);
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("refuses compaction while a real sync holds the lock", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const layer = TestMailbox.withAdapter(
      (base) => ({
        ...base,
        pull: (account, cursor, scope) =>
          Stream.fromEffect(
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ).pipe(Stream.flatMap(() => base.pull(account, cursor, scope))),
      }),
      { servers: { gmail: fakeServer("cache@example.com", []) } },
    );
    yield* Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      yield* mailbox.connect({ provider: "gmail" });
      const sync = yield* mailbox.sync().pipe(Effect.forkChild);
      yield* Deferred.await(started);
      assert.strictEqual(yield* mailbox.compactCache, "busy");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(sync);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

it.effect(
  "refuses compaction and automatic page reclamation during flushes or read-only sessions",
  () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const runtime = yield* makeMailboxRuntimeState;
      const storage = yield* makeStorageMailbox(store, runtime, undefined, false, Effect.void);
      yield* runtime.flushLock.withPermits(1)(
        Effect.gen(function* () {
          assert.strictEqual(yield* storage.compactCache, "busy");
          yield* storage.enforceCacheBudget(true);
          const sql = yield* SqlClient.SqlClient;
          assert.strictEqual((yield* sql`PRAGMA auto_vacuum`)[0]?.auto_vacuum, 2);
        }),
      );
      const readOnly = yield* makeStorageMailbox(store, runtime, undefined, true, Effect.void);
      assert.strictEqual(yield* readOnly.compactCache, "read-only");
      assert.strictEqual(yield* store.compactCache(true), "read-only");
    }).pipe(Effect.scoped, Effect.provide(storeLayer())),
);

it.effect("read-only mailbox refuses compact now before touching the database", () =>
  Effect.gen(function* () {
    const mailbox = yield* Mailbox;
    assert.strictEqual(yield* mailbox.compactCache, "read-only");
  }).pipe(
    Effect.provide(
      TestMailbox().pipe(
        Layer.provide(
          ConfigProvider.layer(ConfigProvider.fromEnvRecord({ OPENMAIL_READ_ONLY: "1" })),
        ),
      ),
    ),
  ),
);

it.effect("refuses corrupt FTS alignment before enabling VACUUM", () =>
  Effect.gen(function* () {
    const store = yield* Store;
    const sql = yield* SqlClient.SqlClient;
    const account = yield* store.upsertAccount("gmail", "cache@example.com");
    yield* store.upsertMessage(account.id, incoming("one"));
    yield* sql`INSERT INTO messages_fts(messages_fts) VALUES('delete-all')`;
    assert.strictEqual(yield* store.compactCache(false), "unsafe");
    assert.strictEqual((yield* sql`PRAGMA auto_vacuum`)[0]?.auto_vacuum, 2);
  }).pipe(Effect.provide(storeLayer())),
);

it.effect(
  "eviction checkpoints WAL and incrementally reclaims pages after explicit activation",
  () =>
    Effect.gen(function* () {
      const directory = yield* temporary;
      const file = join(directory, "mail.db");
      yield* Effect.gen(function* () {
        const store = yield* Store;
        const account = yield* store.upsertAccount("gmail", "cache@example.com");
        const now = yield* Clock.currentTimeMillis;
        // Activate incremental vacuum while the database is small.
        assert.strictEqual(yield* store.compactCache(false), "done");
        yield* store.upsertMessage(
          account.id,
          incoming("large", {
            date: now - 500 * 86400000,
            labels: [],
            bodyText: "payload ".repeat(256 * 1024),
          }),
        );
        const before = yield* store.cacheDatabaseSize;
        const runtime = yield* makeMailboxRuntimeState;
        yield* store.setPrefs({ totalCacheBytes: 1 });
        const storage = yield* makeStorageMailbox(store, runtime, undefined, false, Effect.void);
        yield* storage.enforceCacheBudget(true);
        assert.isFalse((yield* store.getMessage(`${account.id}/large`)).bodyCached);
        const after = yield* store.cacheDatabaseSize;
        assert.ok(after.totalBytes < before.totalBytes);
        assert.strictEqual((yield* Effect.promise(() => measureCacheStorage(file))).walBytes, 0);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO messages_fts(messages_fts,rank) VALUES('integrity-check',1)`;
      }).pipe(Effect.scoped, Effect.provide(storeLayer(file)));
    }).pipe(Effect.scoped),
);

it("credits reusable pages so pressure does not keep deleting text without freeing disk", () => {
  const disk = { freeBytes: 20, totalBytes: 1000 };
  const files = { walBytes: 0, recoveryBytes: 0, disk };
  const prefs = { bodyCacheBytes: 0, totalCacheBytes: 0 };
  const before = cacheAccounting({ totalBytes: 1000, reusableBytes: 0 }, 200, 0, files);
  assert.strictEqual(adaptiveBodyLimit(before, disk, prefs).effectiveBodyBytes, 120);
  const after = cacheAccounting({ totalBytes: 1000, reusableBytes: 80 }, 120, 0, files);
  assert.strictEqual(adaptiveBodyLimit(after, disk, prefs).effectiveBodyBytes, 120);
  assert.strictEqual(
    adaptiveBodyLimit(after, disk, { ...prefs, totalCacheBytes: 1000 }).effectiveBodyBytes,
    120,
  );
});

it.effect("legacy low disk does not discard text until disk reclamation is enabled", () =>
  Effect.gen(function* () {
    const directory = yield* temporary;
    const file = join(directory, "mail.db");
    yield* Effect.sync(() => {
      const db = new DatabaseSync(file);
      try {
        for (const migration of MIGRATIONS.slice(0, 36)) applyNativeMigration(db, migration);
        db.exec("PRAGMA user_version=36");
      } finally {
        db.close();
      }
    });
    yield* Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount("gmail", "legacy@example.com");
      const now = yield* Clock.currentTimeMillis;
      yield* store.upsertMessage(
        account.id,
        incoming("old", { date: now - 500 * 86400000, labels: [] }),
      );
      const runtime = yield* makeMailboxRuntimeState;
      const storage = yield* makeStorageMailbox(store, runtime, undefined, false, Effect.void).pipe(
        Effect.provideService(CacheStorage, {
          measure: () =>
            Effect.succeed({
              walBytes: 0,
              recoveryBytes: 0,
              disk: { freeBytes: 0, totalBytes: 1000 },
            }),
        }),
      );
      {
        const size = yield* storage.cacheDatabaseSize;
        assert.isTrue(size.lowDisk);
        assert.isFalse(size.canReclaim);
        assert.isNull(size.effectiveBodyBytes);
      }
      yield* storage.enforceCacheBudget(true);
      yield* storage.enforceCacheBudget(true);
      assert.isTrue((yield* store.getMessage(`${account.id}/old`)).bodyCached);
      assert.strictEqual(yield* store.compactCache(false), "done");
      yield* storage.enforceCacheBudget(true);
      assert.isFalse((yield* store.getMessage(`${account.id}/old`)).bodyCached);
    }).pipe(Effect.scoped, Effect.provide(storeLayer(file)));
  }).pipe(Effect.scoped),
);

import { TestClock } from "effect/testing";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, it } from "@effect/vitest";
import { ConfigProvider, Deferred, Effect, Layer, ManagedRuntime, Schema, Stream } from "effect";
import { SqlClient } from "effect/sql";
import type { IncomingMessage } from "../../domain/message.js";
import type { Provider } from "../../domain/account.js";
import { backfillCachedHeaders } from "../../sync/header-backfill.js";
import type { CachedHeaders } from "../../sync/sync-records.js";
import { readOnlyAdapter } from "../../mailbox/read-only.js";
import { ProviderError } from "../../domain/errors.js";
import { Providers } from "../../providers/adapter.js";
import { Store } from "../../store/service.js";
import { Mailbox } from "../../mailbox/mailbox.js";
import { MailboxLive } from "../../mailbox/mailbox-live.js";
import { StoreLive } from "../../store/store.js";
import { all, run } from "../../store/sql-rows.js";
import { fakeServer, makeFakeProvider } from "./fake-provider.js";
import { MemoryPlatform } from "./platform-memory.js";

const message = (providerId: string, date: number): IncomingMessage => ({
  providerId,
  threadId: providerId,
  subject: "Cached searchable subject",
  from: { name: "Alice", address: "alice@example.test" },
  to: [],
  cc: [],
  date,
  snippet: "cached",
  bodyText: "searchable body",
  bodyHtml: "<p>cached</p>",
  labels: ["INBOX", "UNREAD", "STARRED", "custom"],
  isUnread: true,
  isStarred: true,
  attachments: [],
});
const headers = (id: string): CachedHeaders => ({
  kind: "headers",
  id,
  rfcMessageId: `<${id}@example.test>`,
  headers: [
    { name: "message-id", value: `<${id}@example.test>` },
    { name: "list-id", value: "list.example.test" },
  ],
});

for (const provider of ["gmail", "outlook", "imap"] satisfies Provider[]) {
  it(`${provider}: metadata budget and newest-first cursor survive closing and reopening the database`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "openmail-headers-"));
    const accountId = `${provider}:me@example.test`;
    const id = (n: number) => (provider === "imap" ? `7:${n}:INBOX` : `m${n}`);
    const calls: string[][] = [];
    const adapter = readOnlyAdapter({
      ...makeFakeProvider(fakeServer("me@example.test")),
      fetchCachedHeaders: (_account, ids) =>
        Effect.sync(() => {
          calls.push([...ids]);
          return ids.map((item) =>
            item === id(503)
              ? ({ kind: "unavailable", id: item } satisfies CachedHeaders)
              : headers(item),
          );
        }),
    });
    const createRuntime = () =>
      ManagedRuntime.make(
        StoreLive.pipe(
          Layer.provideMerge(MemoryPlatform({ database: join(directory, "mail.db") })),
        ),
      );
    let runtime = createRuntime();
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* Store;
          const account = yield* store.upsertAccount(provider, "me@example.test");
          const other = yield* store.upsertAccount(provider, "other@example.test");
          yield* store.transaction(
            Effect.gen(function* () {
              // Tied dates exercise the second seek key as well as date ordering.
              for (let n = 1; n <= 503; n++)
                yield* store.upsertMessage(account.id, message(id(n), Math.floor(n / 2)));
              yield* store.upsertMessage(other.id, message("untouched", 1000));
            }),
          );
          yield* backfillCachedHeaders(store, adapter, account);
          assert.strictEqual(calls.flat().length, 500);
          assert.strictEqual(calls[0]?.[0], id(503));
          assert.isTrue(calls.every((batch) => batch.length <= 20));
          assert.strictEqual((yield* store.headerBackfillState(account.id)).kind, "running");
          assert.isUndefined((yield* store.getMessage(`${other.id}/untouched`)).headers);
        }),
      );
      await runtime.dispose();
      runtime = createRuntime();
      await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* Store;
          const account = yield* store.getAccount(accountId);
          yield* backfillCachedHeaders(store, adapter, account);
          assert.strictEqual(calls.flat().length, 503);
          assert.strictEqual(new Set(calls.flat()).size, 503);
          assert.strictEqual((yield* store.headerBackfillState(account.id)).kind, "done");
          for (let n = 1; n <= 503; n++) {
            const cached = yield* store.getMessage(`${account.id}/${id(n)}`);
            assert.deepStrictEqual(cached.labels, message(id(n), 0).labels);
            assert.isTrue(cached.isUnread);
            assert.isTrue(cached.isStarred);
            assert.strictEqual(cached.bodyText, "searchable body");
            if (n === 503) assert.isUndefined(cached.rfcMessageId);
            else assert.strictEqual(cached.rfcMessageId, `<${id(n)}@example.test>`);
          }
          yield* backfillCachedHeaders(store, adapter, account);
          assert.strictEqual(
            calls.flat().length,
            503,
            "completion stops future network reads, even for gone/missing Message-ID rows",
          );
        }),
      );
    } finally {
      await runtime.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

it.effect(
  "metadata update preserves rowid and existing headers/identity, and fires no FTS or other message triggers",
  () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      const account = yield* store.upsertAccount("gmail", "me@example.test");
      yield* store.upsertMessage(account.id, {
        ...message("a", 10),
        rfcMessageId: "<existing@example.test>",
      });
      yield* store.upsertMessage(account.id, { ...message("b", 9), headers: [] });
      const Row = Schema.Struct({
        rowid: Schema.Number,
        id: Schema.String,
        labels_json: Schema.String,
        is_unread: Schema.Number,
        is_starred: Schema.Number,
        subject: Schema.String,
        body_text: Schema.String,
      });
      const snapshot = () =>
        all(Row)(
          sql`SELECT rowid,id,labels_json,is_unread,is_starred,subject,body_text FROM messages ORDER BY id`,
        );
      const before = yield* snapshot();
      const count = () =>
        all(Schema.Struct({ n: Schema.Number }))(sql`SELECT total_changes() AS n`).pipe(
          Effect.map((rows) => rows[0]?.n ?? 0),
        );
      for (const row of yield* store.headerBackfillCandidates(account.id, null, 20)) {
        const start = yield* count();
        const value = headers(row.providerId);
        assert.strictEqual(value.kind, "headers");
        if (value.kind === "headers") yield* store.updateCachedHeaders(account.id, row, value);
        assert.strictEqual(
          (yield* count()) - start,
          1,
          "only the message row changes; FTS shadow tables/jobs remain untouched",
        );
      }
      assert.deepStrictEqual(yield* snapshot(), before);
      assert.strictEqual(
        (yield* store.getMessage(`${account.id}/a`)).rfcMessageId,
        "<existing@example.test>",
      );
      assert.deepStrictEqual((yield* store.getMessage(`${account.id}/b`)).headers, []);
      // SQLite's FTS integrity check verifies external-content rowid alignment.
      yield* run(sql`INSERT INTO messages_fts(messages_fts,rank) VALUES('integrity-check',1)`);
    }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
);

it.effect(
  "failed/incomplete metadata batches retain the cursor, retry on the next pass and never delete rows",
  () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount("gmail", "me@example.test");
      for (let n = 1; n <= 41; n++) yield* store.upsertMessage(account.id, message(`m${n}`, n));
      let count = 0;
      const adapter = {
        ...makeFakeProvider(fakeServer("me@example.test")),
        fetchCachedHeaders: (_account: typeof account, ids: readonly string[]) =>
          ++count === 2
            ? Effect.fail(new ProviderError({ message: "Throttled", deferred: true }))
            : Effect.succeed(ids.map(headers)),
      };
      const result = yield* backfillCachedHeaders(store, adapter, account).pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(count, 2);
      const afterFailure = yield* store.headerBackfillState(account.id);
      assert.deepStrictEqual(afterFailure, {
        kind: "running",
        after: { date: 22, id: `${account.id}/m22` },
        retryAt: 60_000,
      });
      yield* backfillCachedHeaders(
        store,
        { ...adapter, fetchCachedHeaders: () => Effect.succeed([]) },
        account,
      );
      assert.deepStrictEqual(yield* store.headerBackfillState(account.id), afterFailure);
      assert.isUndefined((yield* store.getMessage(`${account.id}/m1`)).headers);
      yield* backfillCachedHeaders(store, adapter, account);
      assert.strictEqual(count, 2);
      yield* TestClock.adjust("1 minute");
      yield* backfillCachedHeaders(store, adapter, account);
      assert.strictEqual((yield* store.headerBackfillState(account.id)).kind, "done");
      yield* store.removeAccount(account.id);
      assert.deepStrictEqual(yield* store.headerBackfillState(account.id), {
        kind: "running",
        after: null,
      });
    }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
);

for (const provider of ["gmail", "outlook", "imap"] satisfies Provider[]) {
  it.effect(
    `${provider}: successful read-only full sync repairs old metadata without replaying queued flags`,
    () => {
      const providerId = provider === "imap" ? "7:1:INBOX" : "m1";
      let requests = 0;
      const adapter = {
        ...makeFakeProvider(fakeServer("me@example.test")),
        pull: () => Stream.succeed({ _tag: "Cursor" as const, cursor: "1" }),
        fetchCachedHeaders: (_account: unknown, ids: readonly string[]) =>
          Effect.sync(() => {
            requests++;
            return ids.map(headers);
          }),
        folderStatus: () => Effect.fail(new ProviderError({ message: "No counts" })),
        push: () => Effect.die("Read-only sync must not push"),
      };
      const runtime = MailboxLive({ backgroundFlush: false, imapIdle: false }).pipe(
        Layer.provideMerge(
          Layer.mergeAll(StoreLive, Layer.succeed(Providers, { get: () => adapter })).pipe(
            Layer.provideMerge(MemoryPlatform()),
          ),
        ),
        Layer.provide(
          ConfigProvider.layer(ConfigProvider.fromEnvRecord({ OPENMAIL_READ_ONLY: "1" })),
        ),
      );
      return Effect.gen(function* () {
        const store = yield* Store;
        const mailbox = yield* Mailbox;
        const account = yield* store.upsertAccount(provider, "me@example.test");
        yield* store.upsertMessage(account.id, message(providerId, 1));
        yield* store.enqueueOp(account.id, providerId, { kind: "read", value: true });
        const sync = yield* mailbox.sync.sync(account.id);
        assert.isUndefined(sync[0]?.error);
        const patched = yield* store.getMessage(`${account.id}/${providerId}`);
        assert.strictEqual(patched.rfcMessageId, `<${providerId}@example.test>`);
        assert.isTrue(patched.isUnread);
        assert.isTrue(patched.isStarred);
        assert.deepStrictEqual(patched.labels, message(providerId, 1).labels);
        assert.strictEqual(requests, 1);
        assert.strictEqual((yield* store.headerBackfillState(account.id)).kind, "done");
        yield* mailbox.sync.sync(account.id);
        assert.strictEqual(requests, 1);
      }).pipe(Effect.provide(runtime));
    },
  );
}

it.effect("Outlook metadata maintenance advances a full budget while delta pull is blocked", () =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<void>();
    const pulling = yield* Deferred.make<void>();
    const block = yield* Deferred.make<void>();
    const budgetFilled = yield* Deferred.make<void>();
    let requested = 0;
    const adapter = {
      ...makeFakeProvider(fakeServer("me@example.test")),
      pull: () =>
        Stream.fromEffect(
          Deferred.succeed(pulling, undefined).pipe(Effect.andThen(Deferred.await(block))),
        ).pipe(Stream.flatMap(() => Stream.empty)),
      fetchCachedHeaders: (_account: unknown, ids: readonly string[]) =>
        Effect.gen(function* () {
          requested += ids.length;
          if (requested === 500) yield* Deferred.succeed(budgetFilled, undefined);
          return ids.map(headers);
        }),
    };
    const runtime = MailboxLive({
      autoSync: "1 hour",
      backgroundReady: Deferred.await(ready),
      backgroundFlush: false,
      imapIdle: false,
    }).pipe(
      Layer.provideMerge(
        Layer.mergeAll(StoreLive, Layer.succeed(Providers, { get: () => adapter })).pipe(
          Layer.provideMerge(MemoryPlatform()),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const store = yield* Store;
      yield* Mailbox;
      const account = yield* store.upsertAccount("outlook", "me@example.test");
      yield* store.saveSyncCursor(account.id, "old-delta");
      yield* store.transaction(
        Effect.gen(function* () {
          for (let n = 0; n < 600; n++) yield* store.upsertMessage(account.id, message(`m${n}`, n));
        }),
      );
      yield* Deferred.succeed(ready, undefined);
      yield* Deferred.await(pulling);
      yield* TestClock.adjust("10 seconds");
      assert.isAbove(requested, 0);
      yield* Deferred.await(budgetFilled);
      assert.strictEqual(requested, 500);
      const state = yield* store.headerBackfillState(account.id);
      assert.strictEqual(state.kind, "running");
    }).pipe(Effect.provide(runtime));
  }),
);

it("a server Retry-After deadline survives closing and reopening the cache", async () => {
  const directory = mkdtempSync(join(tmpdir(), "openmail-header-retry-"));
  const createRuntime = () =>
    ManagedRuntime.make(
      StoreLive.pipe(Layer.provideMerge(MemoryPlatform({ database: join(directory, "mail.db") }))),
    );
  let runtime = createRuntime();
  let requests = 0;
  const adapter = {
    ...makeFakeProvider(fakeServer("me@example.test")),
    fetchCachedHeaders: (_account: unknown, _ids: readonly string[]) => {
      requests++;
      return Effect.fail(
        new ProviderError({ message: "Throttled", status: 429, retryAfter: "120" }),
      );
    },
  };
  try {
    const checkpoint = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* Store;
        const account = yield* store.upsertAccount("outlook", "me@example.test");
        yield* store.upsertMessage(account.id, message("a", 1));
        const result = yield* backfillCachedHeaders(store, adapter, account).pipe(Effect.result);
        assert.strictEqual(result._tag, "Failure");
        return yield* store.headerBackfillState(account.id);
      }),
    );
    await runtime.dispose();
    runtime = createRuntime();
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* Store;
        const account = yield* store.getAccount("outlook:me@example.test");
        assert.deepStrictEqual(yield* store.headerBackfillState(account.id), checkpoint);
        yield* backfillCachedHeaders(store, adapter, account);
        assert.strictEqual(requests, 1, "restart must not bypass the persisted deadline");
        yield* store.saveHeaderBackfillState(account.id, {
          kind: "running",
          after: null,
          retryAt: 0,
        });
        yield* backfillCachedHeaders(
          store,
          { ...adapter, fetchCachedHeaders: (_owner, ids) => Effect.succeed(ids.map(headers)) },
          account,
        );
        assert.strictEqual((yield* store.headerBackfillState(account.id)).kind, "done");
      }),
    );
  } finally {
    await runtime.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

it.effect(
  "an incomplete batch cannot move its cursor or get retried on every maintenance tick",
  () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount("outlook", "me@example.test");
      yield* store.upsertMessage(account.id, message("a", 1));
      let calls = 0;
      const adapter = {
        ...makeFakeProvider(fakeServer("me@example.test")),
        fetchCachedHeaders: () =>
          Effect.sync(() => {
            calls++;
            return [];
          }),
      };
      assert.strictEqual(
        (yield* backfillCachedHeaders(store, adapter, account).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.deepStrictEqual(yield* store.headerBackfillState(account.id), {
        kind: "running",
        after: null,
        retryAt: 60_000,
      });
      yield* TestClock.adjust("10 seconds");
      yield* backfillCachedHeaders(store, adapter, account);
      assert.strictEqual(calls, 1);
      assert.isUndefined((yield* store.getMessage(`${account.id}/a`)).headers);
    }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
);

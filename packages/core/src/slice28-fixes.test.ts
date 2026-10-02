import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { databaseLayer } from "./db.js";
import { vi } from "vitest";
import { TestClock } from "effect/testing";
import { MailboxLive, type MailboxOptions } from "./mailbox-live.js";
import { Mailbox } from "./mailbox.js";
import { Store, Providers, Secrets, type ProviderAdapter } from "./services.js";
import { MemoryPlatform } from "./platform-memory.js";
import { StoreLive } from "./store.js";
import { fakeServer, makeFakeProvider } from "./fake-provider.js";
import { ProviderError } from "./errors.js";

function withMailbox<A, E>(
  body: (directory: string) => Effect.Effect<A, E, Mailbox | Store | Secrets>,
  adapter: ProviderAdapter,
  options: MailboxOptions = {},
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "openmail-slice28-fix-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
      );
      const deps = Layer.merge(StoreLive, Layer.succeed(Providers, { get: () => adapter })).pipe(
        Layer.provideMerge(
          Layer.merge(
            MemoryPlatform(),
            databaseLayer(path.join(directory, "mail.db")).pipe(
              Layer.provide(NodeFileSystem.layer),
              Layer.provide(NodePath.layer),
            ),
          ),
        ),
      );
      return yield* body(directory).pipe(
        Effect.provide(
          MailboxLive({ ...options, attachmentCacheDirectory: directory }).pipe(
            Layer.provideMerge(deps),
          ),
        ),
      );
    }),
  );
}

it.effect("history failure discards the expired provider cursor before explicit retry", () => {
  const cursors: (string | null)[] = [];
  const fake = makeFakeProvider(fakeServer("me@example.com"));
  let failed = false;
  const adapter: ProviderAdapter = {
    ...fake,
    listFolderMessages: (_account, _folder, cursor) => {
      cursors.push(cursor);
      if (cursor === "expired" && !failed) {
        failed = true;
        return Effect.fail(new ProviderError({ message: "Expired cursor", status: 400 }));
      }
      return Effect.succeed({ ids: [], next: cursor === null ? "expired" : null });
    },
  };
  return withMailbox(
    () =>
      Effect.gen(function* () {
        const s = yield* Store;
        const m = yield* Mailbox;
        const account = yield* s.upsertAccount("outlook", "me@example.com");
        const query = { mailbox: "inbox" as const, accountIds: [account.id] };
        yield* Effect.exit(m.fetchOlder(query));
        cursors.length = 0;
        yield* Effect.exit(m.fetchOlder(query));
        assert.strictEqual(cursors[0], null);
      }),
    adapter,
  );
});

it.effect(
  "cache I/O failures do not prevent clearing bodies, removing the account or deleting its secret",
  () =>
    withMailbox(
      (directory) =>
        Effect.gen(function* () {
          const s = yield* Store;
          const m = yield* Mailbox;
          const secrets = yield* Secrets;
          const account = yield* s.upsertAccount("imap", "me@example.com");
          yield* secrets.set(account.id, "test-password");
          yield* Effect.promise(() =>
            writeFile(path.join(directory, "attachment-cache"), "Not a directory"),
          );
          yield* m.clearCache(account.id);
          yield* m.perform(
            { kind: "removeAccount", accountId: account.id },
            { kind: "user", surface: "app" },
          );
          assert.deepStrictEqual(yield* m.accounts, []);
          assert.isTrue(Option.isNone(yield* secrets.get(account.id)));
        }),
      makeFakeProvider(fakeServer("me@example.com")),
    ),
);

it.effect(
  "an IDLE burst polls only the changed account inbox and never flushes another account",
  () => {
    const signals = new Map<string, () => void>();
    const pulls: { id: string; scope: string | undefined }[] = [];
    const fake = makeFakeProvider(fakeServer("me@example.com"));
    const adapter: ProviderAdapter = {
      ...fake,
      pull: (account, cursor, scope) => {
        pulls.push({ id: account.id, scope });
        return fake.pull(account, cursor, scope);
      },
      watchInbox: (account, signal, changed, ready) =>
        Effect.callback<void>((resume) => {
          signals.set(account.id, changed);
          const close = () => resume(Effect.void);
          signal.addEventListener("abort", close, { once: true });
          ready();
          return Effect.sync(() => signal.removeEventListener("abort", close));
        }),
    };
    return withMailbox(
      () =>
        Effect.gen(function* () {
          const store = yield* Store;
          const first = yield* store.upsertAccount("imap", "first@example.com");
          const second = yield* store.upsertAccount("imap", "second@example.com");
          const third = yield* store.upsertAccount("gmail", "third@example.com");
          for (const a of [first, second, third]) yield* store.saveSyncCursor(a.id, "0");
          yield* TestClock.adjust("5 seconds");
          yield* Effect.promise(() => vi.waitFor(() => assert.strictEqual(pulls.length, 2)));
          pulls.length = 0;
          for (let i = 0; i < 10; i++) signals.get(first.id)?.();
          yield* Effect.promise(() => vi.waitFor(() => assert.strictEqual(pulls.length, 1)));
          assert.deepStrictEqual(pulls, [{ id: first.id, scope: "inbox" }]);
        }),
      adapter,
      { imapIdle: true },
    );
  },
);

it.effect("mailbox shutdown interrupts an IDLE inbox poll before disposing the database", () =>
  Effect.gen(function* () {
    let started = false;
    let interrupted = false;
    const fake = makeFakeProvider(fakeServer("me@example.com"));
    const adapter: ProviderAdapter = {
      ...fake,
      pull: () =>
        Stream.never.pipe(
          Stream.ensuring(
            Effect.sync(() => {
              interrupted = true;
            }),
          ),
        ),
      watchInbox: (_account, signal, _changed, ready) =>
        Effect.callback<void>((resume) => {
          const close = () => resume(Effect.void);
          signal.addEventListener("abort", close, { once: true });
          ready();
          return Effect.sync(() => signal.removeEventListener("abort", close));
        }),
    };
    const blocking: ProviderAdapter = {
      ...adapter,
      pull: (...args) => {
        started = true;
        return adapter.pull(...args);
      },
    };
    yield* withMailbox(
      () =>
        Effect.gen(function* () {
          const s = yield* Store;
          const a = yield* s.upsertAccount("imap", "me@example.com");
          yield* s.saveSyncCursor(a.id, "0");
          yield* TestClock.adjust("5 seconds");
          yield* Effect.promise(() => vi.waitFor(() => assert.isTrue(started)));
        }),
      blocking,
      { imapIdle: true },
    );
    assert.isTrue(interrupted);
  }),
);

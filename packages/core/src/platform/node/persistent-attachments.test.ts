import { TestMailbox } from "./testing.js";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";
import { mkdtemp, rm, readdir, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, vi } from "vitest";
import { databaseLayer } from "./db.js";
import { MailboxLive, type MailboxOptions } from "../../mailbox/mailbox-live.js";
import { Mailbox } from "../../mailbox/mailbox.js";
import { Store } from "../../store/service.js";
import { Providers, type ProviderAdapter } from "../../providers/adapter.js";
import { Secrets } from "../auth.js";
import { MemoryPlatform } from "./platform-memory.js";
import { StoreLive } from "../../store/store.js";
import { fakeServer, makeFakeProvider } from "./fake-provider.js";
import { PersistentAttachments } from "./persistent-attachments.js";
import { type IncomingMessage } from "../../domain/domain.js";
import { ProviderError } from "../../domain/errors.js";
import { TestClock } from "effect/testing";
{
  const message = (id: number, label = "INBOX"): IncomingMessage => ({
    providerId: String(id).padStart(4, "0"),
    threadId: String(id),
    subject: `Subject ${id}`,
    from: { name: "Alice", address: "alice@example.com" },
    to: [],
    cc: [],
    replyTo: [],
    date: id * 1000,
    snippet: "header",
    bodyText: "body",
    bodyHtml: "<p>body</p>",
    labels: [label],
    attachments: [{ filename: "report.txt", mimeType: "text/plain", size: 4 }],
    isUnread: true,
    isStarred: false,
  });

  it("persists attachment bytes, uses restrictive modes, evicts by access, and refuses symlink caches", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "openmail-disk-cache-"));
    try {
      const cache = new PersistentAttachments(directory);
      await cache.set("../../account", "../../a", new Uint8Array([1, 2]), 4);
      await cache.set("../../account", "b", new Uint8Array([3, 4]), 4);
      const account = (await readdir(path.join(directory, "attachment-cache")))[0];
      if (!account) throw new Error("Missing cache account");
      const folder = path.join(directory, "attachment-cache", account);
      expect((await stat(folder)).mode & 0o777).toBe(0o700);
      for (const name of await readdir(folder))
        expect((await stat(path.join(folder, name))).mode & 0o777).toBe(0o600);
      const reopened = new PersistentAttachments(directory);
      expect(await reopened.get("../../account", "../../a", 4)).toEqual(Buffer.from([1, 2]));
      // Age both entries so the read below is the newest use even on coarse filesystems.
      const past = new Date(Date.now() - 60_000);
      for (const name of await readdir(folder)) await utimes(path.join(folder, name), past, past);
      await reopened.get("../../account", "../../a", 4);
      await reopened.set("other", "c", new Uint8Array([5, 6]), 4);
      expect(await reopened.get("../../account", "b", 4)).toBeNull();
      expect(await reopened.size()).toBe(4);
      const downloadVersion = reopened.version();
      await reopened.clear("../../account");
      await reopened.set("../../account", "late-download", new Uint8Array([9]), 4, downloadVersion);
      expect(await reopened.size("../../account")).toBe(0);
      await reopened.trim(0);
      expect(await reopened.size()).toBe(0);
      await rm(path.join(directory, "attachment-cache"), { recursive: true });
      await symlink(os.tmpdir(), path.join(directory, "attachment-cache"));
      await expect(reopened.set("a", "b", new Uint8Array([1]), 4)).rejects.toThrow(
        "Invalid cache directory",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  for (const provider of ["gmail", "outlook", "imap"] as const) {
    it.effect(
      `${provider} pages the current folder with independent cursors and preserves local changes`,
      () =>
        Effect.gen(function* () {
          const remote = fakeServer("me@example.com", [
            ...Array.from({ length: 220 }, (_, i) => message(i + 1, "Projects")),
            message(999),
          ]);
          const adapters = Layer.succeed(Providers, { get: () => makeFakeProvider(remote) });
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "openmail-history-"))),
            (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
          );
          const platform = Layer.merge(
            MemoryPlatform(),
            databaseLayer(path.join(directory, "mail.db")).pipe(
              Layer.provide(NodeFileSystem.layer),
              Layer.provide(NodePath.layer),
            ),
          );
          const dependencies = Layer.merge(StoreLive, adapters).pipe(Layer.provideMerge(platform));
          yield* Effect.gen(function* () {
            const store = yield* Store;
            const mailbox = yield* Mailbox;
            const account = yield* store.upsertAccount(provider, remote.email);
            const existing = message(220, "Projects");
            yield* store.upsertMessage(account.id, {
              ...existing,
              isUnread: false,
              isStarred: true,
            });
            const query = { mailbox: "all" as const, label: "Projects", accountIds: [account.id] };
            assert.isFalse((yield* mailbox.fetchOlder(query)).done);
            assert.strictEqual((yield* mailbox.threads({ ...query, limit: 500 })).length, 100);
            assert.strictEqual(
              (yield* store.getMessage(`${account.id}/${existing.providerId}`)).isUnread,
              false,
            );
            assert.isTrue(
              (yield* store.getMessage(`${account.id}/${existing.providerId}`)).isStarred,
            );
            // INBOX must start from its own first page, not the Projects continuation.
            assert.isTrue(
              (yield* mailbox.fetchOlder({ mailbox: "inbox", accountIds: [account.id] })).done,
            );
            assert.strictEqual((yield* mailbox.threads({ mailbox: "inbox" })).length, 1);
            assert.isFalse((yield* mailbox.fetchOlder(query)).done);
            assert.isTrue((yield* mailbox.fetchOlder(query)).done);
            assert.strictEqual((yield* mailbox.threads({ ...query, limit: 500 })).length, 220);
            const requests = remote.folderPages.length;
            assert.isTrue((yield* mailbox.fetchOlder(query)).done);
            assert.strictEqual(remote.folderPages.length, requests);
          }).pipe(Effect.provide(MailboxLive().pipe(Layer.provideMerge(dependencies))));
        }),
    );
  }

  it.effect(
    "cached attachments reopen offline after mailbox recreation; account removal clears disk and body clearing keeps drafts",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "openmail-offline-cache-"))),
          (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
        );
        const remote = fakeServer("me@example.com", [message(1), message(2, "DRAFT")]);
        remote.raw.set(
          "0001",
          Buffer.from(
            "MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nbody\r\n--x\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename=report.txt\r\n\r\ndata\r\n--x--\r\n",
          ),
        );
        const adapter = makeFakeProvider(remote);
        const dependencies = Layer.merge(
          StoreLive,
          Layer.succeed(Providers, { get: () => adapter }),
        ).pipe(
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
        const run = <E>(body: Effect.Effect<void, E, Mailbox | Store>) =>
          body.pipe(
            Effect.provide(
              MailboxLive({ attachmentCacheDirectory: directory }).pipe(
                Layer.provideMerge(dependencies),
              ),
            ),
          );
        yield* run(
          Effect.gen(function* () {
            const store = yield* Store;
            const m = yield* Mailbox;
            const a = yield* store.upsertAccount("gmail", remote.email);
            for (const original of remote.messages.values())
              yield* store.upsertMessage(a.id, original);
            const file = yield* m.attachment(`${a.id}/0001`, 0);
            assert.isAbove(file.data.length, 0);
            assert.isAbove((yield* m.cacheSize)[0]?.attachmentBytes ?? 0, 0);
          }),
        );
        yield* run(
          Effect.gen(function* () {
            const m = yield* Mailbox;
            const a = (yield* m.accounts)[0];
            if (!a) throw new Error("Missing account");
            remote.failNext = new ProviderError({ message: "Offline" });
            assert.isAbove((yield* m.attachment(`${a.id}/0001`, 0)).data.length, 0);
            yield* m.clearCache(a.id);
            assert.strictEqual((yield* m.cacheSize)[0]?.attachmentBytes, 0);
            assert.strictEqual((yield* m.thread(`${a.id}/0001`))[0]?.bodyCached, false);
            assert.strictEqual((yield* m.thread(`${a.id}/0002`))[0]?.bodyCached, true);
            assert.strictEqual(
              (yield* Effect.flip(m.attachment(`${a.id}/0001`, 0)))._tag,
              "ProviderError",
            );
            yield* m.attachment(`${a.id}/0001`, 0);
            yield* m.perform(
              { kind: "removeAccount", accountId: a.id },
              { kind: "user", surface: "app" },
            );
            assert.strictEqual(
              yield* Effect.promise(() => new PersistentAttachments(directory).size()),
              0,
            );
          }),
        );
      }),
  );

  it.effect(
    "default profiles require two accounts and explicit acceptance, and the choice survives deletion",
    () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const m = yield* Mailbox;
        const names = { personal: "Personal", work: "Work" };
        yield* store.upsertAccount("gmail", "one@example.com");
        yield* m.initializeProfiles(true, names);
        assert.strictEqual((yield* m.profiles).length, 0);
        assert.isFalse((yield* m.prefs).defaultProfilesPrompted);
        yield* store.upsertAccount("imap", "two@example.com");
        yield* Effect.all([m.initializeProfiles(true, names), m.initializeProfiles(true, names)], {
          concurrency: 2,
        });
        assert.deepStrictEqual(
          (yield* m.profiles).map((p) => p.name),
          ["Personal", "Work"],
        );
        for (const p of yield* m.profiles) yield* m.deleteProfile(p.id);
        yield* m.initializeProfiles(true, names);
        assert.strictEqual((yield* m.profiles).length, 0);
      }).pipe(
        Effect.provide(
          TestMailbox.withAdapter(makeFakeProvider(fakeServer("me@example.com")), {
            options: {},
            platformOptions: {},
          }),
        ),
      ),
  );
}

{
  function withMailbox<A, E>(
    body: (directory: string) => Effect.Effect<A, E, Mailbox | Store | Secrets>,
    adapter: ProviderAdapter,
    options: MailboxOptions = {},
  ) {
    return Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "openmail-fix-"))),
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
}

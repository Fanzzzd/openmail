import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { mkdtemp, rm, readdir, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { databaseLayer } from "./platform/node/db.js";
import { MailboxLive } from "./mailbox-live.js";
import { Mailbox } from "./mailbox.js";
import { Store, Providers } from "./services.js";
import { MemoryPlatform } from "./platform/node/platform-memory.js";
import { StoreLive } from "./store.js";
import { fakeServer, makeFakeProvider } from "./platform/node/fake-provider.js";
import { PersistentAttachments } from "./platform/node/persistent-attachments.js";
import type { IncomingMessage } from "./domain.js";
import { ProviderError } from "./errors.js";

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
    // Ensure LRU timestamps have distinct ordering even on coarse filesystems.
    await new Promise((resolve) => {
      setTimeout(resolve, 15);
    });
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
          yield* store.upsertMessage(account.id, { ...existing, isUnread: false, isStarred: true });
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
        MailboxLive().pipe(
          Layer.provideMerge(
            Layer.merge(
              StoreLive,
              Layer.succeed(Providers, {
                get: () => makeFakeProvider(fakeServer("me@example.com")),
              }),
            ).pipe(Layer.provideMerge(MemoryPlatform())),
          ),
        ),
      ),
    ),
);

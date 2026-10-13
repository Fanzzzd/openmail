import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Semaphore } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databaseLayer } from "../platform/node/db.js";
import { DEFAULT_LIST_FILTERS, type IncomingMessage } from "./message.js";
import type { Provider } from "./account.js";
import { FOLDER_MESSAGE_LIMIT, GMAIL_PERMANENT_DELETE_SCOPE } from "./folder-actions.js";
import { AuthError, PermanentError } from "./errors.js";
import { makeFakeProvider } from "../platform/node/fake-provider.js";
import { makeFolderMailbox } from "../mailbox/mailbox-folders.js";
import { Mailbox } from "../mailbox/mailbox.js";
import { MailboxLive } from "../mailbox/mailbox-live.js";
import { MemoryPlatform } from "../platform/node/platform-memory.js";
import { NodeSystem } from "../platform/node/platform-node.js";
import { Providers } from "../providers/adapter.js";
import { Store } from "../store/service.js";
import { StoreLive } from "../store/store.js";
import { fakeServer } from "../platform/node/testing.js";
const message = (id: string, labels = ["INBOX", "UNREAD"], threadId = id): IncomingMessage => ({
  providerId: id,
  threadId,
  labels,
  isUnread: labels.includes("UNREAD"),
  isStarred: labels.includes("STARRED"),
  from: { name: "Sender", address: "sender@example.com" },
  to: [],
  cc: [],
  date: 1000,
  subject: id,
  snippet: "",
  bodyText: "body",
  bodyHtml: "",
  attachments: [],
});

for (const provider of ["gmail", "outlook", "imap"] satisfies Provider[]) {
  it.effect(
    `${provider}: folder actions skip disabled accounts and preserve their cached mail`,
    () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const account = yield* store.upsertAccount(provider, `${provider}@example.com`);
        yield* store.upsertMessage(account.id, message("trash", ["TRASH", "UNREAD"]));
        yield* store.enqueueOp(account.id, "trash", { kind: "read", value: true });
        yield* store.setAccountSettings(account.id, {
          enabled: false,
          description: "",
          color: null,
        });
        const mailbox = makeFolderMailbox(
          store,
          Providers.of({ get: () => assert.fail("Disabled account must not call a provider") }),
          Effect.void,
          (effect) => effect,
        );
        for (const accountIds of [undefined, [account.id]]) {
          assert.strictEqual(yield* mailbox.markFolderRead({ mailbox: "trash", accountIds }), 0);
          assert.strictEqual(yield* mailbox.emptyFolder({ mailbox: "trash", accountIds }, true), 0);
        }
        for (const flat of [true, false])
          assert.strictEqual(
            yield* mailbox.permanentlyDelete([`${account.id}/trash`], flat, "trash", true),
            0,
          );
        assert.isTrue(yield* store.hasMessage(`${account.id}/trash`));
        assert.strictEqual((yield* store.listPendingOps).length, 1);
        assert.isTrue((yield* store.getMessage(`${account.id}/trash`)).isUnread);
      }).pipe(Effect.provide(StoreLive.pipe(Layer.provide(MemoryPlatform())))),
  );

  for (const destructive of [false, true])
    it.effect(
      `${provider}: ${destructive ? "empty" : "mark all read"} stops when an account is disabled after listing`,
      () =>
        Effect.gen(function* () {
          const store = yield* Store;
          const account = yield* store.upsertAccount(provider, `${provider}@example.com`);
          yield* store.setGrantedScopes(account.id, [GMAIL_PERMANENT_DELETE_SCOPE]);
          yield* store.upsertMessage(account.id, message("trash", ["TRASH", "UNREAD"]));
          const server = fakeServer(account.email, [message("trash", ["TRASH", "UNREAD"])]);
          const mailbox = makeFolderMailbox(
            store,
            Providers.of({ get: () => makeFakeProvider(server) }),
            Effect.void,
            (effect) =>
              Effect.gen(function* () {
                if (server.folderPages.length)
                  yield* store
                    .setAccountSettings(account.id, {
                      enabled: false,
                      description: "",
                      color: null,
                    })
                    .pipe(Effect.orDie);
                return yield* effect;
              }),
          );
          const folder = { mailbox: "trash", accountIds: [account.id] } as const;
          assert.strictEqual(
            yield* destructive ? mailbox.emptyFolder(folder, true) : mailbox.markFolderRead(folder),
            0,
          );
          assert.strictEqual(server.folderPages.length, 1);
          assert.deepStrictEqual(server.deleted, []);
          assert.deepStrictEqual(server.batches, []);
          assert.isTrue(server.messages.get("trash")?.isUnread);
          assert.isTrue((yield* store.getMessage(`${account.id}/trash`)).isUnread);
        }).pipe(Effect.provide(StoreLive.pipe(Layer.provide(MemoryPlatform())))),
    );
}

it.effect(
  "disabled accounts do not block active accounts with missing delete grants or capabilities",
  () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const outlook = yield* store.upsertAccount("outlook", "active@example.com");
      const gmail = yield* store.upsertAccount("gmail", "disabled@gmail.com");
      const imap = yield* store.upsertAccount("imap", "disabled@example.com");
      for (const account of [outlook, gmail, imap])
        yield* store.upsertMessage(account.id, message(account.provider, ["TRASH", "UNREAD"]));
      for (const account of [gmail, imap])
        yield* store.setAccountSettings(account.id, {
          enabled: false,
          description: "",
          color: null,
        });
      const server = fakeServer(outlook.email, [message("outlook", ["TRASH", "UNREAD"])]);
      const mailbox = makeFolderMailbox(
        store,
        Providers.of({
          get: (provider) => {
            assert.strictEqual(provider, "outlook");
            return makeFakeProvider(server);
          },
        }),
        Effect.void,
        (effect) => effect,
      );
      assert.strictEqual(yield* mailbox.markFolderRead({ mailbox: "trash" }), 1);
      assert.strictEqual(
        yield* mailbox.permanentlyDelete(
          [gmail, outlook, imap].map((account) => `${account.id}/${account.provider}`),
          true,
          "trash",
          true,
        ),
        1,
      );
      server.messages.set("next", message("next", ["TRASH"]));
      assert.strictEqual(yield* mailbox.emptyFolder({ mailbox: "trash" }, true), 1);
      assert.deepStrictEqual(server.deleted, [["outlook"], ["next"]]);
      for (const account of [gmail, imap])
        assert.isTrue((yield* store.getMessage(`${account.id}/${account.provider}`)).isUnread);
    }).pipe(Effect.provide(StoreLive.pipe(Layer.provide(MemoryPlatform())))),
);

for (const provider of ["gmail", "outlook"] satisfies Provider[]) {
  it.effect(`${provider}: empty rechecks server location after a current-page restoration`, () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount(provider, `${provider}@example.com`);
      yield* store.setGrantedScopes(account.id, [GMAIL_PERMANENT_DELETE_SCOPE]);
      yield* store.upsertMessage(account.id, message("restored", ["TRASH"]));
      const server = fakeServer(account.email, [message("restored", ["TRASH"])]);
      const fake = makeFakeProvider(server);
      const adapter = {
        ...fake,
        listFolderMessages: (...args: Parameters<typeof fake.listFolderMessages>) =>
          fake
            .listFolderMessages(...args)
            .pipe(
              Effect.tap(() =>
                Effect.sync(() => server.messages.set("restored", message("restored", ["INBOX"]))),
              ),
            ),
      };
      const mailbox = makeFolderMailbox(
        store,
        Providers.of({ get: () => adapter }),
        Effect.void,
        (effect) => effect,
      );
      assert.strictEqual(
        yield* mailbox.emptyFolder({ mailbox: "trash", accountIds: [account.id] }, true),
        0,
      );
      assert.isTrue(server.messages.has("restored"));
      assert.isTrue(yield* store.hasMessage(`${account.id}/restored`));
      assert.deepStrictEqual(server.deleted, []);
    }).pipe(Effect.provide(StoreLive.pipe(Layer.provide(MemoryPlatform())))),
  );
  it.effect(`${provider}: selection skips mail restored on another device before local sync`, () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount(provider, `${provider}@example.com`);
      yield* store.setGrantedScopes(account.id, [GMAIL_PERMANENT_DELETE_SCOPE]);
      yield* store.upsertMessage(account.id, message("restored", ["TRASH"]));
      const server = fakeServer(account.email, [message("restored", ["INBOX"])]);
      const mailbox = makeFolderMailbox(
        store,
        Providers.of({ get: () => makeFakeProvider(server) }),
        Effect.void,
        (effect) => effect,
      );
      assert.strictEqual(
        yield* mailbox.permanentlyDelete([`${account.id}/restored`], true, "trash", true),
        0,
      );
      assert.isTrue(server.messages.has("restored"));
      assert.isTrue(yield* store.hasMessage(`${account.id}/restored`));
      assert.deepStrictEqual(server.deleted, []);
    }).pipe(Effect.provide(StoreLive.pipe(Layer.provide(MemoryPlatform())))),
  );
  it.effect(
    `${provider}: empty skips a current-page message restored by the app's protected flush`,
    () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const account = yield* store.upsertAccount(provider, `${provider}@example.com`);
        yield* store.setGrantedScopes(account.id, [GMAIL_PERMANENT_DELETE_SCOPE]);
        yield* store.upsertMessage(account.id, message("restored", ["TRASH"]));
        const server = fakeServer(account.email, [message("restored", ["TRASH"])]);
        const fake = makeFakeProvider(server);
        let moved = false;
        let attempts = 0;
        const adapter = {
          ...fake,
          permanentlyDelete: (...args: Parameters<typeof fake.permanentlyDelete>) => {
            attempts++;
            return fake.permanentlyDelete(...args);
          },
        };
        const protect = <A, E>(effect: Effect.Effect<A, E>) =>
          Effect.gen(function* () {
            if (!moved && server.folderPages.length === 1) {
              moved = true;
              yield* store.applyLocalOp(`${account.id}/restored`, { kind: "inbox" });
              server.messages.set("restored", message("restored", ["INBOX"]));
            }
            return yield* effect;
          });
        const mailbox = makeFolderMailbox(
          store,
          Providers.of({ get: () => adapter }),
          Effect.void,
          protect,
        );
        assert.strictEqual(
          yield* mailbox.emptyFolder({ mailbox: "trash", accountIds: [account.id] }, true),
          0,
        );
        assert.strictEqual(attempts, 0);
        assert.isTrue(server.messages.has("restored"));
        assert.isTrue(yield* store.hasMessage(`${account.id}/restored`));
        assert.deepStrictEqual(server.deleted, []);
      }).pipe(Effect.provide(StoreLive.pipe(Layer.provide(MemoryPlatform())))),
  );
}

it.effect(
  "an incapable IMAP account blocks multi-account empty before any folder or deletion request",
  () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const gmail = yield* store.upsertAccount("gmail", "me@gmail.com");
      const imap = yield* store.upsertAccount("imap", "me@example.com");
      yield* store.setGrantedScopes(gmail.id, [GMAIL_PERMANENT_DELETE_SCOPE]);
      const google = fakeServer(gmail.email, [message("g", ["TRASH"])]);
      const legacy = fakeServer(imap.email, [message("i", ["TRASH"])]);
      legacy.supportsPermanentDelete = false;
      yield* store.upsertMessage(gmail.id, message("g", ["TRASH"]));
      yield* store.upsertMessage(imap.id, message("i", ["TRASH"]));
      const mailbox = makeFolderMailbox(
        store,
        Providers.of({
          get: (provider) => makeFakeProvider(provider === "gmail" ? google : legacy),
        }),
        Effect.void,
        (effect) => effect,
      );
      const result = yield* mailbox.emptyFolder({ mailbox: "trash" }, true).pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") assert.strictEqual(result.failure._tag, "PermanentError");
      assert.deepStrictEqual(google.deleted, []);
      assert.deepStrictEqual(legacy.deleted, []);
      assert.deepStrictEqual(google.folderPages, []);
      assert.deepStrictEqual(legacy.folderPages, []);
      assert.isTrue(yield* store.hasMessage(`${gmail.id}/g`));
      assert.isTrue(yield* store.hasMessage(`${imap.id}/i`));
    }).pipe(Effect.provide(StoreLive.pipe(Layer.provide(MemoryPlatform())))),
);

for (const provider of ["gmail", "outlook", "imap"] satisfies Provider[]) {
  it.effect(`${provider}: empty folder never deletes a message restored after the first page`, () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount(provider, `${provider}@example.com`);
      yield* store.setGrantedScopes(account.id, [GMAIL_PERMANENT_DELETE_SCOPE]);
      const server = fakeServer(
        account.email,
        Array.from({ length: 101 }, (_, i) => message(String(i).padStart(3, "0"), ["TRASH"])),
      );
      const fake = makeFakeProvider(server);
      let firstRemoval = true;
      const adapter = {
        ...fake,
        permanentlyDelete: (
          owner: Parameters<typeof fake.permanentlyDelete>[0],
          ids: readonly string[],
          folder: Parameters<typeof fake.permanentlyDelete>[2],
        ) =>
          Effect.sync(() => {
            if (firstRemoval) server.messages.set("100", message("100", ["INBOX"]));
            firstRemoval = false;
          }).pipe(Effect.andThen(fake.permanentlyDelete(owner, ids, folder))),
      };
      const mailbox = makeFolderMailbox(
        store,
        Providers.of({ get: () => adapter }),
        Effect.void,
        (effect) => effect,
      );
      assert.strictEqual(
        yield* mailbox.emptyFolder({ mailbox: "trash", accountIds: [account.id] }, true),
        100,
      );
      assert.isTrue(server.messages.has("100"));
      assert.isFalse(server.deleted.flat().includes("100"));
      assert.isTrue(server.folderPages.every((cursor) => cursor === null));
    }).pipe(Effect.provide(StoreLive.pipe(Layer.provide(MemoryPlatform())))),
  );
  it.effect(`${provider}: mark all read sends only unread messages`, () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount(provider, `${provider}@example.com`);
      const server = fakeServer(account.email, [message("unread"), message("read", ["INBOX"])]);
      const mailbox = makeFolderMailbox(
        store,
        Providers.of({ get: () => makeFakeProvider(server) }),
        Effect.void,
        (effect) => effect,
      );
      assert.strictEqual(
        yield* mailbox.markFolderRead({ mailbox: "inbox", accountIds: [account.id] }),
        1,
      );
      assert.deepStrictEqual(
        [
          ...server.pushed.map((p) => p.providerId),
          ...server.batches.flatMap((b) => b.providerIds),
        ],
        ["unread"],
      );
    }).pipe(Effect.provide(StoreLive.pipe(Layer.provide(MemoryPlatform())))),
  );
  it.effect(
    `${provider}: selected Trash conversation leaves live Inbox and Sent copies intact`,
    () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const account = yield* store.upsertAccount(provider, `${provider}@example.com`);
        yield* store.setGrantedScopes(account.id, [GMAIL_PERMANENT_DELETE_SCOPE]);
        const messages = [
          message("trash", ["TRASH"], "shared"),
          message("live", ["INBOX"], "shared"),
          message("sent", ["SENT"], "shared"),
        ];
        const server = fakeServer(account.email, messages);
        for (const incoming of messages) yield* store.upsertMessage(account.id, incoming);
        const mailbox = makeFolderMailbox(
          store,
          Providers.of({ get: () => makeFakeProvider(server) }),
          Effect.void,
          (effect) => effect,
        );
        assert.strictEqual(
          yield* mailbox.permanentlyDelete([`${account.id}/trash`], false, "trash", true),
          1,
        );
        assert.isTrue(server.messages.has("live"));
        assert.isTrue(server.messages.has("sent"));
        assert.isTrue(yield* store.hasMessage(`${account.id}/live`));
        assert.isTrue(yield* store.hasMessage(`${account.id}/sent`));
      }).pipe(Effect.provide(StoreLive.pipe(Layer.provide(MemoryPlatform())))),
  );
}

it.effect(
  "Gmail All Mail over 100k messages marks only the few unread without reaching the folder limit",
  () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount("gmail", "me@gmail.com");
      const server = fakeServer(account.email, [message("unread1"), message("unread2")]);
      const read = message("read", ["INBOX"]);
      for (let i = 0; i <= FOLDER_MESSAGE_LIMIT; i++)
        server.messages.set(`read${i}`, { ...read, providerId: `read${i}` });
      const fake = makeFakeProvider(server);
      let changes = 0;
      const mailbox = makeFolderMailbox(
        store,
        Providers.of({ get: () => fake }),
        Effect.sync(() => {
          changes++;
        }),
        (effect) => effect,
      );
      assert.strictEqual(
        yield* mailbox.markFolderRead({ mailbox: "all", accountIds: [account.id] }),
        2,
      );
      assert.deepStrictEqual(
        server.batches.map((batch) => batch.providerIds),
        [["unread1", "unread2"]],
      );
      assert.strictEqual(changes, 1);
    }).pipe(Effect.provide(StoreLive.pipe(Layer.provide(MemoryPlatform())))),
);

it.live("mark all read releases the shared sync lock and emits once per batch", () =>
  Effect.gen(function* () {
    const store = yield* Store;
    const account = yield* store.upsertAccount("outlook", "me@outlook.com");
    const server = fakeServer(
      account.email,
      Array.from({ length: 41 }, (_, i) => message(String(i).padStart(2, "0"))),
    );
    const fake = makeFakeProvider(server);
    const lock = yield* Semaphore.make(1);
    const probe = yield* Deferred.make<void>();
    const secondBatch = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let batches = 0;
    let changes = 0;
    const adapter = {
      ...fake,
      markReadBatch: (owner: Parameters<typeof fake.markReadBatch>[0], ids: readonly string[]) =>
        Effect.gen(function* () {
          if (++batches === 2) {
            yield* Deferred.succeed(secondBatch, undefined);
            yield* Deferred.await(release);
          }
          yield* fake.markReadBatch(owner, ids);
        }),
    };
    const changed = Effect.gen(function* () {
      if (++changes === 1) {
        yield* Effect.forkChild(lock.withPermits(1)(Deferred.succeed(probe, undefined)));
        yield* Effect.yieldNow;
      }
    });
    const mailbox = makeFolderMailbox(
      store,
      Providers.of({ get: () => adapter }),
      changed,
      (effect) => lock.withPermits(1)(effect),
    );
    const operation = yield* Effect.forkChild(
      mailbox.markFolderRead({ mailbox: "inbox", accountIds: [account.id] }),
    );
    yield* Deferred.await(secondBatch).pipe(Effect.timeout("2 seconds"));
    yield* Deferred.await(probe).pipe(Effect.timeout("2 seconds"));
    yield* Deferred.succeed(release, undefined);
    assert.strictEqual(yield* Fiber.join(operation), 41);
    assert.strictEqual(changes, 3);
    assert.deepStrictEqual(
      server.batches.map((batch) => batch.providerIds.length),
      [20, 20, 1],
    );
  }).pipe(Effect.provide(StoreLive.pipe(Layer.provide(MemoryPlatform())))),
);

for (const provider of ["gmail", "outlook", "imap"] satisfies Provider[]) {
  it.effect(
    `${provider}: folder actions reach uncached mail, preserve scope and require confirmation in a temporary DB`,
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.sync(() => mkdtempSync(join(tmpdir(), "openmail-folder-"))),
          (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
        );
        const server = fakeServer(`${provider}@example.com`, [
          message("loaded"),
          message("starred", ["INBOX", "STARRED"]),
          message("important", ["INBOX", "IMPORTANT"]),
          message("other", ["custom", "UNREAD"]),
          message("first", ["custom"], "shared"),
          message("second", ["custom"], "shared"),
          message("third", ["custom"], "shared"),
        ]);
        server.labels = [{ id: "custom", name: "Custom", color: null }];
        const adapter = makeFakeProvider(server, { batches: provider === "gmail" });
        const storeLayer = StoreLive.pipe(
          Layer.provide(databaseLayer(join(directory, "mail.db")).pipe(Layer.provide(NodeSystem))),
        );
        const providers = Providers.of({ get: () => adapter });
        const layer = MailboxLive({ backgroundFlush: false }).pipe(
          Layer.provide(Layer.merge(storeLayer, Layer.succeed(Providers, providers))),
          Layer.provide(MemoryPlatform()),
        );
        yield* Effect.gen(function* () {
          const mailbox = yield* Mailbox;
          const account = yield* mailbox.connect(
            provider === "imap"
              ? {
                  provider,
                  input: {
                    preset: "custom",
                    email: server.email,
                    password: "test",
                    imapHost: "imap.example.com",
                    smtpHost: "smtp.example.com",
                    smtpPort: 465,
                  },
                }
              : { provider },
          );
          yield* mailbox.sync();
          const folder = { mailbox: "inbox", accountIds: [account.id] } as const;
          const filters = {
            ...DEFAULT_LIST_FILTERS,
            enabled: true,
            unread: true,
            starred: true,
            important: true,
          };
          assert.strictEqual(
            (yield* mailbox.threads({ ...folder, listFilters: filters })).length,
            3,
          );
          assert.strictEqual(yield* mailbox.threadCount({ ...folder, listFilters: filters }), 3);
          assert.strictEqual(
            (yield* mailbox.threads({
              mailbox: "all",
              label: "custom",
              listFilters: { ...filters, inInbox: true },
            })).length,
            0,
          );
          assert.strictEqual(
            (yield* mailbox.threads({
              mailbox: "all",
              label: "custom",
              listFilters: { ...filters, enabled: false, inInbox: true },
            })).length,
            2,
          );
          assert.strictEqual(
            (yield* mailbox.threads({
              ...folder,
              listFilters: { ...DEFAULT_LIST_FILTERS, enabled: true, important: true },
            })).length,
            1,
          );
          const page = yield* mailbox.threads({ ...folder, listFilters: filters, limit: 1 });
          const first = page[0];
          assert.ok(first);
          assert.strictEqual(
            (yield* mailbox.threads({
              ...folder,
              listFilters: filters,
              before: first.date,
              beforeId: first.id,
            })).length,
            2,
          );
          for (let i = 0; i < 251; i++) server.messages.set(`remote${i}`, message(`remote${i}`));
          assert.strictEqual(yield* mailbox.markFolderRead(folder), 252);
          assert.isTrue(
            [...server.messages.values()]
              .filter((m) => m.labels.includes("INBOX"))
              .every((m) => !m.isUnread),
          );
          assert.isTrue(server.messages.get("other")?.isUnread);
          assert.isTrue(server.folderPages.length >= 3);
          assert.isTrue(server.batches.every((b) => b.providerIds.length <= 100));
          assert.strictEqual((yield* mailbox.threads({ ...folder, unreadOnly: true })).length, 0);
          assert.strictEqual(
            yield* mailbox.markFolderRead({
              mailbox: "all",
              label: "custom",
              accountIds: [account.id],
            }),
            1,
          );
          if (provider === "gmail") {
            server.messages.set(
              "categoryIn",
              message("categoryIn", ["INBOX", "CATEGORY_SOCIAL", "UNREAD"]),
            );
            server.messages.set(
              "categoryArchive",
              message("categoryArchive", ["CATEGORY_SOCIAL", "UNREAD"]),
            );
            server.messages.set(
              "categoryTrash",
              message("categoryTrash", ["TRASH", "CATEGORY_SOCIAL", "UNREAD"]),
            );
            const category = { accountIds: [account.id], label: "CATEGORY_SOCIAL" };
            assert.strictEqual(yield* mailbox.markFolderRead({ ...category, mailbox: "inbox" }), 1);
            assert.isTrue(server.messages.get("categoryArchive")?.isUnread);
            assert.strictEqual(yield* mailbox.markFolderRead({ ...category, mailbox: "all" }), 1);
            assert.isTrue(server.messages.get("categoryTrash")?.isUnread);
            server.messages.delete("categoryTrash");
          }
          const loaded = `${account.id}/loaded`;
          assert.isTrue(
            (yield* mailbox.permanentlyDelete([loaded], true, "trash", false).pipe(Effect.result))
              ._tag === "Failure",
          );
          assert.strictEqual(server.deleted.length, 0);
          if (provider === "gmail") {
            yield* mailbox.modifyWithUndo([loaded], { kind: "trash" }, true);
            const missing = yield* mailbox
              .permanentlyDelete([loaded], true, "trash", true)
              .pipe(Effect.result);
            assert.strictEqual(missing._tag, "Failure");
            if (missing._tag === "Failure")
              assert.strictEqual(missing.failure._tag, "FeatureScopeMissing");
            const empty = yield* mailbox
              .emptyFolder({ mailbox: "trash", accountIds: [account.id] }, true)
              .pipe(Effect.result);
            assert.strictEqual(empty._tag, "Failure");
            if (empty._tag === "Failure")
              assert.strictEqual(empty.failure._tag, "FeatureScopeMissing");
            assert.strictEqual(server.deleted.length, 0);
            assert.strictEqual((yield* mailbox.thread(loaded)).length, 1);
            assert.isFalse((yield* mailbox.accounts)[0]?.needsReauth);
            yield* mailbox.modifyWithUndo([loaded], { kind: "trash" }, true);
            assert.isTrue(server.messages.get("loaded")?.labels.includes("TRASH"));
            yield* mailbox.modifyWithUndo([loaded], { kind: "inbox" }, true);
            yield* mailbox.reauth(account.id, "permanentDelete");
            assert.deepStrictEqual(server.connects.at(-1), {
              provider: "gmail",
              loginHint: account.email,
              feature: "permanentDelete",
              grantedScopes: server.grantedScopes.filter(
                (scope) => scope !== GMAIL_PERMANENT_DELETE_SCOPE,
              ),
            });
          }
          assert.isTrue(
            (yield* mailbox
              .permanentlyDelete(
                Array.from({ length: 1001 }, () => loaded),
                true,
                "trash",
                true,
              )
              .pipe(Effect.result))._tag === "Failure",
          );
          assert.isTrue(
            (yield* mailbox.emptyFolder(folder, true).pipe(Effect.result))._tag === "Failure",
          );
          assert.isTrue(
            (yield* mailbox.emptyFolder({ mailbox: "trash" }, false).pipe(Effect.result))._tag ===
              "Failure",
          );
          yield* mailbox.modifyWithUndo([`${account.id}/first`], { kind: "trash" }, false);
          assert.strictEqual(
            yield* mailbox.permanentlyDelete([`${account.id}/first`], true, "trash", true),
            1,
          );
          assert.isTrue(server.messages.has("second"));
          assert.strictEqual(
            yield* mailbox.permanentlyDelete(
              [`${account.id}/second`, `${account.id}/second`],
              false,
              "trash",
              true,
            ),
            2,
          );
          assert.isFalse(server.messages.has("second"));
          assert.isFalse(server.messages.has("third"));
          for (const [mailboxName, label, count] of [
            ["trash", "TRASH", 203],
            ["spam", "SPAM", 107],
          ] as const) {
            for (let i = 0; i < count; i++)
              server.messages.set(`${label}${i}`, message(`${label}${i}`, [label]));
            assert.strictEqual(
              yield* mailbox.emptyFolder({ mailbox: mailboxName, accountIds: [account.id] }, true),
              count,
            );
            assert.isFalse([...server.messages.values()].some((m) => m.labels.includes(label)));
          }
          assert.isTrue(server.messages.has("other"));
          assert.isTrue(server.messages.has("loaded"));
          assert.isTrue(server.deleted.every((ids) => ids.length <= 100));
          if (provider === "imap") assert.isTrue(server.deleted.some((ids) => ids.length === 100));
          yield* mailbox.setLabelPreference({
            accountId: account.id,
            id: "custom",
            favorite: true,
            visible: false,
            position: 9,
            color: "#112233",
          });
          yield* mailbox.resetFavorites([account.id]);
          assert.deepStrictEqual((yield* mailbox.labelPreferences)[0], {
            accountId: account.id,
            id: "custom",
            favorite: false,
            visible: false,
            position: 9,
            color: "#112233",
          });
          yield* mailbox.setPrefs({ showMore: false });
          assert.isFalse((yield* mailbox.prefs).showMore);
          yield* mailbox.setPrefs({ showMore: true });
          assert.isTrue((yield* mailbox.prefs).showMore);
          const threads = yield* mailbox.threads({ mailbox: "all", limit: 1000 });
          assert.isFalse(threads.some((row) => ["first", "second"].includes(row.subject)));
        }).pipe(Effect.provide(layer));
      }),
  );
}

it.effect(
  "folder failures retain failed mail, flag missing authorization and reject repeated pages",
  () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount("gmail", "me@example.com");
      yield* store.setGrantedScopes(account.id, [GMAIL_PERMANENT_DELETE_SCOPE]);
      const server = fakeServer(account.email, [message("a", ["TRASH"]), message("b", ["TRASH"])]);
      yield* store.upsertMessage(account.id, message("a", ["TRASH"]));
      yield* store.upsertMessage(account.id, message("b", ["TRASH"]));
      const fake = makeFakeProvider(server);
      const providers = Providers.of({ get: () => fake });
      const mailbox = makeFolderMailbox(store, providers, Effect.void, (effect) => effect);
      server.failNext = new PermanentError({ message: "Delete failed" });
      assert.isTrue(
        (yield* mailbox
          .permanentlyDelete([`${account.id}/a`], true, "trash", true)
          .pipe(Effect.result))._tag === "Failure",
      );
      assert.isTrue(yield* store.hasMessage(`${account.id}/a`));
      server.failNext = new AuthError({ accountId: account.id, message: "Scope missing" });
      assert.isTrue(
        (yield* mailbox.markFolderRead({ mailbox: "inbox" }).pipe(Effect.result))._tag ===
          "Failure",
      );
      assert.isTrue((yield* store.getAccount(account.id)).needsReauth);
      const repeated = makeFolderMailbox(
        store,
        Providers.of({
          get: () => ({
            ...fake,
            listFolderMessages: () => Effect.succeed({ ids: ["a"], next: "same" }),
          }),
        }),
        Effect.void,
        (effect) => effect,
      );
      assert.isTrue(
        (yield* repeated.emptyFolder({ mailbox: "trash" }, true).pipe(Effect.result))._tag ===
          "Failure",
      );
      assert.strictEqual(server.deleted.length, 1);
    }).pipe(Effect.provide(StoreLive.pipe(Layer.provide(MemoryPlatform())))),
);

it.effect("folder actions preserve other accounts and successful partial deletions", () =>
  Effect.gen(function* () {
    const store = yield* Store;
    const account = yield* store.upsertAccount("outlook", "me@outlook.com");
    const other = yield* store.upsertAccount("gmail", "other@gmail.com");
    const server = fakeServer(account.email, [message("a", ["TRASH"]), message("b", ["TRASH"])]);
    const foreign = fakeServer(other.email, [message("a", ["TRASH", "UNREAD"])]);
    for (const incoming of server.messages.values())
      yield* store.upsertMessage(account.id, incoming);
    yield* store.upsertMessage(other.id, message("a", ["TRASH", "UNREAD"]));
    const fake = makeFakeProvider(server);
    const providers = Providers.of({
      get: (provider) =>
        provider === "outlook"
          ? {
              ...fake,
              permanentlyDelete: (owner, ids, folder) =>
                fake
                  .permanentlyDelete(
                    owner,
                    ids.filter((id) => id !== "b"),
                    folder,
                  )
                  .pipe(
                    Effect.map((result) =>
                      ids.includes("b")
                        ? {
                            kind: "partial" as const,
                            ids: result.ids,
                            error: new PermanentError({ message: "Second deletion failed" }),
                          }
                        : result,
                    ),
                  ),
            }
          : makeFakeProvider(foreign),
    });
    const mailbox = makeFolderMailbox(store, providers, Effect.void, (effect) => effect);
    const folder = { mailbox: "trash", accountIds: [account.id] } as const;
    assert.strictEqual(
      (yield* mailbox.emptyFolder(folder, true).pipe(Effect.result))._tag,
      "Failure",
    );
    assert.isFalse(yield* store.hasMessage(`${account.id}/a`));
    assert.isTrue(yield* store.hasMessage(`${account.id}/b`));
    assert.isFalse(server.messages.has("a"));
    assert.isTrue(server.messages.has("b"));
    assert.isTrue(yield* store.hasMessage(`${other.id}/a`));
    assert.deepStrictEqual(foreign.deleted, []);
    assert.deepStrictEqual(foreign.folderPages, []);
    yield* store.setLabelPreference({
      accountId: account.id,
      id: "custom",
      favorite: true,
      visible: true,
      color: null,
    });
    yield* store.setLabelPreference({
      accountId: other.id,
      id: "custom",
      favorite: true,
      visible: true,
      color: null,
    });
    yield* mailbox.resetFavorites([account.id]);
    assert.isTrue(
      (yield* store.labelPreferences).some((p) => p.accountId === other.id && p.favorite),
    );
    yield* store.enqueueOp(account.id, "b", { kind: "read", value: true });
    const pages = server.folderPages.length;
    assert.strictEqual((yield* mailbox.markFolderRead(folder).pipe(Effect.result))._tag, "Failure");
    assert.strictEqual(server.folderPages.length, pages);
  }).pipe(Effect.provide(StoreLive.pipe(Layer.provide(MemoryPlatform())))),
);

it.effect("folder limits and failed enumeration stop before any mutation", () =>
  Effect.gen(function* () {
    const store = yield* Store;
    const account = yield* store.upsertAccount("gmail", "me@gmail.com");
    yield* store.setGrantedScopes(account.id, [GMAIL_PERMANENT_DELETE_SCOPE]);
    const server = fakeServer(account.email, [message("a", ["TRASH"])]);
    const fake = makeFakeProvider(server);
    const folder = { mailbox: "trash", accountIds: [account.id] } as const;
    const oversized = makeFolderMailbox(
      store,
      Providers.of({
        get: () => ({
          ...fake,
          listFolderMessages: () =>
            Effect.succeed({
              ids: Array.from({ length: FOLDER_MESSAGE_LIMIT + 1 }, (_, i) => String(i)),
              next: null,
            }),
        }),
      }),
      Effect.void,
      (effect) => effect,
    );
    assert.strictEqual(
      (yield* oversized.emptyFolder(folder, true).pipe(Effect.result))._tag,
      "Failure",
    );
    const incomplete = makeFolderMailbox(
      store,
      Providers.of({
        get: () => ({
          ...fake,
          listFolderMessages: (_owner, _folder, cursor) =>
            cursor === null
              ? Effect.succeed({ ids: ["a"], next: "second" })
              : Effect.fail(new PermanentError({ message: "Page failed" })),
        }),
      }),
      Effect.void,
      (effect) => effect,
    );
    assert.strictEqual(
      (yield* incomplete.emptyFolder(folder, true).pipe(Effect.result))._tag,
      "Failure",
    );
    assert.strictEqual(
      (yield* incomplete.markFolderRead(folder).pipe(Effect.result))._tag,
      "Failure",
    );
    assert.deepStrictEqual(server.deleted, [["a"]]);
    assert.deepStrictEqual(server.pushed, []);
    assert.deepStrictEqual(server.batches, []);
    assert.isFalse(server.messages.has("a"));
  }).pipe(Effect.provide(StoreLive.pipe(Layer.provide(MemoryPlatform())))),
);

it.effect(
  "a missing Gmail grant prevents every account in a selected batch from being deleted",
  () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const gmail = yield* store.upsertAccount("gmail", "me@gmail.com");
      const outlook = yield* store.upsertAccount("outlook", "me@outlook.com");
      const google = fakeServer(gmail.email, [message("g", ["TRASH"])]);
      const microsoft = fakeServer(outlook.email, [message("o", ["TRASH"])]);
      yield* store.upsertMessage(gmail.id, message("g", ["TRASH"]));
      yield* store.upsertMessage(outlook.id, message("o", ["TRASH"]));
      const mailbox = makeFolderMailbox(
        store,
        Providers.of({
          get: (provider) => makeFakeProvider(provider === "gmail" ? google : microsoft),
        }),
        Effect.void,
        (effect) => effect,
      );
      const result = yield* mailbox
        .permanentlyDelete([`${outlook.id}/o`, `${gmail.id}/g`], true, "trash", true)
        .pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") assert.strictEqual(result.failure._tag, "FeatureScopeMissing");
      assert.deepStrictEqual(google.deleted, []);
      assert.deepStrictEqual(microsoft.deleted, []);
      assert.isTrue(yield* store.hasMessage(`${outlook.id}/o`));
      assert.isTrue(yield* store.hasMessage(`${gmail.id}/g`));
    }).pipe(Effect.provide(StoreLive.pipe(Layer.provide(MemoryPlatform())))),
);

it.effect(
  "declining the incremental grant keeps mail usable and does not record permanent deletion permission",
  () => {
    const server = fakeServer("me@gmail.com", [message("a")]);
    const fake = makeFakeProvider(server);
    const providers = Layer.succeed(
      Providers,
      Providers.of({
        get: () => ({
          ...fake,
          connect: (input) =>
            fake.connect(input).pipe(
              Effect.map((connected) => ({
                ...connected,
                scopes: ["https://www.googleapis.com/auth/gmail.modify"],
              })),
            ),
        }),
      }),
    );
    const layer = MailboxLive({ backgroundFlush: false }).pipe(
      Layer.provideMerge(StoreLive),
      Layer.provide(providers),
      Layer.provide(MemoryPlatform()),
    );
    return Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const store = yield* Store;
      const account = yield* mailbox.connect({ provider: "gmail" });
      yield* mailbox.sync();
      const result = yield* mailbox.reauth(account.id, "permanentDelete").pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") assert.strictEqual(result.failure._tag, "FeatureScopeMissing");
      assert.isFalse(
        (yield* store.grantedScopes(account.id)).includes(GMAIL_PERMANENT_DELETE_SCOPE),
      );
      assert.isFalse((yield* store.getAccount(account.id)).needsReauth);
      assert.isTrue(yield* store.hasMessage(`${account.id}/a`));
      assert.deepStrictEqual(server.deleted, []);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "Outlook cached child-folder labels inside Deleted Items remain eligible without admitting restored Inbox copies",
  () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount("outlook", "me@outlook.com");
      const server = fakeServer(account.email, [
        message("child", ["child-folder"]),
        message("inbox", ["INBOX"]),
      ]);
      server.deleteFolderLabels.trash = ["TRASH", "child-folder"];
      for (const incoming of server.messages.values())
        yield* store.upsertMessage(account.id, incoming);
      const mailbox = makeFolderMailbox(
        store,
        Providers.of({ get: () => makeFakeProvider(server) }),
        Effect.void,
        (effect) => effect,
      );
      assert.strictEqual(
        yield* mailbox.emptyFolder({ mailbox: "trash", accountIds: [account.id] }, true),
        1,
      );
      assert.isFalse(yield* store.hasMessage(`${account.id}/child`));
      assert.isTrue(yield* store.hasMessage(`${account.id}/inbox`));
      assert.isTrue(server.messages.has("inbox"));
    }).pipe(Effect.provide(StoreLive.pipe(Layer.provide(MemoryPlatform())))),
);

for (const reconcile of [false, true])
  it.effect(`folder mark-read uses remapped IDs, reconcile=${reconcile}`, () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount("outlook", "me@example.com");
      const server = fakeServer(account.email, [message("new", ["TRASH", "UNREAD"])]);
      yield* store.upsertMessage(account.id, message("old", ["TRASH", "UNREAD"]));
      yield* store.remapProviderIds(account.id, [{ from: "old", to: "new" }]);
      if (reconcile) yield* store.enqueueOp(account.id, "unrelated", { kind: "reconcile" });
      const mailbox = makeFolderMailbox(
        store,
        Providers.of({ get: () => makeFakeProvider(server) }),
        Effect.void,
        (effect) => effect,
      );
      assert.strictEqual(yield* mailbox.markFolderRead({ mailbox: "trash" }), 1);
      assert.isFalse((yield* store.getMessage(`${account.id}/old`)).isUnread);
    }).pipe(Effect.provide(StoreLive.pipe(Layer.provide(MemoryPlatform())))),
  );

it.effect("empty-folder checks remapped local location before deleting", () =>
  Effect.gen(function* () {
    const store = yield* Store;
    const account = yield* store.upsertAccount("outlook", "me@example.com");
    const server = fakeServer(account.email, [message("new", ["TRASH"])]);
    yield* store.upsertMessage(account.id, message("old", ["INBOX"]));
    yield* store.remapProviderIds(account.id, [{ from: "old", to: "new" }]);
    const fake = makeFakeProvider(server);
    let pages = 0;
    const mailbox = makeFolderMailbox(
      store,
      Providers.of({
        get: () => ({
          ...fake,
          listFolderMessages: (...args) =>
            Effect.suspend(() =>
              pages++ === 0
                ? fake.listFolderMessages(...args)
                : Effect.succeed({ ids: [], next: null }),
            ),
        }),
      }),
      Effect.void,
      (effect) => effect,
    );
    assert.strictEqual(yield* mailbox.emptyFolder({ mailbox: "trash" }, true), 0);
    assert.deepStrictEqual(server.deleted, []);
  }).pipe(Effect.provide(StoreLive.pipe(Layer.provide(MemoryPlatform())))),
);

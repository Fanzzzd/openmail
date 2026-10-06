import { applyNativeMigration } from "./platform/node/migrations.js";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, Schema, Stream } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { databaseLayer, MIGRATIONS } from "./platform/node/db.js";
import { AccountSettings, DEFAULT_PREFS, accountName, type IncomingMessage } from "./domain.js";
import { fakeServer, makeFakeProvider } from "./platform/node/fake-provider.js";
import { MailboxLive } from "./mailbox-live.js";
import { Mailbox } from "./mailbox.js";
import { MemoryPlatform } from "./platform/node/platform-memory.js";
import { NodeSystem } from "./platform/node/platform-node.js";
import { Providers, Secrets, Store } from "./services.js";
import { StoreLive } from "./store.js";
import { notificationAction, spaceAccountIds, dockUnreadCount } from "./system.js";
import { TestMailbox } from "./platform/node/testing.js";
import { TestClock } from "effect/testing";
import { ProviderError } from "./errors.js";
const incoming = (id: string): IncomingMessage => ({
  providerId: id,
  threadId: id,
  subject: id,
  date: 1000,
  from: { name: "Alice", address: "alice@example.com" },
  to: [],
  cc: [],
  bodyText: "cached body",
  bodyHtml: "",
  snippet: "cached body",
  attachments: [],
  labels: ["INBOX", "UNREAD"],
  isUnread: true,
  isStarred: false,
});
for (const provider of ["gmail", "outlook", "imap"] as const) {
  it.effect(
    `${provider}: disable survives restart, preserves cache/token and suspends all sync paths`,
    () =>
      Effect.gen(function* () {
        const directory = mkdtempSync(join(tmpdir(), "openmail-accounts-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
        );
        const server = fakeServer(`${provider}@example.com`, [incoming("initial")]);
        server.contacts = [{ name: "Contact", address: "contact@example.com" }];
        const adapter = makeFakeProvider(server);
        const tokens = new Map<string, string>();
        const secrets = Layer.succeed(Secrets, {
          get: (id) => Effect.succeed(Option.fromUndefinedOr(tokens.get(id))),
          set: (id, value) =>
            Effect.sync(() => {
              tokens.set(id, value);
            }),
          remove: (id) =>
            Effect.sync(() => {
              tokens.delete(id);
            }),
        });
        const layer = () =>
          MailboxLive({ backgroundFlush: false }).pipe(
            Layer.provideMerge(
              Layer.merge(StoreLive, Layer.succeed(Providers, { get: () => adapter })).pipe(
                Layer.provideMerge(
                  Layer.mergeAll(
                    MemoryPlatform(),
                    secrets,
                    databaseLayer(join(directory, "mail.db"), { vectorExtension: null }).pipe(
                      Layer.provide(NodeSystem),
                    ),
                  ),
                ),
              ),
            ),
          );
        let id = "";
        let token = "";
        yield* Effect.gen(function* () {
          const mailbox = yield* Mailbox;
          const store = yield* Store;
          const account = yield* mailbox.connect(
            provider === "imap"
              ? { provider, input: { preset: "qq", email: server.email, password: "fake" } }
              : { provider },
          );
          id = account.id;
          yield* mailbox.sync();
          token = tokens.get(id) ?? "";
          assert.ok(token);
          server.messages.set("arrival", incoming("arrival"));
          yield* mailbox.sync();
          yield* store.enqueueOp(id, "initial", { kind: "read", value: true });
          yield* mailbox.setPrefs({
            showAccountLabels: true,
            notificationActions: ["menu", "read"],
          });
          yield* mailbox.rememberNotificationActions(`${id}/initial`, ["read"]);
          yield* mailbox.setAccountSettings(id, {
            enabled: false,
            description: "Personal",
            color: "#123456",
          });
          const failure = new ProviderError({ message: "must remain unused" });
          server.failNext = failure;
          server.messages.set("while-disabled", incoming("while-disabled"));
          assert.deepStrictEqual(yield* mailbox.sync(), []);
          assert.deepStrictEqual(yield* mailbox.sync(id), []);
          assert.deepStrictEqual(yield* mailbox.pollInbox(), []);
          yield* mailbox.fetchOlder({ accountIds: [id] });
          yield* mailbox.refreshContacts(id);
          assert.deepStrictEqual((yield* mailbox.searchServer({ search: "Alice" })).threads, []);
          assert.strictEqual(server.failNext, failure);
          server.failNext = undefined;
          assert.deepStrictEqual(yield* mailbox.threads({ mailbox: "all", accountIds: [id] }), []);
          assert.deepStrictEqual(yield* mailbox.unreadCounts, {});
          assert.deepStrictEqual(yield* mailbox.unreadByLabel(), {});
          assert.deepStrictEqual(yield* mailbox.takeNotifications, []);
          assert.deepStrictEqual(yield* mailbox.suggestContacts("alice"), []);
          assert.deepStrictEqual(yield* mailbox.suggestContacts("contact"), []);
          assert.strictEqual((yield* store.listPendingOps).length, 1);
          assert.strictEqual((yield* mailbox.thread(`${id}/initial`))[0]?.bodyText, "cached body");
          assert.strictEqual(tokens.get(id), token);
          const accounts = yield* mailbox.accounts;
          assert.strictEqual(accountName(accounts[0]!), "Personal");
          assert.deepStrictEqual(spaceAccountIds("all", accounts), []);
          assert.strictEqual(
            dockUnreadCount("all", accounts, { [id]: 9 }, DEFAULT_PREFS, new Date()),
            0,
          );
          assert.deepStrictEqual(server.backfillFetched, []);
        }).pipe(Effect.provide(layer()));
        yield* Effect.gen(function* () {
          const mailbox = yield* Mailbox;
          const store = yield* Store;
          const account = (yield* mailbox.accounts)[0]!;
          assert.strictEqual(account.enabled, false);
          assert.strictEqual(account.description, "Personal");
          assert.strictEqual(account.color, "#123456");
          assert.strictEqual(tokens.get(id), token);
          assert.deepStrictEqual(yield* mailbox.notificationActions(`${id}/initial`), ["read"]);
          assert.isTrue((yield* mailbox.prefs).showAccountLabels);
          assert.deepStrictEqual((yield* mailbox.prefs).notificationActions, ["menu", "read"]);
          yield* mailbox.setAccountSettings(id, {
            enabled: true,
            description: "Personal",
            color: null,
          });
          yield* mailbox.sync(id);
          assert.strictEqual((yield* store.listPendingOps).length, 0);
          assert.ok(
            (yield* mailbox.threads({ mailbox: "all" })).some(
              (m) => m.id === `${id}/while-disabled`,
            ),
          );
          assert.strictEqual(tokens.get(id), token);
          assert.deepStrictEqual((yield* mailbox.accounts)[0]?.color, null);
        }).pipe(Effect.provide(layer()));
      }).pipe(Effect.scoped),
  );
}

it.effect(
  "migration 18 preserves legacy order; account moves are atomic, validated and persist",
  () =>
    Effect.gen(function* () {
      const directory = mkdtempSync(join(tmpdir(), "openmail-account-order-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
      );
      const filename = join(directory, "mail.db");
      const db = new DatabaseSync(filename);
      for (const migration of MIGRATIONS.slice(0, 17)) applyNativeMigration(db, migration);
      db.exec("PRAGMA user_version=17");
      db.prepare("INSERT INTO accounts(id,provider,email,created_at) VALUES(?,?,?,?)").run(
        "gmail:a",
        "gmail",
        "a@example.com",
        1,
      );
      db.prepare("INSERT INTO accounts(id,provider,email,created_at) VALUES(?,?,?,?)").run(
        "gmail:b",
        "gmail",
        "b@example.com",
        2,
      );
      db.close();
      const layer = () =>
        StoreLive.pipe(
          Layer.provide(
            databaseLayer(filename, { vectorExtension: null }).pipe(Layer.provide(NodeSystem)),
          ),
        );
      let profile = "";
      yield* Effect.gen(function* () {
        const store = yield* Store;
        assert.deepStrictEqual(
          (yield* store.listAccounts).map((a) => a.id),
          ["gmail:a", "gmail:b"],
        );
        assert.strictEqual((yield* store.listAccounts)[0]?.enabled, true);
        const c = yield* store.upsertAccount("outlook", "c@example.com");
        profile = (yield* store.createProfile({ name: "Work", icon: "W", color: "blue" })).id;
        yield* store.moveAccount("gmail:b", { profileId: profile, beforeId: null });
        yield* store.moveAccount(c.id, { profileId: profile, beforeId: "gmail:b" });
        assert.deepStrictEqual(
          (yield* store.listAccounts).filter((a) => a.profileId === profile).map((a) => a.id),
          [c.id, "gmail:b"],
        );
        const before = yield* store.listAccounts;
        assert.strictEqual(
          (yield* store
            .moveAccount("gmail:a", { profileId: profile, beforeId: "gmail:a" })
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.strictEqual(
          (yield* store
            .moveAccount("gmail:a", { profileId: "missing", beforeId: null })
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.deepStrictEqual(yield* store.listAccounts, before);
        yield* store.moveAccount("gmail:b", { profileId: null, beforeId: "gmail:a" });
      }).pipe(Effect.provide(layer()));
      yield* Effect.gen(function* () {
        const store = yield* Store;
        assert.deepStrictEqual(
          (yield* store.listAccounts).filter((a) => !a.profileId).map((a) => a.id),
          ["gmail:b", "gmail:a"],
        );
        assert.strictEqual(
          (yield* store.listAccounts).find((a) => a.email === "c@example.com")?.profileId,
          profile,
        );
      }).pipe(Effect.provide(layer()));
    }).pipe(Effect.scoped),
);

it("validates account colours and resolves direct and menu notification actions", () => {
  assert.isTrue(
    Option.isNone(
      Schema.decodeUnknownOption(AccountSettings)({
        enabled: true,
        description: "Work",
        color: "url(https://remote.test)",
      }),
    ),
  );
  assert.deepStrictEqual(notificationAction(["read", "trash"], 0), { kind: "read", value: true });
  assert.deepStrictEqual(notificationAction(["read", "trash"], 1), { kind: "trash" });
  assert.deepStrictEqual(notificationAction(["menu"], 0, 0), { kind: "archive" });
  assert.deepStrictEqual(notificationAction(["menu"], 0, 1), { kind: "trash" });
  assert.deepStrictEqual(notificationAction(["menu"], 0, 2), { kind: "read", value: true });
  assert.strictEqual(notificationAction(["menu"], 0, 9), null);
  assert.strictEqual(notificationAction([], 0), null);
});

it.effect(
  "disabling sets the flag during an in-flight push and skips remaining queued writes",
  () => {
    const server = fakeServer("me@example.com", [incoming("initial"), incoming("second")]);
    return Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const account = yield* mailbox.connect({ provider: "gmail" });
      yield* mailbox.sync();
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      server.beforePush = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const writing = yield* mailbox
        .perform(
          {
            kind: "modify",
            threads: [`${account.id}/initial`, `${account.id}/second`],
            op: { kind: "read", value: true },
          },
          { kind: "user", surface: "app" },
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const disabling = yield* mailbox
        .setAccountSettings(account.id, { enabled: false, description: "", color: null })
        .pipe(Effect.timeout("1 second"), Effect.forkChild);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(disabling);
      assert.strictEqual((yield* mailbox.accounts)[0]?.enabled, false);
      assert.strictEqual(writing.pollUnsafe(), undefined);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(writing);
      assert.strictEqual(server.pushed.length, 1);
      assert.deepStrictEqual(yield* mailbox.sync(), []);
      yield* mailbox.setAccountSettings(account.id, {
        enabled: true,
        description: "",
        color: null,
      });
      yield* mailbox.sync();
      assert.strictEqual(server.pushed.length, 2);
    }).pipe(Effect.provide(TestMailbox({ gmail: server })));
  },
);

it.effect(
  "name, colour and enabled changes never wait for a hung pull; disabled batches preserve the cache",
  () =>
    Effect.gen(function* () {
      const server = fakeServer("me@example.com", [incoming("initial")]);
      const base = makeFakeProvider(server);
      let stall = false;
      let aliases = 0;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const provider = {
        ...base,
        pull: (
          a: Parameters<typeof base.pull>[0],
          c: Parameters<typeof base.pull>[1],
          scope?: "inbox",
        ) =>
          stall
            ? Stream.fromEffect(
                Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
              ).pipe(Stream.flatMap(() => base.pull(a, c, scope)))
            : base.pull(a, c, scope),
        sendAs: (a: Parameters<typeof base.sendAs>[0]) =>
          Effect.sync(() => aliases++).pipe(Effect.andThen(base.sendAs(a))),
      };
      const layer = TestMailbox.withAdapter(provider, {
        options: { backgroundFlush: false },
        platformOptions: {},
      });
      yield* Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const store = yield* Store;
        const account = yield* mailbox.connect({ provider: "gmail" });
        yield* mailbox.sync();
        const beforeAliases = aliases;
        stall = true;
        server.messages.set("late", incoming("late"));
        const syncing = yield* mailbox.sync().pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const edit = yield* mailbox
          .setAccountSettings(account.id, {
            enabled: true,
            description: "Renamed",
            color: "#abcdef",
          })
          .pipe(Effect.timeout("1 second"), Effect.forkChild);
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(edit);
        assert.strictEqual((yield* store.getAccount(account.id)).description, "Renamed");
        assert.strictEqual((yield* store.getAccount(account.id)).color, "#abcdef");
        assert.strictEqual(syncing.pollUnsafe(), undefined);
        const disabling = yield* mailbox
          .setAccountSettings(account.id, {
            enabled: false,
            description: "Renamed",
            color: "#abcdef",
          })
          .pipe(Effect.timeout("1 second"), Effect.forkChild);
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(disabling);
        assert.strictEqual((yield* store.getAccount(account.id)).enabled, false);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(syncing);
        assert.strictEqual(aliases, beforeAliases);
        assert.isFalse(yield* store.hasMessage(`${account.id}/late`));
        assert.strictEqual(
          (yield* mailbox.thread(`${account.id}/initial`))[0]?.bodyText,
          "cached body",
        );
        assert.deepStrictEqual(yield* mailbox.takeNotifications, []);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect(
  "two simultaneous account moves compose their order instead of overwriting a snapshot",
  () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const accounts = yield* Effect.forEach(["a", "b", "c", "d"], (name) =>
        store.upsertAccount("gmail", `${name}@example.com`),
      );
      const [a, b, c, d] = accounts;
      assert.ok(a && b && c && d);
      yield* Effect.all(
        [
          store.moveAccount(c.id, { profileId: null, beforeId: a.id }),
          store.moveAccount(b.id, { profileId: null, beforeId: c.id }),
        ],
        { concurrency: 2 },
      );
      assert.deepStrictEqual(
        (yield* store.listAccounts).map((account) => account.id),
        [b.id, c.id, a.id, d.id],
      );
    }).pipe(Effect.provide(StoreLive.pipe(Layer.provide(MemoryPlatform())))),
);

it.effect(
  "IMAP authserv trust is explicit, survives settings saves, and clears cached results when changed",
  () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount("imap", "me@fastmail.com");
      yield* store.setImapSettings(account.id, {
        preset: "fastmail",
        username: account.email,
        imapHost: "imap.fastmail.com",
        imapPort: 993,
        smtpHost: "smtp.fastmail.com",
        smtpPort: 465,
        smtpSecure: true,
      });
      assert.strictEqual((yield* store.getAccount(account.id)).imap?.authservId, undefined);
      const settings = { enabled: true, description: "Fastmail", color: null };
      yield* store.setAccountSettings(account.id, {
        ...settings,
        imapAuthservId: "mx1.messagingengine.com",
      });
      assert.strictEqual(
        (yield* store.getAccount(account.id)).imap?.authservId,
        "mx1.messagingengine.com",
      );
      const messageId = `${account.id}/m1`;
      yield* store.upsertMessage(account.id, {
        ...incoming("m1"),
        security: { dmarc: "pass", spf: "pass", dkim: "pass" },
      });
      yield* store.setAccountSettings(account.id, settings);
      assert.strictEqual(
        (yield* store.getAccount(account.id)).imap?.authservId,
        "mx1.messagingengine.com",
      );
      assert.strictEqual((yield* store.getMessage(messageId)).security?.dmarc, "pass");
      yield* store.setAccountSettings(account.id, {
        ...settings,
        imapAuthservId: "mx1.messagingengine.com",
      });
      assert.strictEqual((yield* store.getMessage(messageId)).security?.dmarc, "pass");
      yield* store.setAccountSettings(account.id, { ...settings, imapAuthservId: null });
      assert.strictEqual((yield* store.getMessage(messageId)).security, undefined);
      assert.strictEqual((yield* store.getAccount(account.id)).imap?.authservId, null);
      assert.strictEqual(
        Schema.decodeUnknownOption(AccountSettings)({
          ...settings,
          imapAuthservId: "mx.google.com; dmarc=pass",
        })._tag,
        "None",
      );
    }).pipe(Effect.provide(StoreLive.pipe(Layer.provide(MemoryPlatform())))),
);

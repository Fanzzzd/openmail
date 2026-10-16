import { applyNativeMigration } from "../platform/node/migrations.js";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, Result, Schema, Stream } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { databaseLayer, MIGRATIONS } from "../platform/node/db.js";
import {
  AccountSettings,
  PROFILE_NAME_ERRORS,
  ProfileInput,
  accountName,
} from "../domain/account.js";
import { DEFAULT_PREFS } from "../domain/prefs.js";
import type { IncomingMessage } from "../domain/message.js";
import { fakeServer, makeFakeProvider } from "../platform/node/fake-provider.js";
import { MailboxLive } from "./mailbox-live.js";
import { Mailbox } from "./mailbox.js";
import { MemoryPlatform } from "../platform/node/platform-memory.js";
import { NodeSystem } from "../platform/node/platform-node.js";
import { Providers } from "../providers/adapter.js";
import { Secrets } from "../platform/auth.js";
import { Store } from "../store/service.js";
import { StoreLive } from "../store/store.js";
import { notificationAction, spaceAccountIds, dockUnreadCount } from "../app/system.js";
import { TestMailbox } from "../platform/node/testing.js";
import { TestClock } from "effect/testing";
import { InvalidInput, ProviderError } from "../domain/errors.js";
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
          const account = yield* mailbox.accounts.connect(
            provider === "imap"
              ? { provider, input: { preset: "qq", email: server.email, password: "fake" } }
              : { provider },
          );
          id = account.id;
          yield* mailbox.sync.sync();
          token = tokens.get(id) ?? "";
          assert.ok(token);
          server.messages.set("arrival", incoming("arrival"));
          yield* mailbox.sync.sync();
          yield* store.enqueueOp(id, "initial", { kind: "read", value: true });
          yield* mailbox.app.setPrefs({
            showAccountLabels: true,
            notificationActions: ["menu", "read"],
          });
          yield* mailbox.app.rememberNotificationActions(`${id}/initial`, ["read"]);
          yield* mailbox.accounts.setAccountSettings(id, {
            enabled: false,
            description: "Personal",
            color: "#123456",
          });
          const failure = new ProviderError({ message: "must remain unused" });
          server.failNext = failure;
          server.messages.set("while-disabled", incoming("while-disabled"));
          assert.deepStrictEqual(yield* mailbox.sync.sync(), []);
          assert.deepStrictEqual(yield* mailbox.sync.sync(id), []);
          assert.deepStrictEqual(yield* mailbox.sync.pollInbox(), []);
          yield* mailbox.sync.fetchOlder({ accountIds: [id] });
          yield* mailbox.contacts.refreshContacts(id);
          assert.deepStrictEqual(
            (yield* mailbox.reading.searchServer({ search: "Alice" })).threads,
            [],
          );
          assert.strictEqual(server.failNext, failure);
          server.failNext = undefined;
          assert.deepStrictEqual(
            yield* mailbox.reading.threads({ mailbox: "all", accountIds: [id] }),
            [],
          );
          assert.deepStrictEqual(yield* mailbox.reading.unreadCounts, {});
          assert.deepStrictEqual(yield* mailbox.reading.unreadByLabel(), {});
          assert.deepStrictEqual(yield* mailbox.app.takeNotifications, []);
          assert.deepStrictEqual(yield* mailbox.contacts.suggestContacts("alice"), []);
          assert.deepStrictEqual(yield* mailbox.contacts.suggestContacts("contact"), []);
          assert.strictEqual((yield* store.listPendingOps).length, 1);
          assert.strictEqual(
            (yield* mailbox.reading.thread(`${id}/initial`))[0]?.bodyText,
            "cached body",
          );
          assert.strictEqual(tokens.get(id), token);
          const accounts = yield* mailbox.accounts.accounts;
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
          const account = (yield* mailbox.accounts.accounts)[0]!;
          assert.strictEqual(account.enabled, false);
          assert.strictEqual(account.description, "Personal");
          assert.strictEqual(account.color, "#123456");
          assert.strictEqual(tokens.get(id), token);
          assert.deepStrictEqual(yield* mailbox.app.notificationActions(`${id}/initial`), ["read"]);
          assert.isTrue((yield* mailbox.app.prefs).showAccountLabels);
          assert.deepStrictEqual((yield* mailbox.app.prefs).notificationActions, ["menu", "read"]);
          yield* mailbox.accounts.setAccountSettings(id, {
            enabled: true,
            description: "Personal",
            color: null,
          });
          yield* mailbox.sync.sync(id);
          assert.strictEqual((yield* store.listPendingOps).length, 0);
          assert.ok(
            (yield* mailbox.reading.threads({ mailbox: "all" })).some(
              (m) => m.id === `${id}/while-disabled`,
            ),
          );
          assert.strictEqual(tokens.get(id), token);
          assert.deepStrictEqual((yield* mailbox.accounts.accounts)[0]?.color, null);
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
      const account = yield* mailbox.accounts.connect({ provider: "gmail" });
      yield* mailbox.sync.sync();
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      server.beforePush = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const writing = yield* mailbox.organize
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
      const disabling = yield* mailbox.accounts
        .setAccountSettings(account.id, { enabled: false, description: "", color: null })
        .pipe(Effect.timeout("1 second"), Effect.forkChild);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(disabling);
      assert.strictEqual((yield* mailbox.accounts.accounts)[0]?.enabled, false);
      assert.strictEqual(writing.pollUnsafe(), undefined);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(writing);
      assert.strictEqual(server.pushed.length, 1);
      assert.deepStrictEqual(yield* mailbox.sync.sync(), []);
      yield* mailbox.accounts.setAccountSettings(account.id, {
        enabled: true,
        description: "",
        color: null,
      });
      yield* mailbox.sync.sync();
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
        const account = yield* mailbox.accounts.connect({ provider: "gmail" });
        yield* mailbox.sync.sync();
        const beforeAliases = aliases;
        stall = true;
        server.messages.set("late", incoming("late"));
        const syncing = yield* mailbox.sync.sync().pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const edit = yield* mailbox.accounts
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
        const disabling = yield* mailbox.accounts
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
          (yield* mailbox.reading.thread(`${account.id}/initial`))[0]?.bodyText,
          "cached body",
        );
        assert.deepStrictEqual(yield* mailbox.app.takeNotifications, []);
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

it.effect(
  "an IMAP sender name is saved from settings, kept across saves, and cleared when blank",
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
        senderName: "Me",
      });
      const settings = { enabled: true, description: "Fastmail", color: null };
      yield* store.setAccountSettings(account.id, { ...settings, imapSenderName: "  Jane   Doe " });
      assert.strictEqual((yield* store.getAccount(account.id)).imap?.senderName, "Jane Doe");
      yield* store.setAccountSettings(account.id, settings);
      assert.strictEqual((yield* store.getAccount(account.id)).imap?.senderName, "Jane Doe");
      yield* store.setAccountSettings(account.id, { ...settings, imapSenderName: "" });
      assert.strictEqual((yield* store.getAccount(account.id)).imap?.senderName, undefined);
      const gmail = yield* store.upsertAccount("gmail", "me@gmail.com");
      const refused = yield* store
        .setAccountSettings(gmail.id, { ...settings, imapSenderName: "Jane" })
        .pipe(Effect.flip);
      assert.strictEqual(refused._tag, "InvalidInput");
    }).pipe(Effect.provide(StoreLive.pipe(Layer.provide(MemoryPlatform())))),
);

// `openmail accounts add imap` is how an IMAP account signs in again. It kept the sender name
// but dropped the authentication service trust set in Settings.
it.effect("adding an IMAP address again replaces its login and keeps its settings", () => {
  const server = fakeServer("me@fastmail.com", []);
  const imap = (imapHost: string) => ({
    preset: "custom",
    username: server.email,
    imapHost,
    imapPort: 993,
    smtpHost: "smtp.fastmail.com",
    smtpPort: 465,
    smtpSecure: true,
  });
  let host = "imap.fastmail.com";
  const fake = makeFakeProvider(server);
  const providers = Layer.succeed(Providers, {
    get: () => ({
      ...fake,
      connect: () =>
        Effect.succeed({ email: server.email, secret: "new-password", imap: imap(host) }),
    }),
  });
  return Effect.gen(function* () {
    const m = yield* Mailbox;
    const store = yield* Store;
    const input = { preset: "custom", email: server.email, password: "old" };
    const account = yield* m.accounts.connect({ provider: "imap", input });
    yield* store.setAccountSettings(account.id, {
      enabled: true,
      description: "",
      color: null,
      imapSenderName: "Jane Doe",
      imapAuthservId: "mx1.messagingengine.com",
    });
    yield* m.accounts.connect({ provider: "imap", input: { ...input, password: "new" } });
    const again = yield* store.getAccount(account.id);
    assert.strictEqual(again.imap?.senderName, "Jane Doe");
    assert.strictEqual(again.imap?.authservId, "mx1.messagingengine.com");
    // Trust names one server's results; another server starts without it.
    host = "imap.example.com";
    yield* m.accounts.connect({ provider: "imap", input: { ...input, password: "newer" } });
    const moved = yield* store.getAccount(account.id);
    assert.strictEqual(moved.imap?.imapHost, "imap.example.com");
    assert.strictEqual(moved.imap?.authservId, undefined);
    assert.strictEqual(moved.imap?.senderName, "Jane Doe");
  }).pipe(
    Effect.provide(
      MailboxLive({ backgroundFlush: false }).pipe(
        Layer.provideMerge(StoreLive),
        Layer.provide(providers),
        Layer.provide(MemoryPlatform()),
      ),
    ),
  );
});

it.effect("space names are stored trimmed and an empty name is refused", () =>
  Effect.gen(function* () {
    const mailbox = yield* Mailbox;
    const created = yield* mailbox.accounts.createProfile({
      name: "  Work  ",
      icon: "W",
      color: "blue",
    });
    assert.strictEqual(created.name, "Work");
    yield* mailbox.accounts.updateProfile(created.id, {
      name: " Home ",
      icon: "H",
      color: "blue",
    });
    assert.deepStrictEqual(
      (yield* mailbox.accounts.profiles).map((profile) => profile.name),
      ["Home"],
    );
    for (const name of ["", "   "]) {
      const exit = yield* mailbox.accounts
        .createProfile({ name, icon: "W", color: "blue" })
        .pipe(Effect.exit);
      assert.isTrue(exit._tag === "Failure");
    }
    // The RPC schema gives the desktop app the same rule.
    const decode = Schema.decodeUnknownResult(ProfileInput);
    assert.strictEqual(
      Result.getOrThrow(decode({ name: " Work ", icon: "W", color: "blue" })).name,
      "Work",
    );
    assert.isTrue(Result.isFailure(decode({ name: "  ", icon: "W", color: "blue" })));
  }).pipe(Effect.provide(TestMailbox({ gmail: fakeServer("me@example.com", []) }))),
);

// A space named None, or sharing a name, from before those rules could not change its
// icon or colour, since every edit checked the name it already had.
it.effect("a space from before the name rules can change its icon and colour", () =>
  Effect.gen(function* () {
    const { accounts } = yield* Mailbox;
    const store = yield* Store;
    const none = yield* store.createProfile({ name: "None", icon: "N", color: "blue" });
    yield* store.createProfile({ name: "Work", icon: "W", color: "blue" });
    const twin = yield* store.createProfile({ name: "work", icon: "w", color: "blue" });
    yield* accounts.updateProfile(none.id, { name: "None", icon: "X", color: "rose" });
    yield* accounts.updateProfile(twin.id, { name: " work ", icon: "Y", color: "emerald" });
    assert.deepStrictEqual(
      (yield* accounts.profiles).map(({ name, icon, color }) => [name, icon, color]),
      [
        ["None", "X", "rose"],
        ["Work", "W", "blue"],
        ["work", "Y", "emerald"],
      ],
    );
    // A real rename still meets the rules.
    const renamed = yield* accounts
      .updateProfile(none.id, { name: "none", icon: "X", color: "rose" })
      .pipe(Effect.flip);
    assert.strictEqual(renamed.message, PROFILE_NAME_ERRORS.reserved);
  }).pipe(Effect.provide(TestMailbox({ gmail: fakeServer("me@example.com", []) }))),
);

it.effect(
  "space names are unique in any letter case, none is reserved and blanks are refused",
  () =>
    Effect.gen(function* () {
      const { accounts } = yield* Mailbox;
      const space = (name: string) => ({ name, icon: "W", color: "blue" as const });
      const refusal = (effect: Effect.Effect<unknown, InvalidInput>) =>
        effect.pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        );
      const work = yield* accounts.createProfile(space("Work"));
      const home = yield* accounts.createProfile(space("Home"));
      assert.strictEqual(
        yield* refusal(accounts.createProfile(space(" WORK "))),
        PROFILE_NAME_ERRORS.taken,
      );
      assert.strictEqual(
        yield* refusal(accounts.updateProfile(home.id, space("work"))),
        PROFILE_NAME_ERRORS.taken,
      );
      // A space keeps its own name, in another letter case too.
      yield* accounts.updateProfile(work.id, space("WORK"));
      for (const name of ["none", " None "])
        assert.strictEqual(
          yield* refusal(accounts.createProfile(space(name))),
          PROFILE_NAME_ERRORS.reserved,
        );
      for (const name of ["\u200b", "\u00ad", "\u2068\u2069", "\t\n", "\u202e "])
        assert.strictEqual(
          yield* refusal(accounts.createProfile(space(name))),
          PROFILE_NAME_ERRORS.empty,
        );
      assert.strictEqual(
        yield* refusal(accounts.createProfile(space("Deep\nwork"))),
        PROFILE_NAME_ERRORS.control,
      );
      assert.strictEqual(
        yield* refusal(accounts.createProfile(space(home.id))),
        PROFILE_NAME_ERRORS.id,
      );
      assert.deepStrictEqual(
        (yield* accounts.profiles).map((profile) => profile.name),
        ["WORK", "Home"],
      );
    }).pipe(Effect.provide(TestMailbox({ gmail: fakeServer("me@example.com", []) }))),
);

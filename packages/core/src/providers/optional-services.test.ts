import { applyNativeMigration } from "../platform/node/migrations.js";
import { incoming as makeIncoming, TestMailbox, fakeServer } from "../platform/node/testing.js";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { BASE_SCOPES, consentBatch, OPTIONAL_SCOPES, serviceGrants } from "./optional-services.js";
import { makeGmail } from "./gmail/gmail.js";
import { makeOutlook } from "./outlook/outlook.js";
import { Mailbox } from "../mailbox/mailbox.js";
import { makeFakeProvider } from "../platform/node/fake-provider.js";
import { Store } from "../store/service.js";
import { OAuth, AppConfig, Secrets, type AuthorizeRequest } from "../platform/auth.js";
import type { ProviderAdapter } from "./adapter.js";
import { MemoryPlatform } from "../platform/node/platform-memory.js";
import type { IncomingMessage } from "../domain/message.js";
import { TestClock } from "effect/testing";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS } from "../db/migrations.js";
import { GMAIL_PERMANENT_DELETE_SCOPE } from "../domain/folder-actions.js";
{
  for (const provider of ["gmail", "outlook"] as const) {
    it.effect(
      `${provider}: base login and per-service consent use the registered client and actual token grants`,
      () => {
        const requests: AuthorizeRequest[] = [];
        const grants = [...BASE_SCOPES[provider], ...OPTIONAL_SCOPES[provider].calendar];
        const client = HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(
                JSON.stringify(
                  provider === "gmail"
                    ? { emailAddress: "me@gmail.com", historyId: "1" }
                    : { mail: "me@outlook.com", userPrincipalName: "me@outlook.com" },
                ),
              ),
            ),
          ),
        );
        return Effect.gen(function* () {
          const adapter: ProviderAdapter = yield* provider === "gmail" ? makeGmail : makeOutlook;
          const base = yield* adapter.connect({ provider });
          assert.deepStrictEqual(requests[0]?.scopes, BASE_SCOPES[provider]);
          assert.deepStrictEqual(base.scopes, grants);
          const optional = yield* adapter.connect({
            provider,
            feature: "contacts",
            grantedScopes: grants,
            loginHint: `me@${provider === "gmail" ? "gmail.com" : "outlook.com"}`,
          });
          const request = requests[1];
          assert.ok(request);
          assert.ok(request.scopes.includes(OPTIONAL_SCOPES[provider].contacts[0] ?? ""));
          assert.ok(request.scopes.includes(OPTIONAL_SCOPES[provider].calendar[0] ?? ""));
          assert.strictEqual(
            request.clientId,
            provider === "gmail" ? "own-google" : "own-microsoft",
          );
          assert.strictEqual(
            request.authUrl,
            provider === "gmail"
              ? "https://accounts.google.com/o/oauth2/v2/auth"
              : "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize",
          );
          if (provider === "gmail")
            assert.strictEqual(request.extraParams?.include_granted_scopes, "true");
          assert.deepStrictEqual(optional.scopes, grants); // Requested contacts were declined.
          const previousScopes =
            provider === "gmail" ? [...grants, "https://mail.google.com/"] : grants;
          yield* adapter.connect({
            provider,
            loginHint: base.email,
            grantedScopes: previousScopes,
          });
          assert.deepStrictEqual(requests[2]?.scopes, [...new Set(previousScopes)]);
          if (provider === "gmail")
            assert.strictEqual(requests[2]?.extraParams?.include_granted_scopes, "true");
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              MemoryPlatform(),
              Layer.succeed(HttpClient.HttpClient, client),
              Layer.succeed(AppConfig, {
                sources: Effect.succeed({
                  user: {
                    google: { clientId: "own-google", clientSecret: "own-secret" },
                    microsoft: { clientId: "own-microsoft" },
                  },
                  env: {},
                  builtIn: {},
                }),
                write: () => Effect.void,
                clearUser: () => Effect.void,
              }),
              Layer.succeed(Secrets, {
                get: () => Effect.succeed(Option.none()),
                set: () => Effect.void,
                remove: () => Effect.void,
              }),
              Layer.succeed(OAuth, {
                authorize: (request) => {
                  requests.push(request);
                  return Effect.succeed({
                    accessToken: "access",
                    refreshToken: Option.some("refresh"),
                    expiresIn: 3600,
                    scopes: grants,
                  });
                },
                refresh: () => Effect.die("unused"),
              }),
            ),
          ),
        );
      },
    );
    it.effect(
      `${provider}: missing or disabled optional services block their API while mail still syncs`,
      () => {
        const server = fakeServer("me@example.com");
        server.grantedScopes = [...BASE_SCOPES[provider]];
        server.contacts = [{ name: "Provider contact", address: "provider@example.com" }];
        return Effect.gen(function* () {
          const m = yield* Mailbox;
          const store = yield* Store;
          const account = yield* m.connect({ provider });
          assert.deepStrictEqual(
            (yield* m.optionalServices(account.id)).map((grant) => grant.state),
            ["notGranted", "notGranted", provider === "outlook" ? "granted" : "notGranted"],
          );
          assert.strictEqual((yield* m.vacation(account.id).pipe(Effect.result))._tag, "Success");
          server.grantedScopes = [...BASE_SCOPES[provider], ...OPTIONAL_SCOPES[provider].contacts];
          yield* m.reauth(account.id, "contacts");
          assert.strictEqual((yield* m.optionalServices(account.id))[0]?.state, "granted");
          assert.ok(
            (yield* m.suggestContacts("provider")).some(
              (contact) => contact.address === "provider@example.com",
            ),
          );
          yield* m.setServiceEnabled(account.id, "contacts", false);
          assert.strictEqual((yield* m.optionalServices(account.id))[0]?.state, "turnedOff");
          yield* m.calendar.refreshContacts(account.id);
          assert.deepStrictEqual(yield* m.suggestContacts("provider"), []);
          assert.deepStrictEqual(yield* store.disabledServices(account.id), ["contacts"]);
          assert.deepStrictEqual(yield* store.grantedScopes(account.id), server.grantedScopes);
          yield* m.sync();
          assert.strictEqual((yield* m.accounts)[0]?.needsReauth, false);
          yield* m.setServiceEnabled(account.id, "contacts", true);
          assert.strictEqual((yield* m.optionalServices(account.id))[0]?.state, "granted");
          assert.ok((yield* m.suggestContacts("provider")).length);
          const denied = yield* m.reauth(account.id, "calendar").pipe(Effect.result);
          assert.strictEqual(
            denied._tag === "Failure" && denied.failure._tag,
            "FeatureScopeMissing",
          );
        }).pipe(Effect.provide(TestMailbox({ [provider]: server })));
      },
    );
  }

  it("saved contacts do not require the optional suggestions scope, and Microsoft scope aliases match", () => {
    assert.strictEqual(
      serviceGrants("gmail", [OPTIONAL_SCOPES.gmail.contacts[0] ?? ""], [])[0]?.state,
      "granted",
    );
    assert.strictEqual(
      serviceGrants("outlook", ["https://graph.microsoft.com/Contacts.Read"], [])[0]?.state,
      "granted",
    );
  });

  const incoming = (id: string, date: number, labels = ["ARCHIVE"]): IncomingMessage =>
    makeIncoming(id, {
      threadId: id,
      subject: id,
      date: date - 400 * 86_400_000,
      from: { name: "", address: "sender@example.com" },
      to: [],
      bodyText: "1234567890",
      snippet: "preview",
      labels,
      isUnread: false,
    });

  it.effect(
    "cache budget evicts oldest access across accounts, preserving headers, drafts and FTS rowids",
    () =>
      Effect.gen(function* () {
        const m = yield* Mailbox;
        const store = yield* Store;
        const gmail = yield* store.upsertAccount("gmail", "a@example.com");
        const outlook = yield* store.upsertAccount("outlook", "b@example.com");
        yield* store.upsertMessage(gmail.id, incoming("old", 1));
        yield* store.upsertMessage(outlook.id, incoming("recent", 2));
        yield* store.upsertMessage(gmail.id, incoming("draft", 0, ["DRAFT"]));
        yield* store.touchBody(`${gmail.id}/old`, 3);
        yield* store.touchBody(`${outlook.id}/recent`, 9);
        yield* m.setPrefs({ bodyCacheBytes: 20 });
        assert.strictEqual((yield* store.getMessage(`${gmail.id}/old`)).bodyCached, false);
        assert.strictEqual(
          (yield* store.getMessage(`${outlook.id}/recent`)).bodyText,
          "1234567890",
        );
        assert.strictEqual((yield* store.getMessage(`${gmail.id}/draft`)).bodyText, "1234567890");
        assert.strictEqual((yield* m.threads({ search: "old" }))[0]?.subject, "old");
        const database = yield* m.cacheDatabaseSize;
        assert.ok(database.totalBytes > 0);
        assert.ok(database.reusableBytes >= 0 && database.reusableBytes <= database.totalBytes);
        yield* m.setPrefs({ bodyCacheBytes: 0 });
        assert.strictEqual((yield* store.getMessage(`${outlook.id}/recent`)).bodyCached, true);
        assert.strictEqual((yield* store.getMessage(`${gmail.id}/draft`)).bodyCached, true);
      }).pipe(Effect.provide(TestMailbox())),
  );

  it.effect(
    "turning off contacts prevents an in-flight snapshot from repopulating suggestions",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const server = fakeServer("me@gmail.com");
        const adapter = {
          ...makeFakeProvider(server),
          contactSnapshot: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(finish);
              return {
                contacts: [{ name: "Late", address: "late@example.com" }],
                groups: [],
                photos: [],
              };
            }),
        };
        yield* Effect.gen(function* () {
          const m = yield* Mailbox;
          const store = yield* Store;
          const account = yield* store.upsertAccount("gmail", server.email);
          yield* store.setGrantedScopes(account.id, server.grantedScopes);
          const refresh = yield* m.calendar.refreshContacts(account.id).pipe(Effect.forkScoped);
          yield* Deferred.await(started);
          yield* m.setServiceEnabled(account.id, "contacts", false);
          yield* Deferred.succeed(finish, undefined);
          yield* Fiber.join(refresh);
          assert.deepStrictEqual(yield* m.suggestContacts("late"), []);
          assert.deepStrictEqual(yield* m.contactGroups(""), []);
          assert.strictEqual((yield* m.optionalServices(account.id))[0]?.state, "turnedOff");
        }).pipe(
          Effect.provide(
            TestMailbox.withAdapter(adapter, {
              options: { backgroundFlush: false },
              platformOptions: {},
            }),
          ),
        );
      }).pipe(Effect.scoped),
  );
}

{
  const lastScopes = (server: ReturnType<typeof fakeServer>) => {
    const input = server.connects.at(-1);
    if (!input || input.provider === "imap") throw new Error("Expected OAuth request");
    return input.grantedScopes;
  };

  const old = -400 * 86_400_000;

  const mail = (providerId: string, change: Partial<IncomingMessage> = {}): IncomingMessage =>
    makeIncoming(providerId, {
      threadId: providerId,
      date: old,
      subject: providerId,
      from: { name: "", address: "sender@example.com" },
      to: [],
      bodyText: "1234567890",
      labels: ["ARCHIVE"],
      isUnread: false,
      snippet: "header",
      ...change,
    });

  for (const provider of ["gmail", "outlook"] as const) {
    it.effect(
      `${provider}: upgrade records legacy grants without deleting contacts or aliases`,
      () =>
        Effect.gen(function* () {
          const directory = mkdtempSync(join(tmpdir(), "openmail-upgrade-"));
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
          );
          const filename = join(directory, "mail.db");
          const accountId = `${provider}:legacy@example.com`;
          const db = new DatabaseSync(filename);
          try {
            for (const migration of MIGRATIONS.slice(0, 33)) applyNativeMigration(db, migration);
            db.exec("PRAGMA user_version=33");
            db.prepare("INSERT INTO accounts(id,provider,email,created_at) VALUES(?,?,?,0)").run(
              accountId,
              provider,
              "legacy@example.com",
            );
            db.prepare("INSERT INTO server_contacts(account_id,address,name) VALUES(?,?,?)").run(
              accountId,
              "old@example.com",
              "Old person",
            );
            db.prepare(
              "INSERT INTO send_as(account_id,address,name,is_default,signature) VALUES(?,?,?,0,'')",
            ).run(accountId, "alias@example.com", "Alias");
          } finally {
            db.close();
          }
          const server = fakeServer("legacy@example.com");
          const layer = () =>
            TestMailbox.withAdapter(makeFakeProvider(server), {
              options: { backgroundFlush: false },
              platformOptions: { database: filename },
            });
          yield* Effect.gen(function* () {
            const m = yield* Mailbox;
            const store = yield* Store;
            assert.deepStrictEqual(
              (yield* m.optionalServices(accountId)).map((grant) => grant.state),
              ["granted", "granted", "granted"],
            );
            assert.ok(
              (yield* store.grantedScopes(accountId)).includes(
                OPTIONAL_SCOPES[provider].contacts[0] ?? "",
              ),
            );
            assert.ok(
              (yield* m.suggestContacts("old")).some(
                (contact) => contact.address === "old@example.com",
              ),
            );
            assert.ok((yield* m.sendAs).some((alias) => alias.address === "alias@example.com"));
            assert.strictEqual((yield* m.prefs).bodyCacheBytes, 0);
          }).pipe(Effect.provide(layer()));
          yield* Effect.gen(function* () {
            const m = yield* Mailbox;
            assert.ok((yield* m.suggestContacts("old")).length);
            assert.ok((yield* m.sendAs).length);
            assert.strictEqual((yield* m.optionalServices(accountId))[0]?.state, "granted");
          }).pipe(Effect.provide(layer()));
        }).pipe(Effect.scoped),
    );
    it.effect(`${provider}: ordinary reauth and re-add preserve stored grants`, () => {
      const server = fakeServer("me@example.com");
      server.grantedScopes = [
        ...new Set([
          ...BASE_SCOPES[provider],
          ...Object.values(OPTIONAL_SCOPES[provider]).flat(),
          ...(provider === "gmail" ? [GMAIL_PERMANENT_DELETE_SCOPE] : []),
        ]),
      ];
      return Effect.gen(function* () {
        const m = yield* Mailbox;
        const account = yield* m.connect({ provider });
        yield* m.reauth(account.id);
        assert.deepStrictEqual(lastScopes(server), server.grantedScopes);
        yield* m.connect({ provider, loginHint: account.email });
        assert.deepStrictEqual(lastScopes(server), server.grantedScopes);
        yield* m.connect({ provider });
        assert.deepStrictEqual(lastScopes(server), server.grantedScopes);
      }).pipe(Effect.provide(TestMailbox({ [provider]: server })));
    });
  }

  it.effect(
    "Gmail Settings off retains aliases, reads them with mail scopes, and blocks only settings writes",
    () => {
      const server = fakeServer("me@gmail.com");
      server.grantedScopes = [...BASE_SCOPES.gmail];
      server.aliases = [
        {
          accountId: "gmail:me@gmail.com",
          address: "alias@example.com",
          name: "Alias",
          isDefault: false,
          signature: "",
        },
      ];
      return Effect.gen(function* () {
        const m = yield* Mailbox;
        const account = yield* m.connect({ provider: "gmail" });
        yield* m.syncSendAs(account.id);
        assert.ok((yield* m.sendAs).length);
        assert.strictEqual((yield* m.filters(account.id).pipe(Effect.result))._tag, "Success");
        assert.strictEqual((yield* m.vacation(account.id).pipe(Effect.result))._tag, "Success");
        yield* m.setServiceEnabled(account.id, "settings", false);
        assert.ok((yield* m.sendAs).length);
        yield* m.syncSendAs(account.id);
        assert.ok((yield* m.sendAs).length);
        assert.strictEqual(
          (yield* m.setVacation(account.id, server.vacation).pipe(Effect.result))._tag,
          "Failure",
        );
      }).pipe(Effect.provide(TestMailbox({ gmail: server })));
    },
  );

  it("Outlook base grant includes the permission required by master categories", () =>
    assert.ok(BASE_SCOPES.outlook.includes("MailboxSettings.ReadWrite")));

  it.effect(
    "budget respects stars, all retention windows, drafts and outbox, and is disabled by default",
    () =>
      Effect.gen(function* () {
        const m = yield* Mailbox;
        const store = yield* Store;
        const account = yield* store.upsertAccount("gmail", "me@example.com");
        assert.strictEqual((yield* m.prefs).bodyCacheBytes, 0);
        const protectedMail = [
          mail("inbox", { labels: ["INBOX"] }),
          mail("star", { isStarred: true }),
          mail("draft", { labels: ["DRAFT"] }),
          mail("outbox", { labels: ["OUTBOX"] }),
          mail("forever", { labels: ["Work"] }),
          mail("recent", { date: 0 }),
        ];
        yield* store.setCacheWindow({ accountId: account.id, label: "Work", days: null });
        for (const message of [...protectedMail, mail("expired")])
          yield* store.upsertMessage(account.id, message);
        yield* m.setPrefs({ bodyCacheBytes: 1 });
        for (const message of protectedMail)
          assert.strictEqual(
            (yield* store.getMessage(`${account.id}/${message.providerId}`)).bodyCached,
            true,
            message.providerId,
          );
        assert.strictEqual((yield* store.getMessage(`${account.id}/expired`)).bodyCached, false);
        yield* store.upsertMessage(account.id, mail("disabled"));
        yield* m.setPrefs({ bodyCacheBytes: 0 });
        assert.strictEqual((yield* store.getMessage(`${account.id}/disabled`)).bodyCached, true);
      }).pipe(Effect.provide(TestMailbox())),
  );

  it.effect("budget runs at most hourly and respects explicit preference changes", () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount("gmail", "me@example.com");
      yield* store.upsertMessage(account.id, mail("first"));
      yield* store.evictBodyBudget(1);
      yield* store.upsertMessage(account.id, mail("second"));
      assert.strictEqual(yield* store.evictBodyBudget(1), 0);
      assert.strictEqual((yield* store.getMessage(`${account.id}/second`)).bodyCached, true);
      yield* TestClock.adjust("1 hour");
      assert.strictEqual(yield* store.evictBodyBudget(1), 1);
      assert.strictEqual((yield* store.getMessage(`${account.id}/second`)).bodyCached, false);
    }).pipe(Effect.provide(TestMailbox())),
  );

  it.effect("Gmail local draft organization survives actual provider Flags sync", () => {
    const server = fakeServer("me@gmail.com");
    const base = makeFakeProvider(server);
    let flagsOnly = false;
    const adapter = {
      ...base,
      pull: (...args: Parameters<typeof base.pull>) =>
        flagsOnly
          ? Stream.fromIterable(
              [...server.messages.values()].map((message) => ({
                _tag: "Flags" as const,
                providerId: message.providerId,
                isUnread: false,
                isStarred: message.isStarred,
              })),
            )
          : base.pull(...args),
    };
    return Effect.gen(function* () {
      const m = yield* Mailbox;
      const account = yield* m.connect({ provider: "gmail" });
      const draft = yield* m.saveDraft({
        id: "draft:flags-real",
        accountId: account.id,
        message: {
          to: [],
          cc: [],
          bcc: [],
          attachments: [],
          subject: "draft",
          text: "text",
          draftOrganization: { labels: ["Label_work"], starred: true },
        },
      });
      yield* m.sync();
      flagsOnly = true;
      yield* m.sync();
      assert.strictEqual((yield* m.threads({ mailbox: "drafts" }))[0]?.isStarred, true);
      yield* m.saveDraft({
        id: draft.id,
        accountId: account.id,
        message: { ...draft.message, draftOrganization: { labels: [], starred: false } },
      });
      for (const [id, message] of server.messages)
        server.messages.set(id, { ...message, isStarred: true });
      yield* m.sync();
      const cleared = (yield* m.threads({ mailbox: "drafts" }))[0];
      assert.strictEqual(cleared?.isStarred, false);
      assert.ok(!cleared?.labels.includes("Label_work"));
    }).pipe(
      Effect.provide(
        TestMailbox.withAdapter(adapter, {
          options: { backgroundFlush: false },
          platformOptions: {},
        }),
      ),
    );
  });
}

it.effect(
  "connecting a service also asks for services turned on earlier, never untouched ones, with the login hint",
  () => {
    const server = fakeServer("me@gmail.com");
    server.grantedScopes = [...BASE_SCOPES.gmail, ...OPTIONAL_SCOPES.gmail.calendar];
    return Effect.gen(function* () {
      const m = yield* Mailbox;
      const account = yield* m.connect({ provider: "gmail" });
      // Calendar was turned on, then lost its grant at a later sign-in.
      yield* m.setServiceEnabled(account.id, "calendar", true);
      server.grantedScopes = [...BASE_SCOPES.gmail];
      yield* m.reauth(account.id);
      assert.deepStrictEqual(yield* m.optionalServices(account.id), [
        { service: "contacts", state: "notGranted" },
        { service: "calendar", state: "notGranted", wanted: true },
        { service: "settings", state: "notGranted" },
      ]);
      server.grantedScopes = [
        ...BASE_SCOPES.gmail,
        ...OPTIONAL_SCOPES.gmail.calendar,
        ...OPTIONAL_SCOPES.gmail.settings,
      ];
      yield* m.reauth(account.id, "settings");
      const request = server.connects.at(-1);
      assert.strictEqual(request?.provider !== "imap" && request?.loginHint, "me@gmail.com");
      const scopes = request?.provider === "imap" ? [] : (request?.grantedScopes ?? []);
      assert.includeMembers(
        [...scopes],
        [...OPTIONAL_SCOPES.gmail.settings, ...OPTIONAL_SCOPES.gmail.calendar],
      );
      // Contacts was never turned on, so it is not requested.
      assert.notInclude(scopes, OPTIONAL_SCOPES.gmail.contacts[0]);
      assert.deepStrictEqual(
        (yield* m.optionalServices(account.id)).map((grant) => grant.state),
        ["notGranted", "granted", "granted"],
      );
    }).pipe(Effect.provide(TestMailbox({ gmail: server })));
  },
);

it("the consent batch is the clicked service plus wanted ones", () => {
  const grants = serviceGrants("outlook", [...BASE_SCOPES.outlook], [], ["contacts"]);
  assert.deepStrictEqual(consentBatch(grants, "calendar"), ["calendar", "contacts"]);
  assert.deepStrictEqual(consentBatch(grants, "contacts"), ["contacts"]);
  assert.deepStrictEqual(consentBatch(serviceGrants("outlook", [], [], []), "calendar"), [
    "calendar",
  ]);
});

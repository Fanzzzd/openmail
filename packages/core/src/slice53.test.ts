import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { BASE_SCOPES, OPTIONAL_SCOPES, serviceGrants } from "./optional-services.js";
import { makeGmail } from "./gmail.js";
import { makeOutlook } from "./outlook.js";
import { Mailbox } from "./mailbox.js";
import { MailboxLive } from "./mailbox-live.js";
import { StoreLive } from "./store.js";
import { makeFakeProvider } from "./platform/node/fake-provider.js";
import {
  Providers,
  Store,
  OAuth,
  AppConfig,
  Secrets,
  type AuthorizeRequest,
  type ProviderAdapter,
} from "./services.js";
import { MemoryPlatform } from "./platform/node/platform-memory.js";
import { TestMailbox, fakeServer } from "./platform/node/testing.js";
import type { IncomingMessage } from "./domain.js";

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
        assert.strictEqual(request.clientId, provider === "gmail" ? "own-google" : "own-microsoft");
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
        yield* adapter.connect({ provider, loginHint: base.email, grantedScopes: previousScopes });
        assert.deepStrictEqual(requests[2]?.scopes, [...new Set(previousScopes)]);
        if (provider === "gmail")
          assert.strictEqual(requests[2]?.extraParams?.include_granted_scopes, "true");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            MemoryPlatform(),
            Layer.succeed(HttpClient.HttpClient, client),
            Layer.succeed(AppConfig, {
              read: Effect.succeed({
                google: { clientId: "own-google", clientSecret: "own-secret" },
                microsoft: { clientId: "own-microsoft" },
              }),
              write: () => Effect.void,
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
        yield* m.refreshContacts(account.id);
        assert.deepStrictEqual(yield* m.suggestContacts("provider"), []);
        assert.deepStrictEqual(yield* store.disabledServices(account.id), ["contacts"]);
        assert.deepStrictEqual(yield* store.grantedScopes(account.id), server.grantedScopes);
        yield* m.sync();
        assert.strictEqual((yield* m.accounts)[0]?.needsReauth, false);
        yield* m.setServiceEnabled(account.id, "contacts", true);
        assert.strictEqual((yield* m.optionalServices(account.id))[0]?.state, "granted");
        assert.ok((yield* m.suggestContacts("provider")).length);
        const denied = yield* m.reauth(account.id, "calendar").pipe(Effect.result);
        assert.strictEqual(denied._tag === "Failure" && denied.failure._tag, "FeatureScopeMissing");
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

const incoming = (id: string, date: number, labels = ["ARCHIVE"]): IncomingMessage => ({
  providerId: id,
  threadId: id,
  subject: id,
  date: date - 400 * 86_400_000,
  from: { name: "", address: "sender@example.com" },
  to: [],
  cc: [],
  bodyText: "1234567890",
  bodyHtml: "",
  snippet: "preview",
  labels,
  attachments: [],
  isUnread: false,
  isStarred: false,
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
      assert.strictEqual((yield* store.getMessage(`${outlook.id}/recent`)).bodyText, "1234567890");
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

it.effect("turning off contacts prevents an in-flight snapshot from repopulating suggestions", () =>
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
      const refresh = yield* m.refreshContacts(account.id).pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      yield* m.setServiceEnabled(account.id, "contacts", false);
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(refresh);
      assert.deepStrictEqual(yield* m.suggestContacts("late"), []);
      assert.deepStrictEqual(yield* m.contactGroups(""), []);
      assert.strictEqual((yield* m.optionalServices(account.id))[0]?.state, "turnedOff");
    }).pipe(
      Effect.provide(
        MailboxLive({ backgroundFlush: false }).pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              StoreLive,
              Layer.succeed(Providers, Providers.of({ get: () => adapter })),
            ).pipe(Layer.provideMerge(MemoryPlatform())),
          ),
        ),
      ),
    );
  }).pipe(Effect.scoped),
);

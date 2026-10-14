import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { makeGmail } from "./gmail/gmail.js";
import { Mailbox } from "../mailbox/mailbox.js";
import { clientForToken, effectiveClients } from "./oauth-clients.js";
import { makeOutlook } from "./outlook/outlook.js";
import { fakeHttp } from "../platform/node/fake-http.js";
import { MemoryPlatform, type MemoryPlatformOptions } from "../platform/node/platform-memory.js";
import { account, TestMailbox } from "../platform/node/testing.js";
import { AppConfig, type ClientConfig, OAuthIssuers } from "../platform/auth.js";
import { Store } from "../store/service.js";
import { StoreLive } from "../store/store.js";

const user = { clientId: "user-google", clientSecret: "user-secret" };
const env = { clientId: "env-google", clientSecret: "env-secret" };
const builtIn = { clientId: "builtin-google", clientSecret: "builtin-secret" };

it("a recorded issuer must match exactly; an unrecorded one is never given a built-in client", () => {
  const all = { user, env, builtIn };
  assert.strictEqual(clientForToken(Option.some("builtin-google"), all), builtIn);
  assert.strictEqual(clientForToken(Option.some("user-google"), all), user);
  assert.strictEqual(clientForToken(Option.some("env-google"), all), env);
  assert.strictEqual(clientForToken(Option.some("gone"), all), undefined);
  // The previous version let env vars win over config.json.
  assert.strictEqual(clientForToken(Option.none(), all), env);
  assert.strictEqual(clientForToken(Option.none(), { user, env: undefined, builtIn }), user);
  assert.strictEqual(
    clientForToken(Option.none(), { user: undefined, env: undefined, builtIn }),
    undefined,
  );
});

const gmail = account("gmail");
const outlook = account("outlook");

/**
 * Adds both accounts to the database with their recorded issuers, then runs
 * one Gmail and one Outlook read, so each account refreshes its token once.
 */
const refreshBoth = (
  options: MemoryPlatformOptions,
  issuers: { gmail?: string; outlook?: string } = {},
) => {
  const refreshed: { clientId: string; clientSecret?: string; refreshToken: string }[] = [];
  const platform = MemoryPlatform({
    secrets: { [gmail.id]: "gmail-token", [outlook.id]: "outlook-token" },
    ...options,
    oauth: {
      refresh: (_accountId, request) =>
        Effect.sync(() => {
          refreshed.push({
            clientId: request.clientId,
            refreshToken: request.refreshToken,
            ...(request.clientSecret ? { clientSecret: request.clientSecret } : {}),
          });
          return { accessToken: "access", refreshToken: Option.none(), expiresIn: 3600 };
        }),
    },
  });
  return Effect.gen(function* () {
    const store = yield* Store;
    const recorded = yield* OAuthIssuers;
    for (const [entry, issuer] of [
      [gmail, issuers.gmail],
      [outlook, issuers.outlook],
    ] as const) {
      yield* store.upsertAccount(entry.provider, entry.email);
      if (issuer) yield* recorded.set(entry.id, issuer);
    }
    const results = [
      yield* Effect.flatMap(makeGmail, (adapter) => Effect.exit(adapter.fetchRaw(gmail, "m1"))),
      yield* Effect.flatMap(makeOutlook, (adapter) => Effect.exit(adapter.fetchRaw(outlook, "m1"))),
    ];
    return {
      refreshed,
      results,
      issuers: [yield* recorded.get(gmail.id), yield* recorded.get(outlook.id)],
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(fakeHttp({}).layer, StoreLive.pipe(Layer.provideMerge(platform))),
    ),
  );
};

it.effect("an account keeps refreshing with the client that issued its token", () =>
  Effect.gen(function* () {
    // Gmail was signed in with the built-in client, Outlook with the user's own.
    const { refreshed } = yield* refreshBoth(
      {
        config: { google: user, microsoft: { clientId: "user-microsoft" } },
        builtInClients: { google: builtIn, microsoft: { clientId: "builtin-microsoft" } },
      },
      { gmail: "builtin-google", outlook: "user-microsoft" },
    );
    assert.deepStrictEqual(refreshed, [
      { clientId: "builtin-google", clientSecret: "builtin-secret", refreshToken: "gmail-token" },
      { clientId: "user-microsoft", refreshToken: "outlook-token" },
    ]);
  }),
);

it.effect("a token whose issuer is no longer configured is never sent with another client", () =>
  Effect.gen(function* () {
    const { refreshed, results } = yield* refreshBoth(
      {
        config: { google: user },
        builtInClients: { google: builtIn, microsoft: { clientId: "builtin-microsoft" } },
      },
      { gmail: "removed-google", outlook: "removed-microsoft" },
    );
    assert.deepStrictEqual(refreshed, []);
    for (const result of results) {
      assert.ok(result._tag === "Failure");
      assert.include(String(result.cause), "AuthError");
    }
  }),
);

it.effect("accounts from before issuers were recorded use the user's client, then record it", () =>
  Effect.gen(function* () {
    const { refreshed, issuers } = yield* refreshBoth({
      config: { google: user, microsoft: { clientId: "user-microsoft" } },
      builtInClients: { google: builtIn, microsoft: { clientId: "builtin-microsoft" } },
    });
    assert.deepStrictEqual(
      refreshed.map((request) => request.clientId),
      ["user-google", "user-microsoft"],
    );
    assert.deepStrictEqual(issuers, [Option.some("user-google"), Option.some("user-microsoft")]);
  }),
);

it.effect(
  "an unrecorded account whose user client was removed signs in again instead of using the built-in client",
  () =>
    Effect.gen(function* () {
      const { refreshed, results, issuers } = yield* refreshBoth({
        builtInClients: { google: builtIn, microsoft: { clientId: "builtin-microsoft" } },
      });
      assert.deepStrictEqual(refreshed, []);
      for (const result of results) {
        assert.ok(result._tag === "Failure");
        assert.include(String(result.cause), "AuthError");
      }
      assert.deepStrictEqual(issuers, [Option.none(), Option.none()]);
    }),
);

it.effect("a new sign-in uses the user's client over the built-in one and reports it", () =>
  Effect.gen(function* () {
    const connect = (options: MemoryPlatformOptions) =>
      Effect.flatMap(makeGmail, (adapter) => adapter.connect({ provider: "gmail" })).pipe(
        Effect.provide(
          Layer.mergeAll(
            fakeHttp({ "GET /profile": { json: { emailAddress: gmail.email, historyId: "1" } } })
              .layer,
            MemoryPlatform(options),
          ),
        ),
      );
    assert.strictEqual(
      (yield* connect({ config: { google: user }, builtInClients: { google: builtIn } })).clientId,
      "user-google",
    );
    assert.strictEqual(
      (yield* connect({ builtInClients: { google: builtIn } })).clientId,
      "builtin-google",
    );
  }),
);

it.effect("built-in clients are never written to config.json", () =>
  Effect.gen(function* () {
    const config = yield* AppConfig;
    assert.deepStrictEqual(effectiveClients(yield* config.sources), { google: builtIn });
    yield* config.write({ google: user });
    assert.deepStrictEqual(yield* config.sources, {
      user: { google: user },
      env: {},
      builtIn: { google: builtIn },
    });
    yield* config.clearUser("google");
    assert.deepStrictEqual((yield* config.sources).user, {});
  }).pipe(Effect.provide(MemoryPlatform({ builtInClients: { google: builtIn } }))),
);

const setupOf = (config: ClientConfig, builtInClients: ClientConfig) =>
  Effect.flatMap(Mailbox, (mailbox) => mailbox.accounts.clientSetup).pipe(
    Effect.provide(
      TestMailbox({}, { backgroundFlush: false }, {}, Layer.empty, { config, builtInClients }),
    ),
  );

it.effect("client setup says which client is active, never its values", () =>
  Effect.gen(function* () {
    const setup = yield* setupOf(
      { google: user },
      { google: builtIn, microsoft: { clientId: "builtin-microsoft" } },
    );
    assert.deepStrictEqual(setup, {
      googleClient: "own",
      microsoftClient: "builtIn",
      googleBuiltIn: true,
      microsoftBuiltIn: true,
    });
    assert.notInclude(JSON.stringify(setup), "google-");
    assert.deepStrictEqual(yield* setupOf({}, {}), {
      googleClient: "none",
      microsoftClient: "none",
      googleBuiltIn: false,
      microsoftBuiltIn: false,
    });
  }),
);

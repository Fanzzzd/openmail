import { assert, it } from "@effect/vitest";
import { Clock, Deferred, Effect, Fiber, Layer, Logger, Option, Schema } from "effect";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

import type { Account } from "./domain.js";
import { AuthError, KEYCHAIN_LOCKED_MESSAGE, ProviderError } from "./errors.js";
import { MailboxLive } from "./mailbox-live.js";
import { Mailbox } from "./mailbox.js";
import { makeOutlook } from "./outlook.js";
import { fakeHttp } from "./platform/node/fake-http.js";
import { refreshWithIssuer } from "./oauth-clients.js";
import { isAuthFailure, failure as imapFailure } from "./platform/node/imap/session.js";
import { sha256Hex } from "./platform/crypto.js";
import { diagnosticRecord } from "./platform/node/diagnostics.js";
import { MemoryPlatform } from "./platform/node/platform-memory.js";
import { makeProviderHttp } from "./provider-http.js";
import { providerReadFailure } from "./provider-send.js";
import {
  isLoginRefusal,
  isTestingModeExpiry,
  KEEP_ALIVE_MAX_AGE_MS,
  keychainLocked,
  ReauthDiagnostic,
  tokenEndpointFailure,
} from "./reauth.js";
import {
  type AppConfig,
  type OAuthIssuers,
  Providers,
  Secrets,
  Store,
  type TokenResponse,
} from "./services.js";
import { StoreLive } from "./store.js";
import { type KeepAliveProviders, keepTokensAlive, runTokenKeepAlive } from "./token-keepalive.js";

const DAY = 86_400_000;
const ID = "outlook:me@outlook.com";

it("only definitive OAuth codes ask for a new sign-in; everything else is retried", () => {
  const reason = (status: number, body: unknown) => {
    const error = tokenEndpointFailure(ID, status, JSON.stringify(body));
    return error._tag === "AuthError" ? error.reason : `retry ${error.status}`;
  };
  assert.strictEqual(reason(400, { error: "invalid_grant" }), "token_revoked");
  assert.strictEqual(reason(400, { error: "interaction_required" }), "token_revoked");
  assert.strictEqual(reason(401, { error: "invalid_client" }), "client_mismatch");
  assert.strictEqual(reason(400, { error: "unauthorized_client" }), "client_mismatch");
  assert.strictEqual(reason(400, { error: "consent_required" }), "scope_missing");
  assert.strictEqual(reason(400, { error: "invalid_request" }), "retry 400");
  assert.strictEqual(reason(429, { error: "invalid_grant" }), "retry 429");
  assert.strictEqual(reason(500, { error: "server_error" }), "retry 500");
  assert.strictEqual(reason(503, "<html>down</html>"), "retry 503");
  // The body is never copied into the message: it can echo request parameters.
  const error = tokenEndpointFailure(ID, 400, '{"error":"invalid_grant","refresh_token":"secret"}');
  assert.notInclude(error.message, "secret");
});

it("Google's Testing-mode expiry is an invalid_grant at least 6.5 days after sign-in", () => {
  assert.isTrue(isTestingModeExpiry(0, 6.5 * DAY));
  assert.isTrue(isTestingModeExpiry(0, 30 * DAY));
  assert.isFalse(isTestingModeExpiry(0, 2 * DAY));
});

const issuers = (issuedAt: number | undefined, issuer = "client"): OAuthIssuers["Service"] => ({
  get: () => Effect.succeed(Option.some(issuer)),
  set: () => Effect.void,
  issuedAt: () => Effect.succeed(Option.fromNullishOr(issuedAt)),
  setIssuedAt: () => Effect.void,
});
const config: AppConfig["Service"] = {
  sources: Effect.succeed({
    user: { google: { clientId: "own", clientSecret: "secret" } },
    env: {},
    builtIn: { google: { clientId: "client", clientSecret: "secret" } },
  }),
  write: () => Effect.void,
  clearUser: () => Effect.void,
};
const googleRefresh = (issuedAt: number | undefined, issuer = "client") =>
  refreshWithIssuer(
    { config, issuers: issuers(issuedAt, issuer) },
    { name: "Google", pick: (clients) => clients.google, testingMode: true },
    ID,
    () => Effect.fail(tokenEndpointFailure(ID, 400, '{"error":"invalid_grant"}')),
  ).pipe(
    Effect.flip,
    Effect.map((error) => error._tag === "AuthError" && error.reason),
  );

it.effect(
  "the built-in client's invalid_grant 7 days after sign-in is testing_mode_expiry; at 2 days, without a time, or from an own client it is a revocation",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(40 * DAY);
      assert.strictEqual(yield* googleRefresh(33 * DAY), "testing_mode_expiry");
      assert.strictEqual(yield* googleRefresh(0), "testing_mode_expiry");
      assert.strictEqual(yield* googleRefresh(38 * DAY), "token_revoked");
      assert.strictEqual(yield* googleRefresh(undefined), "token_revoked");
      assert.strictEqual(yield* googleRefresh(33 * DAY, "own"), "token_revoked");
    }),
);

it.effect("a refresh token whose client is gone is client_mismatch", () =>
  refreshWithIssuer(
    { config, issuers: { ...issuers(undefined), get: () => Effect.succeed(Option.some("old")) } },
    { name: "Google", pick: (clients) => clients.google },
    ID,
    () => Effect.die("not reached"),
  ).pipe(
    Effect.flip,
    Effect.map((error) =>
      assert.strictEqual(error._tag === "AuthError" && error.reason, "client_mismatch"),
    ),
  ),
);

/** In-memory keychain whose reads and writes can be made to fail. */
function fakeKeychain(initial: string | undefined) {
  const state = {
    value: initial,
    readFails: 0,
    writeFails: 0,
    writes: [] as string[],
    events: [] as string[],
  };
  const secrets: Secrets["Service"] = {
    get: () =>
      Effect.suspend(() => {
        if (state.readFails > 0) {
          state.readFails--;
          return Effect.fail(keychainLocked());
        }
        return Effect.succeed(Option.fromNullishOr(state.value));
      }),
    set: (_key, value) =>
      Effect.suspend(() => {
        if (state.writeFails > 0) {
          state.writeFails--;
          return Effect.fail(keychainLocked());
        }
        state.value = value;
        state.writes.push(value);
        state.events.push(`save ${value}`);
        return Effect.void;
      }),
    remove: () => Effect.void,
  };
  return { state, secrets };
}

/** A provider HTTP client over a fake API that answers `statuses` in order, then 200. */
const providerHttp = (
  secrets: Secrets["Service"],
  refresh: (token: string) => Effect.Effect<TokenResponse, AuthError | ProviderError>,
  statuses: number[] = [],
  events: string[] = [],
  http: HttpClient.HttpClient = HttpClient.make((request) =>
    Effect.sync(() => {
      events.push(`request ${request.headers.authorization ?? ""}`);
      const status = statuses.shift() ?? 200;
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify({ ok: status === 200 }), { status }),
      );
    }),
  ),
) =>
  makeProviderHttp({
    http,
    concurrency: 4,
    serializeSend: false,
    sending: () => Effect.succeed(false),
    background: () => false,
    permits: () => 1,
    logFailure: () => Effect.void,
    secrets,
    tokenLabel: "Microsoft",
    refresh: (_accountId, token) => refresh(token),
    throttleReads: false,
    prepareRequest: (request) => request,
    parseResponse: (text) => JSON.parse(text),
    isTransient: () => false,
  });

const token = (access: string, rotated?: string): TokenResponse => ({
  accessToken: access,
  refreshToken: Option.fromNullishOr(rotated),
  expiresIn: 3600,
});
const GET = HttpClientRequest.get("https://graph.microsoft.com/v1.0/me");
const readFailure = providerReadFailure("Graph")(ID);

it.effect("a single 401 forces one refresh and a retry, then succeeds without a sign-in", () =>
  Effect.gen(function* () {
    const { secrets } = fakeKeychain("refresh");
    let refreshes = 0;
    const http = yield* providerHttp(
      secrets,
      () => Effect.sync(() => token(`access-${++refreshes}`)),
      [401],
    );
    assert.deepStrictEqual(yield* http.api(ID, GET), { ok: true });
    assert.strictEqual(refreshes, 2);
  }),
);

it.effect("a 401 that survives the forced refresh is a revocation", () =>
  Effect.gen(function* () {
    const { secrets } = fakeKeychain("refresh");
    const http = yield* providerHttp(secrets, () => Effect.succeed(token("access")), [401, 401]);
    const error = yield* http.api(ID, GET).pipe(Effect.mapError(readFailure), Effect.flip);
    assert.strictEqual(error._tag, "AuthError");
  }),
);

// Live clock: a failed GET is retried once after a short wait.
it.live("a 5xx, 429 or network failure is never an AuthError", () =>
  Effect.gen(function* () {
    for (const status of [500, 503, 429]) {
      const { secrets } = fakeKeychain("refresh");
      const http = yield* providerHttp(secrets, () => Effect.succeed(token("access")), [status]);
      const error = yield* http.api(ID, GET).pipe(Effect.mapError(readFailure), Effect.flip);
      assert.strictEqual(error._tag, "ProviderError", String(status));
    }
    const offline = yield* providerHttp(
      fakeKeychain("refresh").secrets,
      () => Effect.succeed(token("access")),
      [],
      [],
      HttpClient.make((request) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
            }),
          }),
        ),
      ),
    );
    const dns = yield* offline.api(ID, GET).pipe(Effect.mapError(readFailure), Effect.flip);
    assert.strictEqual(dns._tag, "ProviderError");
  }),
);

it.effect("a locked keychain is retryable; only a missing item asks for a sign-in", () =>
  Effect.gen(function* () {
    const locked = fakeKeychain("refresh");
    locked.state.readFails = 1;
    const http = yield* providerHttp(locked.secrets, () => Effect.succeed(token("access")));
    const error = yield* http.api(ID, GET).pipe(Effect.flip);
    assert.strictEqual(error._tag, "ProviderError");
    assert.strictEqual(error._tag === "ProviderError" && error.reason, "keychain");
    // The next attempt, after the keychain unlocks, works.
    assert.deepStrictEqual(yield* http.api(ID, GET), { ok: true });

    const missing = fakeKeychain(undefined);
    const empty = yield* providerHttp(missing.secrets, () => Effect.succeed(token("access")));
    const gone = yield* empty.api(ID, GET).pipe(Effect.flip);
    assert.strictEqual(gone._tag === "AuthError" && gone.reason, "keychain_missing");
  }),
);

it.effect(
  "concurrent requests refresh once, and a rotated token is saved before its access token is used",
  () =>
    Effect.gen(function* () {
      const keychain = fakeKeychain("r1");
      const used: string[] = [];
      const gate = yield* Deferred.make<void>();
      const http = yield* providerHttp(
        keychain.secrets,
        (current) =>
          Effect.gen(function* () {
            used.push(current);
            yield* Deferred.await(gate);
            return token(`access-${current}`, `${current}-next`);
          }),
        [],
        keychain.state.events,
      );
      const fibers = yield* Effect.forkChild(
        Effect.all([http.api(ID, GET), http.api(ID, GET), http.api(ID, GET)], {
          concurrency: "unbounded",
        }),
      );
      yield* Effect.yieldNow;
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(fibers);
      assert.deepStrictEqual(used, ["r1"]);
      assert.strictEqual(keychain.state.value, "r1-next");
      assert.strictEqual(keychain.state.events[0], "save r1-next");
      assert.isTrue(keychain.state.events.slice(1).every((event) => event.startsWith("request")));
    }),
);

it.effect("an invalid_grant on a token another process rotated re-reads the keychain once", () =>
  Effect.gen(function* () {
    const keychain = fakeKeychain("r1");
    const used: string[] = [];
    const http = yield* providerHttp(keychain.secrets, (current) =>
      Effect.suspend(() => {
        used.push(current);
        if (current === "r1") {
          // The CLI refreshed meanwhile and stored its rotated token.
          keychain.state.value = "r2";
          return Effect.fail(tokenEndpointFailure(ID, 400, '{"error":"invalid_grant"}'));
        }
        return Effect.succeed(token("access", "r3"));
      }),
    );
    assert.deepStrictEqual(yield* http.api(ID, GET), { ok: true });
    assert.deepStrictEqual(used, ["r1", "r2"]);
    assert.strictEqual(keychain.state.value, "r3");

    // A token nobody rotated stays a revocation after the one re-read.
    const revoked = fakeKeychain("r1");
    const dead = yield* providerHttp(revoked.secrets, () =>
      Effect.fail(tokenEndpointFailure(ID, 400, '{"error":"invalid_grant"}')),
    );
    const error = yield* dead.api(ID, GET).pipe(Effect.flip);
    assert.strictEqual(error._tag === "AuthError" && error.reason, "token_revoked");
  }),
);

it.effect("a failed rotated-token write keeps the old token and retries the write", () =>
  Effect.gen(function* () {
    const keychain = fakeKeychain("old");
    // The node keychain layer already retried; this is the final failure.
    keychain.state.writeFails = 1;
    const used: string[] = [];
    let n = 0;
    const http = yield* providerHttp(keychain.secrets, (current) =>
      Effect.sync(() => {
        used.push(current);
        n++;
        return { ...token(`access-${n}`, `rotated-${n}`), expiresIn: 30 };
      }),
    );
    assert.deepStrictEqual(yield* http.api(ID, GET), { ok: true });
    // The keychain still holds the old token, which stays valid for consumer accounts.
    assert.strictEqual(keychain.state.value, "old");
    // The access token is near expiry, so the next request refreshes with the newest
    // token and first stores it.
    assert.deepStrictEqual(yield* http.api(ID, GET), { ok: true });
    assert.deepStrictEqual(used, ["old", "rotated-1"]);
    assert.deepStrictEqual(keychain.state.writes, ["rotated-1", "rotated-2"]);
    assert.strictEqual(keychain.state.value, "rotated-2");
  }),
);

it.effect("a token rotated while the account was being removed is not written back", () =>
  Effect.gen(function* () {
    const keychain = fakeKeychain("r1");
    const http = yield* providerHttp(keychain.secrets, () =>
      Effect.sync(() => {
        // Removing the account deletes its keychain item while the refresh is in flight.
        keychain.state.value = undefined;
        return token("access", "r2");
      }),
    );
    assert.isTrue(yield* http.keepAlive(ID, KEEP_ALIVE_MAX_AGE_MS));
    assert.isUndefined(keychain.state.value);
    assert.deepStrictEqual(keychain.state.writes, []);
  }),
);

it.effect("keep-alive refreshes an idle account once its last refresh is old enough", () =>
  Effect.gen(function* () {
    const { secrets } = fakeKeychain("refresh");
    let refreshes = 0;
    const http = yield* providerHttp(secrets, () => Effect.sync(() => token(`a${++refreshes}`)));
    assert.isTrue(yield* http.keepAlive(ID, KEEP_ALIVE_MAX_AGE_MS));
    assert.isFalse(yield* http.keepAlive(ID, KEEP_ALIVE_MAX_AGE_MS));
    yield* TestClock.adjust(KEEP_ALIVE_MAX_AGE_MS - 1);
    assert.isFalse(yield* http.keepAlive(ID, KEEP_ALIVE_MAX_AGE_MS));
    yield* TestClock.adjust(1);
    assert.isTrue(yield* http.keepAlive(ID, KEEP_ALIVE_MAX_AGE_MS));
    assert.strictEqual(refreshes, 2);
  }),
);

const oauthAccount = (provider: Account["provider"], extra: Partial<Account> = {}): Account => ({
  id: `${provider}:me@example.com`,
  provider,
  email: "me@example.com",
  createdAt: 0,
  lastSyncedAt: null,
  lastSyncError: null,
  profileId: null,
  needsReauth: false,
  ...extra,
});

it.effect("the keep-alive loop refreshes every account about weekly without syncing", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const marked: string[] = [];
    const accounts = [
      oauthAccount("outlook"),
      oauthAccount("gmail", { enabled: false }),
      oauthAccount("imap"),
      { ...oauthAccount("outlook"), id: "outlook:gone@example.com", needsReauth: true },
    ];
    const last = new Map<string, number>();
    const providers: KeepAliveProviders = {
      get: (provider) => ({
        keepAlive: (id: string, maxAge: number) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            if (now - (last.get(id) ?? -Infinity) < maxAge) return false;
            last.set(id, now);
            calls.push(`${provider} ${now}`);
            return true;
          }),
      }),
    };
    const store = {
      listAccounts: Effect.succeed(accounts),
      markReauth: (id: string, _error: AuthError) => Effect.sync(() => void marked.push(id)),
    };
    const fiber = yield* Effect.forkChild(runTokenKeepAlive(store, providers, Effect.void));
    yield* TestClock.adjust("1 minute");
    assert.deepStrictEqual(calls, ["outlook 60000", "gmail 60000"]);
    calls.length = 0;
    yield* TestClock.adjust(5 * DAY);
    assert.deepStrictEqual(calls, []);
    yield* TestClock.adjust(1.5 * DAY);
    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(marked, []);
    yield* Fiber.interrupt(fiber);
  }),
);

it.effect("keep-alive marks only a definitive failure", () =>
  Effect.gen(function* () {
    const marked: string[] = [];
    const failures: (AuthError | ProviderError)[] = [
      new ProviderError({ message: "offline", status: 0 }),
      keychainLocked(),
      new AuthError({ accountId: ID, message: "revoked", reason: "token_revoked" }),
    ];
    const providers: KeepAliveProviders = {
      get: () => ({
        keepAlive: () => Effect.suspend(() => Effect.fail(failures.shift() ?? keychainLocked())),
      }),
    };
    const store = {
      listAccounts: Effect.succeed([oauthAccount("outlook")]),
      markReauth: (_id: string, error: AuthError) =>
        Effect.sync(() => void marked.push(error.reason ?? "")),
    };
    for (let pass = 0; pass < 3; pass++) yield* keepTokensAlive(store, providers, Effect.void);
    assert.deepStrictEqual(marked, ["token_revoked"]);
  }),
);

it("Node and mobile share one rule for a final login refusal", () => {
  assert.isTrue(isLoginRefusal({ imapCode: "AUTHENTICATIONFAILED" }));
  assert.isTrue(isLoginRefusal({}));
  assert.isFalse(isLoginRefusal({ imapCode: "unavailable" }));
  assert.isTrue(isLoginRefusal({ smtpCode: 535 }));
  assert.isFalse(isLoginRefusal({ smtpCode: 454 }));
});

it("IMAP: only a refused login after connecting is imap_auth_failed", () => {
  const login = (code?: string) =>
    Object.assign(new Error("LOGIN failed"), {
      authenticationFailed: true,
      ...(code ? { serverResponseCode: code } : {}),
    });
  assert.isTrue(isAuthFailure(login("AUTHENTICATIONFAILED")));
  assert.isTrue(isAuthFailure(login()));
  assert.isFalse(isAuthFailure(login("UNAVAILABLE")));
  assert.isFalse(isAuthFailure(login("INUSE")));
  assert.isTrue(isAuthFailure({ code: "EAUTH", responseCode: 535 }));
  assert.isFalse(isAuthFailure({ code: "EAUTH", responseCode: 454 }));
  const refused = imapFailure(ID, "imap.example.com", login("AUTHENTICATIONFAILED"));
  assert.strictEqual(refused._tag === "AuthError" && refused.reason, "imap_auth_failed");
  for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ETIMEDOUT"]) {
    const dropped = imapFailure(ID, "imap.example.com", Object.assign(new Error(code), { code }));
    assert.strictEqual(dropped._tag, "ProviderError", code);
  }
});

it("IMAP and SMTP connection failures name the setting to check", () => {
  const coded = (code: string, message = code) => Object.assign(new Error(message), { code });
  const cases: [unknown, string | undefined][] = [
    [coded("ENOTFOUND", "getaddrinfo ENOTFOUND imap.example.con"), "dns"],
    [coded("EAI_AGAIN"), "dns"],
    [coded("EDNS", "queryA ENOTFOUND smtp.example.con"), "dns"],
    [coded("ECONNREFUSED"), "refused"],
    [coded("ESOCKET", "connect ECONNREFUSED 127.0.0.1:465"), "refused"],
    [coded("ETIMEOUT", "Failed to establish connection in required time"), "timeout"],
    [coded("ETIMEDOUT"), "timeout"],
    [coded("ERR_SSL_WRONG_VERSION_NUMBER", "wrong version number"), "tls"],
    [coded("ESOCKET", "write EPROTO 00:error:SSL routines:wrong version number"), "tls"],
    [coded("ETLS", "Error initiating TLS"), "tls"],
    [coded("CERT_HAS_EXPIRED", "certificate has expired"), "tls"],
    [new Error("Unexpected close"), undefined],
    [
      coded("ECONNRESET", "socket disconnected before secure TLS connection was established"),
      "unreachable",
    ],
    [{ responseText: "Unsafe Login. Please contact kefu@188.com for help" }, "unsafe_login"],
  ];
  for (const [error, reason] of cases) {
    const mapped = imapFailure(ID, "imap.example.com", error);
    assert.strictEqual(mapped._tag, "ProviderError");
    assert.strictEqual(mapped._tag === "ProviderError" ? mapped.reason : "", reason, String(error));
  }
});

it.effect("marking an account records its reason once, logs it, and a sign-in clears it", () => {
  const records: unknown[] = [];
  const logger = Logger.make((options) => {
    records.push(...(Array.isArray(options.message) ? options.message : [options.message]));
  });
  return Effect.gen(function* () {
    const store = yield* Store;
    const account = yield* store.upsertAccount("gmail", "me@gmail.com");
    const expired = new AuthError({ message: "expired", reason: "testing_mode_expiry" });
    yield* store.markReauth(account.id, expired);
    yield* store.markReauth(account.id, expired);
    const marked = yield* store.getAccount(account.id);
    assert.isTrue(marked.needsReauth);
    assert.strictEqual(marked.reauthReason, "testing_mode_expiry");
    yield* store.clearReauth(account.id);
    const cleared = yield* store.getAccount(account.id);
    assert.isFalse(cleared.needsReauth);
    assert.isUndefined(cleared.reauthReason);

    const logged = records.filter((record) => Schema.is(ReauthDiagnostic)(record));
    assert.strictEqual(logged.length, 1);
    const record = diagnosticRecord("reauth", logged[0], 0);
    assert.deepStrictEqual(record, {
      at: 0,
      event: "reauth",
      provider: "gmail",
      reason: "testing_mode_expiry",
      accountHash: sha256Hex(account.id).slice(0, 16),
    });
    assert.notInclude(JSON.stringify(record), "me@gmail.com");
  }).pipe(
    Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform()))),
    Effect.provide(Logger.layer([logger])),
  );
});

it.effect("a locked keychain during sync shows the keychain state and never marks reauth", () => {
  const locked = fakeKeychain("refresh");
  locked.state.readFails = Infinity;
  locked.state.writeFails = Infinity;
  const adapter = Layer.effect(
    Providers,
    makeOutlook.pipe(Effect.map((made) => ({ get: () => made }))),
  );
  return Effect.gen(function* () {
    const m = yield* Mailbox;
    const store = yield* Store;
    const account = yield* store.upsertAccount("outlook", "me@outlook.com");
    const sync = yield* Effect.forkChild(m.sync(account.id));
    yield* TestClock.adjust("1 minute");
    const [result] = yield* Fiber.join(sync);
    assert.strictEqual(result?.error, KEYCHAIN_LOCKED_MESSAGE);
    assert.isUndefined(result?.needsReauth);
    const after = yield* store.getAccount(account.id);
    assert.isFalse(after.needsReauth);
    assert.strictEqual(after.lastSyncError, KEYCHAIN_LOCKED_MESSAGE);
  }).pipe(
    Effect.provide(
      MailboxLive({ backgroundFlush: false, imapIdle: false }).pipe(
        Layer.provideMerge(
          Layer.mergeAll(StoreLive, adapter).pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                fakeHttp({}).layer,
                MemoryPlatform({ config: { microsoft: { clientId: "client" } } }),
                Layer.succeed(Secrets, locked.secrets),
              ),
            ),
          ),
        ),
      ),
    ),
  );
});

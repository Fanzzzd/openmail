import { fakeHttp } from "../../platform/node/fake-http.js";
import { assert, it } from "@effect/vitest";
import { parseCalendar } from "../../calendar/invites.js";
import { Cause, Clock, Deferred, Effect, Fiber, Layer, Option, Stream } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { makeGmail } from "./gmail.js";
import { ProviderError } from "../../domain/errors.js";
import { MemoryPlatform } from "../../platform/node/platform-memory.js";
import { account, run, b64, revoke } from "../../../test-support/gmail-fixtures.js";
it.effect("write scope failures do not require mail reauthentication", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "POST /messages/scope/modify": {
        status: 403,
        json: { error: { message: "Request had insufficient authentication scopes." } },
      },
      "POST /messages/gone/modify": { status: 404, json: { error: { code: 404 } } },
    });
    const [scope, gone] = yield* run(http, (a) =>
      Effect.all([
        Effect.flip(a.push(account, "scope", { kind: "archive" })),
        Effect.flip(a.push(account, "gone", { kind: "archive" })),
      ]),
    );
    assert.strictEqual(scope._tag, "ProviderError");
    assert.strictEqual(gone._tag, "PermanentError");
  }),
);

it.effect("a dropped connection is retried, not reported", () =>
  Effect.gen(function* () {
    let calls = 0;
    // Fails once at the transport level, then answers.
    const client = HttpClient.make((request) =>
      Effect.suspend(() =>
        ++calls <= 1
          ? Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request, description: "offline" }),
              }),
            )
          : Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response(JSON.stringify({ raw: b64("hi") }))),
            ),
      ),
    );
    const http = { layer: Layer.succeed(HttpClient.HttpClient)(client), calls: [] };
    yield* run(http, (adapter) =>
      Effect.gen(function* () {
        const fiber = yield* adapter.fetchRaw(account, "m1").pipe(Effect.forkChild);
        yield* TestClock.adjust("2 seconds");
        assert.strictEqual(Buffer.from(yield* Fiber.join(fiber)).toString(), "hi");
      }),
    );
    assert.strictEqual(calls, 2);
  }),
);

it.effect("missing Gmail settings scope is separate from mail authentication", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /settings/filters": {
        status: 403,
        json: { error: "insufficient authentication scopes" },
      },
      "GET /messages/m1": { json: { raw: b64("mail still works") } },
    });
    yield* run(http, (a) =>
      Effect.gen(function* () {
        const error = yield* a.filters(account).pipe(Effect.flip);
        assert.strictEqual(error._tag, "SettingsScopeMissing");
        assert.strictEqual(
          Buffer.from(yield* a.fetchRaw(account, "m1")).toString(),
          "mail still works",
        );
      }),
    );
  }),
);

it.effect("Gmail sign-in requests base mail scopes only", () => {
  const http = fakeHttp({
    "GET /profile": { json: { emailAddress: account.email, historyId: "1" } },
  });
  return makeGmail.pipe(
    Effect.flatMap((a) => a.connect({ provider: "gmail" })),
    Effect.provide(
      Layer.mergeAll(
        http.layer,
        MemoryPlatform({
          config: { google: { clientId: "client", clientSecret: "secret" } },
          oauth: {
            authorize: (req) =>
              Effect.sync(() => {
                assert.isFalse(
                  req.scopes.includes("https://www.googleapis.com/auth/gmail.settings.basic"),
                );
                assert.strictEqual(req.scopes[0], "https://www.googleapis.com/auth/gmail.modify");
                assert.isFalse(req.scopes.includes("https://mail.google.com/"));
                assert.deepStrictEqual(req.scopes, [
                  "https://www.googleapis.com/auth/gmail.modify",
                  "https://www.googleapis.com/auth/gmail.send",
                ]);
                for (const scope of [
                  "calendar.events",
                  "contacts.readonly",
                  "contacts.other.readonly",
                ])
                  assert.isFalse(req.scopes.includes(`https://www.googleapis.com/auth/${scope}`));
                return {
                  accessToken: "access-token",
                  refreshToken: Option.some("refresh-token"),
                  expiresIn: 3600,
                };
              }),
          },
        }),
      ),
    ),
  );
});

it.effect(
  "Gmail permanent deletion consent adds only full-mail scope with incremental authorization on the user's client",
  () => {
    const scopes = [
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.send",
      "https://mail.google.com/",
    ];
    const http = fakeHttp({
      "GET /profile": { json: { emailAddress: account.email, historyId: "1" } },
    });
    return makeGmail.pipe(
      Effect.flatMap((adapter) =>
        adapter.connect({
          provider: "gmail",
          loginHint: account.email,
          feature: "permanentDelete",
        }),
      ),
      Effect.tap((connected) =>
        Effect.sync(() => assert.deepStrictEqual(connected.scopes, scopes)),
      ),
      Effect.provide(
        Layer.mergeAll(
          http.layer,
          MemoryPlatform({
            config: { google: { clientId: "own-client", clientSecret: "own-secret" } },
            oauth: {
              authorize: (request) =>
                Effect.sync(() => {
                  assert.deepStrictEqual(request.scopes, scopes);
                  assert.strictEqual(
                    request.authUrl,
                    "https://accounts.google.com/o/oauth2/v2/auth",
                  );
                  assert.strictEqual(request.clientId, "own-client");
                  assert.strictEqual(request.clientSecret, "own-secret");
                  assert.strictEqual(request.extraParams?.include_granted_scopes, "true");
                  assert.strictEqual(request.extraParams?.login_hint, account.email);
                  return {
                    accessToken: "access-token",
                    refreshToken: Option.some("refresh-token"),
                    expiresIn: 3600,
                    scopes,
                  };
                }),
            },
          }),
        ),
      ),
    );
  },
);

it.effect(
  "send-as scope failure is cached without refreshing mail tokens, until that account reauthenticates",
  () => {
    let authorized = false;
    let refreshes = 0;
    const http = fakeHttp({
      "GET /settings/sendAs": () =>
        authorized
          ? { json: { sendAs: [] } }
          : { status: 403, json: { error: "insufficient authentication scopes" } },
      "GET /messages/m1": { json: { raw: b64("still reads") } },
      "GET /profile": { json: { emailAddress: account.email, historyId: "1" } },
    });
    const platform = MemoryPlatform({
      secrets: { [account.id]: "refresh-token" },
      config: { google: { clientId: "client", clientSecret: "secret" } },
      oauth: {
        refresh: () =>
          Effect.sync(() => {
            refreshes++;
            return {
              accessToken: "access-token",
              refreshToken: Option.some("refresh-token"),
              expiresIn: 3600,
            };
          }),
      },
    });
    return makeGmail.pipe(
      Effect.flatMap((a) =>
        Effect.gen(function* () {
          assert.strictEqual(
            (yield* a.sendAs(account).pipe(Effect.flip))._tag,
            "SettingsScopeMissing",
          );
          yield* a.fetchRaw(account, "m1");
          assert.strictEqual(
            (yield* a.sendAs(account).pipe(Effect.flip))._tag,
            "SettingsScopeMissing",
          );
          assert.strictEqual(
            http.calls.filter((c) => c.url.pathname.endsWith("/settings/sendAs")).length,
            1,
          );
          assert.strictEqual(refreshes, 1);
          authorized = true;
          yield* a.connect({ provider: "gmail" });
          assert.deepStrictEqual(yield* a.sendAs(account), []);
          assert.strictEqual(
            http.calls.filter((c) => c.url.pathname.endsWith("/settings/sendAs")).length,
            2,
          );
        }),
      ),
      Effect.provide(Layer.mergeAll(http.layer, platform)),
    );
  },
);

it.effect("optional Gmail scopes produce feature-specific errors without mail AuthError", () =>
  Effect.gen(function* () {
    const [parsed] = parseCalendar(
      "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:uid\r\nDTSTART:20261001T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR",
    );
    assert.ok(parsed);
    const http = fakeHttp({
      "GET /v1/people/me/connections": {
        status: 403,
        json: { error: "insufficient authentication scopes" },
      },
      "GET /calendar/v3/calendars/primary/events": {
        status: 403,
        json: { error: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" },
      },
    });
    const contacts = yield* run(http, (a) => a.contacts(account)).pipe(Effect.result);
    assert.strictEqual(contacts._tag, "Failure");
    if (contacts._tag === "Failure") {
      assert.strictEqual(contacts.failure._tag, "FeatureScopeMissing");
      if (contacts.failure._tag === "FeatureScopeMissing")
        assert.strictEqual(contacts.failure.feature, "contacts");
    }
    const response = yield* run(http, (a) =>
      a.respondInvite(account, "m", parsed.invite, "accepted"),
    ).pipe(Effect.result);
    assert.strictEqual(response._tag, "Failure");
    if (response._tag === "Failure") {
      assert.strictEqual(response.failure._tag, "FeatureScopeMissing");
      if (response.failure._tag === "FeatureScopeMissing")
        assert.strictEqual(response.failure.feature, "calendar");
    }
  }),
);

it.effect(
  "disabled People API is a provider setup error, not a request for more OAuth grants",
  () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        "GET /v1/people/me/connections": {
          status: 403,
          json: {
            error: { status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] },
          },
        },
      });
      const result = yield* run(http, (a) => a.contacts(account)).pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") assert.strictEqual(result.failure._tag, "ProviderError");
    }),
);

it.effect(
  "Gmail settings accepts empty filter lists and keeps permission failures typed before decoding",
  () =>
    Effect.gen(function* () {
      for (const reply of [{ json: {} }, { json: { filter: [] } }, { json: null }, {}]) {
        const http = fakeHttp({ "GET /settings/filters": reply });
        assert.deepStrictEqual(yield* run(http, (a) => a.filters(account)), []);
      }
      for (const reply of [
        {
          status: 403,
          json: {
            error: {
              code: 403,
              message: "Request had insufficient authentication scopes.",
              status: "PERMISSION_DENIED",
            },
          },
        },
        { status: 403 },
        { status: 403, json: { error: { code: 403, message: "Forbidden" } } },
      ]) {
        const http = fakeHttp({
          "GET /settings/filters": reply,
          "GET /messages/m1": { json: { raw: b64("mail remains readable") } },
        });
        yield* run(http, (a) =>
          Effect.gen(function* () {
            const error = yield* a.filters(account).pipe(Effect.flip);
            assert.strictEqual(error._tag, "SettingsScopeMissing");
            assert.strictEqual(
              Buffer.from(yield* a.fetchRaw(account, "m1")).toString(),
              "mail remains readable",
            );
          }),
        );
      }
    }),
);

it.effect(
  "Gmail settings does not misclassify API disablement or quota errors as missing scopes",
  () =>
    Effect.gen(function* () {
      for (const body of [
        "SERVICE_DISABLED: PERMISSION_DENIED",
        "dailyLimitExceeded: forbidden",
        "rateLimitExceeded: Forbidden",
      ]) {
        const http = fakeHttp({ "GET /settings/filters": { status: 403, json: { error: body } } });
        yield* run(http, (adapter) =>
          Effect.gen(function* () {
            const request = yield* adapter.filters(account).pipe(Effect.flip, Effect.forkChild);
            yield* TestClock.adjust("1 minute");
            assert.strictEqual((yield* Fiber.join(request))._tag, "ProviderError");
          }),
        );
      }
    }),
);

it.effect(
  "permanent deletion reports missing full-mail scope without pausing mail authentication",
  () => {
    const http = fakeHttp({
      "POST /token": { json: { access_token: "token", expires_in: 3600 } },
      "POST /messages/batchDelete": {
        status: 403,
        json: { error: { message: "insufficient authentication scopes" } },
      },
      "GET /messages/a": { json: { labelIds: ["TRASH"] } },
    });
    return run(http, (adapter) =>
      Effect.gen(function* () {
        const result = yield* adapter
          .permanentlyDelete(account, ["a"], "trash")
          .pipe(Effect.result);
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure")
          assert.strictEqual(result.failure._tag, "FeatureScopeMissing");
      }),
    );
  },
);

for (const date of [false, true])
  it.effect(`Retry-After ${date ? "HTTP date" : "seconds"} delays provider retries`, () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      let requests = 0;
      const http = fakeHttp({
        "POST /messages/m/modify": () =>
          ++requests === 1
            ? {
                status: 429,
                headers: { "Retry-After": date ? new Date(now + 5000).toUTCString() : "5" },
              }
            : { json: {} },
      });
      yield* run(http, (a) =>
        Effect.gen(function* () {
          const fiber = yield* a
            .push(account, "m", { kind: "read", value: true })
            .pipe(Effect.forkChild);
          yield* TestClock.adjust("2 seconds");
          assert.strictEqual(requests, 1);
          yield* TestClock.adjust("3 seconds");
          yield* Fiber.join(fiber);
          assert.strictEqual(requests, 2);
        }),
      );
    }),
  );

it.effect("a Retry-After over sixty seconds returns to the next sync", () =>
  Effect.gen(function* () {
    let calls = 0;
    const http = fakeHttp({
      "POST /messages/m/modify": () =>
        ++calls === 1 ? { status: 429, headers: { "Retry-After": "61" } } : { json: {} },
    });
    const result = yield* run(http, (a) =>
      Effect.gen(function* () {
        const fiber = yield* a
          .push(account, "m", { kind: "read", value: true })
          .pipe(Effect.result, Effect.forkChild);
        yield* TestClock.adjust("62 seconds");
        return yield* Fiber.join(fiber);
      }),
    );
    assert.strictEqual(result._tag, "Failure");
    assert.strictEqual(calls, 1);
    if (result._tag === "Failure") {
      assert.strictEqual(result.failure._tag, "ProviderError");
      if (result.failure._tag === "ProviderError")
        assert.strictEqual(result.failure.deferred, true);
    }
  }),
);

it.effect("a missing OAuth client is configuration failure, never a status-zero AuthError", () => {
  const http = fakeHttp({});
  return makeGmail.pipe(
    Effect.flatMap((adapter) => adapter.fetchRaw(account, "fake").pipe(Effect.flip)),
    Effect.map((error) => {
      assert.strictEqual(error._tag, "ProviderError");
      assert.strictEqual(http.calls.length, 0);
    }),
    Effect.provide(
      Layer.mergeAll(
        http.layer,
        MemoryPlatform({ secrets: { [account.id]: "fake-refresh" }, config: {} }),
      ),
    ),
  );
});

for (const failure of ["offline", "AbortError"]) {
  it.effect(`gmail status-zero ${failure} GET retries once and remains ProviderError`, () =>
    Effect.gen(function* () {
      let calls = 0;
      const client = HttpClient.make((request) =>
        Effect.suspend(() => {
          calls++;
          return Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request, description: failure }),
            }),
          );
        }),
      );
      const http = { layer: Layer.succeed(HttpClient.HttpClient, client), calls: [] };
      yield* run(http, (adapter) =>
        Effect.gen(function* () {
          const fiber = yield* adapter
            .fetchRaw(account, "fake")
            .pipe(Effect.flip, Effect.forkChild);
          yield* TestClock.adjust("2 seconds");
          const error = yield* Fiber.join(fiber);
          assert.strictEqual(error._tag, "ProviderError");
          if (error._tag === "ProviderError") assert.strictEqual(error.status, 0);
        }),
      );
      assert.strictEqual(calls, 2);
    }),
  );
}

it.effect("gmail interruption aborts the GET and never retries or returns AuthError", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let signal: AbortSignal | undefined;
    let attempts = 0;
    const client = HttpClient.make((_request, _url, abort) =>
      Effect.gen(function* () {
        signal = abort;
        attempts++;
        yield* Deferred.succeed(started, undefined);
        return yield* Effect.never;
      }),
    );
    const http = { layer: Layer.succeed(HttpClient.HttpClient, client), calls: [] };
    yield* run(http, (adapter) =>
      Effect.gen(function* () {
        const fiber = yield* adapter.fetchRaw(account, "fake").pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        const exit = yield* Fiber.await(fiber);
        assert.strictEqual(exit._tag, "Failure");
        if (exit._tag === "Failure") assert.isTrue(Cause.hasInterruptsOnly(exit.cause));
      }),
    );
    assert.isTrue(signal?.aborted);
    assert.strictEqual(attempts, 1);
  }),
);

it.effect(
  "offline Gmail refresh failures back off across background readers and reset on wake",
  () => {
    let refreshes = 0;
    const http = fakeHttp({});
    return makeGmail.pipe(
      Effect.flatMap((adapter) =>
        Effect.gen(function* () {
          for (let tick = 0; tick < 8; tick++)
            yield* adapter.folderStatus(account, "INBOX").pipe(Effect.result);
          assert.strictEqual(refreshes, 1);
          yield* TestClock.adjust("5 seconds");
          yield* adapter.folderStatus(account, "INBOX").pipe(Effect.result);
          assert.strictEqual(refreshes, 2);
          yield* TestClock.adjust("5 seconds");
          yield* adapter.fetchCachedHeaders?.(account, ["a"]).pipe(Effect.result) ?? Effect.void;
          assert.strictEqual(refreshes, 2);
          yield* adapter.resetConnectivity?.() ?? Effect.void;
          yield* adapter.folderStatus(account, "INBOX").pipe(Effect.result);
          assert.strictEqual(refreshes, 3);
        }),
      ),
      Effect.provide(
        Layer.mergeAll(
          http.layer,
          MemoryPlatform({
            secrets: { [account.id]: "refresh-token" },
            config: { google: { clientId: "client", clientSecret: "secret" } },
            oauth: {
              refresh: () =>
                Effect.suspend(() => {
                  refreshes++;
                  return Effect.fail(new ProviderError({ message: "Offline", status: 0 }));
                }),
            },
          }),
        ),
      ),
    );
  },
);

it.effect("Gmail's per-user rate limit 403 is a quota failure, not a refusal", () =>
  Effect.gen(function* () {
    const body = {
      error: {
        code: 403,
        message: "Quota exceeded for quota metric 'Queries'",
        errors: [{ reason: "rateLimitExceeded" }],
        details: [{ metadata: { quota_limit: "totalQueryCostPerMinutePerUser" } }],
      },
    };
    let calls = 0;
    const http = fakeHttp({
      "GET /labels": () => {
        calls++;
        return { status: 403, json: body };
      },
    });
    const fiber = yield* Effect.forkChild(
      run(http, (a) => Stream.runCollect(a.pull(account, Option.some("1")))).pipe(Effect.flip),
    );
    for (let second = 0; second < 90; second++) yield* TestClock.adjust("1 second");
    const error = yield* Fiber.join(fiber);
    assert.strictEqual(error._tag, "ProviderError");
    assert.ok(error._tag === "ProviderError" && error.reason === "quota");
    assert.isAbove(calls, 1);
  }),
);

it.effect("account removal revokes the grant by posting the refresh token as a form", () => {
  const http = fakeHttp({ "POST /revoke": { status: 200 } });
  return run(http, revoke).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        assert.strictEqual(http.calls.length, 1);
        const [call] = http.calls;
        assert.ok(call);
        assert.strictEqual(call.url.href, "https://oauth2.googleapis.com/revoke");
        assert.strictEqual(call.contentType, "application/x-www-form-urlencoded");
        assert.deepStrictEqual(Object.fromEntries(new URLSearchParams(String(call.body))), {
          token: "refresh-token",
        });
      }),
    ),
  );
});

it.effect("a refused or unreachable revocation fails without the token in the error", () =>
  Effect.gen(function* () {
    for (const reply of [{ status: 400 }, { fault: "ENOTFOUND" as const }]) {
      const http = fakeHttp({ "POST /revoke": reply });
      const result = yield* run(http, revoke).pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      assert.notInclude(JSON.stringify(result), "refresh-token");
    }
  }),
);

it.effect("a stalled revocation times out", () =>
  Effect.gen(function* () {
    const stalled = fakeHttp({ "POST /revoke": { fault: "stall-headers" } });
    const result = yield* run(stalled, (adapter) =>
      Effect.gen(function* () {
        const fiber = yield* revoke(adapter).pipe(Effect.result, Effect.forkChild);
        yield* TestClock.adjust("5 seconds");
        return yield* Fiber.join(fiber);
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

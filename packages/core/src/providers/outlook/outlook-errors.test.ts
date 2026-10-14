import { assert, it } from "@effect/vitest";
import { ProviderError } from "../../domain/errors.js";
import { fakeHttp } from "../../platform/node/fake-http.js";
import { Cause, Clock, Deferred, Effect, Fiber, Layer, Option, Stream } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { makeOutlook } from "./outlook.js";
import { MemoryPlatform } from "../../platform/node/platform-memory.js";
import { Secrets } from "../../platform/auth.js";
import {
  GRAPH,
  account,
  platformOptions,
  run,
  raw,
  mailbox,
} from "../../../test-support/outlook-fixtures.js";
it.effect("403 access denial and 404 are permanent on writes; reads remain retryable", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "PATCH /me/messages/denied": { status: 403, json: { error: { code: "ErrorAccessDenied" } } },
      "PATCH /me/messages/gone": { status: 404, json: { error: { code: "ErrorItemNotFound" } } },
      "GET /me/mailFolders/inbox": { status: 403, json: { error: { code: "ErrorAccessDenied" } } },
    });
    const [write, gone, read] = yield* run(http, (a) =>
      Effect.all([
        Effect.flip(a.push(account, "denied", { kind: "read", value: true })),
        Effect.flip(a.push(account, "gone", { kind: "read", value: true })),
        Effect.flip(Stream.runDrain(a.pull(account, Option.none()))),
      ]),
    );
    assert.strictEqual(write._tag, "PermanentError");
    assert.strictEqual(gone._tag, "PermanentError");
    assert.strictEqual(read._tag, "ProviderError");
  }),
);

it.effect("a rejected access token is refreshed and the request retried once", () =>
  Effect.gen(function* () {
    let patches = 0;
    const http = fakeHttp({
      "PATCH /me/messages/p": () => (++patches === 1 ? { status: 401, json: {} } : { json: {} }),
      "PATCH /me/messages/never": { status: 401, json: {} },
    });
    const refused = yield* run(http, (a) =>
      a
        .push(account, "p", { kind: "read", value: true })
        .pipe(Effect.andThen(Effect.flip(a.push(account, "never", { kind: "read", value: true })))),
    );
    assert.strictEqual(patches, 2);
    // A token that is still refused after a fresh one means signing in again.
    assert.strictEqual(refused._tag, "AuthError");
    assert.strictEqual(http.calls.filter((c) => c.url.pathname.endsWith("/never")).length, 2);
  }),
);

it.effect("raw MIME reads refresh a 401 once and classify a second 401 as AuthError", () =>
  Effect.gen(function* () {
    let calls = 0;
    const http = fakeHttp({
      "GET /me/messages/raw/$value": () =>
        ++calls === 1 ? { status: 401 } : { text: "readable MIME" },
      "GET /me/messages/denied/$value": { status: 401 },
    });
    yield* run(http, (adapter) =>
      Effect.gen(function* () {
        assert.strictEqual(
          new TextDecoder().decode(yield* adapter.fetchRaw(account, "raw")),
          "readable MIME",
        );
        assert.strictEqual(
          (yield* adapter.fetchRaw(account, "denied").pipe(Effect.flip))._tag,
          "AuthError",
        );
      }),
    );
    assert.strictEqual(calls, 2);
  }),
);

it.effect(
  "optional internetMessageHeaders denial falls back to mail reads and remembers the capability",
  () => {
    const http = fakeHttp({
      "GET /me/messages/m1": (url) =>
        url.searchParams.get("$select")?.includes("internetMessageHeaders")
          ? { status: 403 }
          : { json: { ...raw, id: "m1", hasAttachments: false, parentFolderId: "inbox" } },
    });
    return run(http, (adapter) =>
      Effect.gen(function* () {
        for (let i = 0; i < 2; i++)
          assert.strictEqual((yield* adapter.fetchMessage(account, "m1")).providerId, "m1");
        const reads = http.calls.filter((call) => call.url.pathname === "/v1.0/me/messages/m1");
        assert.strictEqual(reads.length, 3);
        assert.strictEqual(
          reads.filter((call) =>
            call.url.searchParams.get("$select")?.includes("internetMessageHeaders"),
          ).length,
          1,
        );
      }),
    );
  },
);

it.effect("optional Graph 403s stay disabled without invalidating the mail token", () => {
  const http = fakeHttp({
    "GET /me/mailboxSettings/automaticRepliesSetting": { status: 403 },
    "GET /me/contacts": { status: 403 },
    "GET /me/calendarView": { status: 403 },
    "GET /me/messages/m1/$value": { text: "mail" },
  });
  let refreshes = 0;
  return run(
    http,
    (adapter) =>
      Effect.gen(function* () {
        for (let i = 0; i < 2; i++) {
          assert.strictEqual(
            (yield* adapter.vacation(account).pipe(Effect.flip))._tag,
            "SettingsScopeMissing",
          );
          assert.strictEqual(
            (yield* adapter.contacts(account).pipe(Effect.flip))._tag,
            "FeatureScopeMissing",
          );
          assert.strictEqual(
            (yield* (
              adapter.calendarEvents
                ? adapter.calendarEvents(account, {
                    key: "test",
                    title: "test",
                    start: { kind: "date", value: "2026-10-03" },
                    end: { kind: "date", value: "2026-10-04" },
                    location: "",
                    description: "",
                    recurrence: [],
                  })
                : Effect.die("missing calendar")
            ).pipe(Effect.flip))._tag,
            "FeatureScopeMissing",
          );
        }
        yield* adapter.fetchRaw(account, "m1");
        assert.strictEqual(refreshes, 1);
        for (const path of ["/me/mailboxSettings", "/me/contacts", "/me/calendarView"])
          assert.strictEqual(
            http.calls.filter((call) => call.url.pathname.startsWith(`/v1.0${path}`)).length,
            1,
          );
      }),
    {
      ...platformOptions,
      oauth: {
        refresh: () =>
          Effect.sync(() => {
            refreshes++;
            return { accessToken: "fake", refreshToken: Option.none(), expiresIn: 3600 };
          }),
      },
    },
  );
});

it.effect("a rotated refresh token is saved to the keychain", () =>
  Effect.gen(function* () {
    const http = fakeHttp({ "PATCH /me/messages/p": { json: {} } });
    const saved = yield* run(
      http,
      (a) =>
        Effect.gen(function* () {
          yield* a.push(account, "p", { kind: "read", value: true });
          return yield* (yield* Secrets).get(account.id);
        }),
      {
        ...platformOptions,
        tokens: { accessToken: "at", refreshToken: Option.some("rotated"), expiresIn: 3600 },
      },
    );
    assert.deepStrictEqual(saved, Option.some("rotated"));
  }),
);

for (const date of [false, true])
  it.effect(`Retry-After ${date ? "HTTP date" : "seconds"} delays provider retries`, () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      let requests = 0;
      const http = fakeHttp({
        "PATCH /me/messages/m": () =>
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

it.effect("Graph shares at most four requests per account across concurrent work", () =>
  Effect.gen(function* () {
    let active = 0,
      peak = 0;
    const client = HttpClient.make((request) =>
      Effect.gen(function* () {
        active++;
        peak = Math.max(peak, active);
        yield* Effect.sleep("1 second");
        active--;
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }));
      }),
    );
    yield* makeOutlook.pipe(
      Effect.flatMap((a) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.all(
            Array.from({ length: 12 }, (_, i) =>
              a.push(account, `m${i}`, { kind: "read", value: true }),
            ),
            { concurrency: "unbounded" },
          ).pipe(Effect.forkChild);
          yield* TestClock.adjust("4 seconds");
          yield* Fiber.join(fiber);
          assert.strictEqual(peak, 4);
        }),
      ),
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, client),
          MemoryPlatform(platformOptions),
        ),
      ),
    );
  }),
);

it.effect("Graph Retry-After dates over sixty seconds release the request", () =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    let calls = 0;
    const http = fakeHttp({
      "PATCH /me/messages/m": () =>
        ++calls === 1
          ? { status: 429, headers: { "Retry-After": new Date(now + 61000).toUTCString() } }
          : { status: 204 },
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
  }),
);

it.effect("a missing OAuth client is configuration failure, never a status-zero AuthError", () => {
  const http = fakeHttp({});
  return makeOutlook.pipe(
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
  it.effect(`outlook status-zero ${failure} GET retries once and remains ProviderError`, () =>
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

it.effect("outlook interruption aborts the GET and never retries or returns AuthError", () =>
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

for (const status of [403, 409, 413, 415, 422])
  it.effect(`Graph ${status} write rejection is permanent with a reason`, () => {
    const http = fakeHttp({
      "PATCH /me/messages/p": {
        status,
        json: {
          error: {
            code: status === 403 ? "ErrorAccessDenied" : "Rejected",
            message: "The server rejected this change",
          },
        },
      },
    });
    return run(http, (a) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(a.push(account, "p", { kind: "read", value: true }));
        assert.strictEqual(error._tag, "PermanentError");
        assert.include(error.message, "The server rejected this change");
      }),
    );
  });

it.effect("a failed Graph change exposes a short reason instead of JSON", () => {
  const http = fakeHttp({
    "PATCH /me/messages/p": {
      status: 403,
      json: {
        error: {
          code: "ErrorAccessDenied",
          message: "Access to this message is denied.",
          innerError: { requestId: "internal-id" },
        },
      },
    },
  });
  return run(http, (a) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(a.push(account, "p", { kind: "read", value: true }));
      assert.strictEqual(error.message, "Access to this message is denied.");
    }),
  );
});

it.effect("offline refresh failures share exponential backoff across all account reads", () => {
  let refreshes = 0;
  const http = fakeHttp(mailbox({}));
  return run(
    http,
    (adapter) =>
      Effect.gen(function* () {
        const read = () => adapter.folderStatus(account, "INBOX").pipe(Effect.result);
        for (let tick = 0; tick < 8; tick++) yield* read();
        assert.strictEqual(refreshes, 1);
        yield* TestClock.adjust("5 seconds");
        yield* read();
        assert.strictEqual(refreshes, 2);
        yield* TestClock.adjust("5 seconds");
        yield* read();
        assert.strictEqual(refreshes, 2);
        for (let second = 0; second < 3600; second += 10) {
          yield* TestClock.adjust("10 seconds");
          yield* read();
        }
        assert.isAtMost(refreshes, 20);
        const before = refreshes;
        yield* adapter.resetConnectivity?.() ?? Effect.void;
        yield* read();
        assert.strictEqual(refreshes, before + 1);
      }),
    {
      ...platformOptions,
      oauth: {
        refresh: () =>
          Effect.suspend(() => {
            refreshes++;
            return Effect.fail(new ProviderError({ message: "Offline", status: 0 }));
          }),
      },
    },
  );
});

it.effect("Graph Retry-After stops another read while the original retry sleeps", () =>
  Effect.gen(function* () {
    let reads = 0;
    const http = fakeHttp({
      "GET /me/messages/a": () =>
        ++reads === 1
          ? { status: 429, headers: { "Retry-After": "30" } }
          : { json: { ...raw, id: "a", parentFolderId: "id-inbox", hasAttachments: false } },
      "GET /me/messages/b": {
        json: { ...raw, id: "b", parentFolderId: "id-inbox", hasAttachments: false },
      },
      ...mailbox({}),
    });
    yield* run(http, (adapter) =>
      Effect.gen(function* () {
        const first = yield* adapter.fetchMessage(account, "a").pipe(Effect.forkChild);
        yield* TestClock.adjust("0 seconds");
        assert.strictEqual(reads, 1);
        const blocked = yield* adapter.fetchMessage(account, "b").pipe(Effect.result);
        assert.strictEqual(blocked._tag, "Failure");
        assert.isFalse(http.calls.some((call) => call.url.pathname.endsWith("/messages/b")));
        yield* TestClock.adjust("30 seconds");
        yield* Fiber.join(first);
        yield* adapter.fetchMessage(account, "b");
        assert.strictEqual(reads, 2);
      }),
    );
  }),
);

for (const paging of ["delta", "search", "folders"] as const) {
  for (const next of [
    "https://evil.test/steal",
    `${GRAPH}/users/other/messages`,
    `${GRAPH}/me/contacts`,
    "repeat",
  ]) {
    it.effect(`${paging} refuses ${next} before another bearer request`, () => {
      const base =
        paging === "delta"
          ? "/me/mailFolders/inbox/messages/delta"
          : paging === "search"
            ? "/me/messages"
            : "/me/mailFolders";
      const link = next === "repeat" ? `${GRAPH}${base}?$skiptoken=repeat` : next;
      const http = fakeHttp({
        ...mailbox({}),
        [`GET ${base}`]: { json: { value: [], "@odata.nextLink": link } },
      });
      return run(http, (adapter) =>
        Effect.gen(function* () {
          const result = yield* (
            paging === "delta"
              ? Stream.runCollect(adapter.pull(account, Option.none())).pipe(Effect.asVoid)
              : adapter.search(account, { search: "hello", limit: 20 }).pipe(Effect.asVoid)
          ).pipe(Effect.result);
          assert.strictEqual(result._tag, "Failure");
          assert.isTrue(
            http.calls.every((call) => call.url.origin === "https://graph.microsoft.com"),
          );
          assert.isFalse(
            http.calls.some(
              (call) =>
                call.url.pathname.startsWith("/users/") || call.url.pathname.endsWith("/contacts"),
            ),
          );
          assert.ok(http.calls.filter((call) => call.url.pathname === `/v1.0${base}`).length <= 2);
        }),
      );
    });
  }
}

it.effect("Outlook write errors retain Retry-After", () => {
  const http = fakeHttp({
    "PATCH /me/messages/p": { status: 429, headers: { "Retry-After": "90" } },
  });
  return run(http, (adapter) =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(adapter.push(account, "p", { kind: "read", value: true }));
      assert.strictEqual(failure._tag, "ProviderError");
      if (failure._tag === "ProviderError") assert.strictEqual(failure.retryAfter, "90");
    }),
  );
});

import { isDefiniteSendFailure } from "./provider-send.js";
import { assert, it } from "@effect/vitest";
import { Clock, Effect, Fiber } from "effect";
import {
  AuthError,
  InvalidInput,
  NotFound,
  PermanentError,
  ProviderError,
  SendUncertain,
} from "../domain/errors.js";
import { TestClock } from "effect/testing";
import { HttpClientRequest } from "effect/http";
import {
  requestNotSent,
  retryProvider,
  retryProviderRequest,
  uncertainWrite,
} from "./provider-retry.js";
it("connect failures are definite, but response timeouts remain uncertain", () => {
  for (const code of [
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNREFUSED",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "UND_ERR_CONNECT_TIMEOUT",
  ]) {
    const notSent = requestNotSent(new TypeError("fetch failed", { cause: { code } }));
    assert.isTrue(notSent);
    assert.isFalse(uncertainWrite({ status: 0, requestNotSent: notSent }));
  }
  for (const cause of [
    { code: "ECONNRESET" },
    { code: "ETIMEDOUT" },
    { code: "UND_ERR_HEADERS_TIMEOUT" },
    undefined,
  ]) {
    assert.isFalse(requestNotSent(cause));
    assert.isTrue(uncertainWrite({ status: 0, requestNotSent: requestNotSent(cause) }));
  }
});

for (const request of [
  HttpClientRequest.post("https://graph.microsoft.com/v1.0/me/messages/d/attachments"),
  HttpClientRequest.post("https://graph.microsoft.com/v1.0/me/messages"),
  HttpClientRequest.post("https://gmail.googleapis.com/gmail/v1/users/me/drafts"),
  HttpClientRequest.post("https://gmail.googleapis.com/gmail/v1/users/me/settings/filters"),
  HttpClientRequest.post("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messageRules"),
  HttpClientRequest.post("https://graph.microsoft.com/v1.0/me/events/e/accept"),
  HttpClientRequest.post("https://graph.microsoft.com/v1.0/me/events/e/decline"),
  HttpClientRequest.patch(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events/e?sendUpdates=all",
  ),
]) {
  it.effect(`${request.method} ${request.url} is submitted once`, () =>
    Effect.gen(function* () {
      let calls = 0;
      const fiber = yield* retryProviderRequest(
        Effect.suspend(() => {
          calls++;
          return Effect.fail({ _tag: "ApiError", status: 503 });
        }),
        request,
        () => true,
      ).pipe(Effect.result, Effect.forkChild);
      yield* TestClock.adjust("2 minutes");
      yield* Fiber.join(fiber);
      assert.strictEqual(calls, 1);
    }),
  );
}

it.effect("Retry-After has a sixty-second total budget across retries", () =>
  Effect.gen(function* () {
    let calls = 0;
    const started = yield* Clock.currentTimeMillis;
    const fiber = yield* retryProvider(
      Effect.suspend(() => {
        calls++;
        return Effect.fail({ retryAfter: "30" });
      }),
      () => true,
    ).pipe(Effect.result, Effect.forkChild);
    yield* TestClock.adjust("2 minutes");
    yield* Fiber.join(fiber);
    assert.strictEqual(calls, 3);
    // Later clock adjustment also completes a broken implementation, so the call count detects it.
    assert.isAtLeast((yield* Clock.currentTimeMillis) - started, 60000);
  }),
);

for (const status of [429, 503, 0]) {
  it.effect(`a non-idempotent POST retries only an unexecuted 429 (${status})`, () =>
    Effect.gen(function* () {
      let calls = 0;
      const worker = yield* retryProviderRequest(
        Effect.suspend(() => {
          calls++;
          return calls === 1
            ? Effect.fail({ _tag: "ApiError", status, retryAfter: "2" })
            : Effect.succeed("created");
        }),
        HttpClientRequest.post("https://graph.microsoft.com/v1.0/me/messages"),
        () => true,
      ).pipe(Effect.result, Effect.forkChild);
      yield* TestClock.adjust("2 seconds");
      const result = yield* Fiber.join(worker);
      assert.strictEqual(calls, status === 429 ? 2 : 1);
      assert.strictEqual(result._tag, status === 429 ? "Success" : "Failure");
    }),
  );
}

it("send failures share the same definite/uncertain classification", () => {
  for (const error of [
    new AuthError({ message: "Auth" }),
    new PermanentError({ message: "Rejected" }),
    new InvalidInput({ message: "Bad input" }),
    new NotFound({ what: "draft", id: "missing" }),
    new ProviderError({ message: "DNS", reason: "connection", status: 0 }),
    new ProviderError({ message: "Throttled", status: 429 }),
    new ProviderError({ message: "SMTP rejected" }),
    new ProviderError({ message: "Threading lookup failed", status: 503 }),
    new ProviderError({ message: "Request failed", status: 0 }),
  ])
    assert.isTrue(isDefiniteSendFailure(error));
  for (const error of [new SendUncertain({ message: "Unconfirmed" })])
    assert.isFalse(isDefiniteSendFailure(error));
});

import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Logger, Stream } from "effect";
import { TestClock } from "effect/testing";
import { AuthError, KEYCHAIN_LOCKED_MESSAGE, ProviderError } from "./domain/errors.js";
import { diagnosticRecord } from "./platform/node/diagnostics.js";
import { Mailbox } from "./mailbox/mailbox.js";
import { TestMailbox } from "./platform/node/testing.js";
import { Store } from "./services.js";
import {
  classifySyncFailure,
  storedSyncFailureReason,
  SYNC_FAILURE_TEXT,
  syncFailureText,
} from "./sync-failure.js";

it("classifies sync failures into fixed reasons", () => {
  const provider = (fields: { status?: number; reason?: ProviderError["reason"] }) =>
    new ProviderError({ message: "Gmail API 403: {...}", ...fields });
  assert.strictEqual(classifySyncFailure(provider({ status: 403, reason: "quota" })), "quota");
  assert.strictEqual(classifySyncFailure(provider({ status: 429 })), "quota");
  assert.strictEqual(classifySyncFailure(provider({ status: 0 })), "network");
  // IMAP connection reasons keep what to check; unsafe_login does not retry by itself.
  assert.strictEqual(classifySyncFailure(provider({ reason: "timeout" })), "no_response");
  assert.strictEqual(classifySyncFailure(provider({ reason: "tls" })), "tls");
  assert.strictEqual(classifySyncFailure(provider({ reason: "dns" })), "dns");
  assert.strictEqual(classifySyncFailure(provider({ reason: "refused" })), "refused");
  assert.strictEqual(classifySyncFailure(provider({ reason: "unsafe_login" })), "unsafe_login");
  assert.strictEqual(classifySyncFailure(provider({ reason: "connection" })), "network");
  assert.strictEqual(
    storedSyncFailureReason(`a@b: ${SYNC_FAILURE_TEXT.unsafe_login}`),
    "unsafe_login",
  );
  assert.strictEqual(classifySyncFailure(provider({ status: 503 })), "server");
  assert.strictEqual(classifySyncFailure(provider({ status: 400 })), "unknown");
  assert.strictEqual(
    classifySyncFailure(new AuthError({ accountId: "a", message: "invalid_grant" })),
    "auth",
  );
  assert.strictEqual(
    syncFailureText(new ProviderError({ message: KEYCHAIN_LOCKED_MESSAGE, reason: "keychain" })),
    KEYCHAIN_LOCKED_MESSAGE,
  );
  // Raw text an older version stored reads as unknown, with or without the account prefix.
  assert.strictEqual(storedSyncFailureReason('Gmail API 403: { "error": {} }'), "unknown");
  assert.strictEqual(storedSyncFailureReason(`a@b: ${SYNC_FAILURE_TEXT.quota}`), "quota");
});

it.effect("an IMAP sync failure logs a fixed-field sync-failed event", () => {
  const logged: unknown[] = [];
  const logger = Logger.make((options) => {
    logged.push(...(Array.isArray(options.message) ? options.message : [options.message]));
  });
  const failure = new ProviderError({
    message: "connect ETIMEDOUT 203.0.113.9:993 for me@example.com",
    reason: "timeout",
  });
  const layer = TestMailbox.withAdapter((base) => ({ ...base, pull: () => Stream.fail(failure) }));
  return Effect.gen(function* () {
    const store = yield* Store;
    const mailbox = yield* Mailbox;
    yield* store.upsertAccount("imap", "me@example.com");
    const fiber = yield* Effect.forkChild(mailbox.sync());
    for (let second = 0; second < 20; second++) yield* TestClock.adjust("1 second");
    const [result] = yield* Fiber.join(fiber);
    assert.strictEqual(result?.error, SYNC_FAILURE_TEXT.no_response);
    const event = logged.find(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        "_tag" in value &&
        value._tag === "SyncFailedDiagnostic",
    );
    assert.ok(event);
    const record = diagnosticRecord("runtime-warning", event, 1);
    assert.deepStrictEqual(Object.keys(record).toSorted(), [
      "_tag",
      "accountHash",
      "at",
      "event",
      "failure",
      "provider",
      "reason",
      "scope",
    ]);
    assert.include(record, {
      event: "runtime-warning",
      reason: "sync-failed",
      provider: "imap",
      failure: "no_response",
      scope: "full",
    });
    assert.notInclude(JSON.stringify(record), "203.0.113.9");
    assert.notInclude(JSON.stringify(record), "me@example.com");
  }).pipe(Effect.provide(layer), Effect.provide(Logger.layer([logger])));
});

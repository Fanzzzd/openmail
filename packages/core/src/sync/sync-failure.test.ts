import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Logger, Stream } from "effect";
import { TestClock } from "effect/testing";
import { AuthError, KEYCHAIN_LOCKED_MESSAGE, ProviderError } from "../domain/errors.js";
import { diagnosticRecord } from "../platform/node/diagnostics.js";
import { Mailbox } from "../mailbox/mailbox.js";
import { TestMailbox } from "../platform/node/testing.js";
import { Store } from "../store/service.js";
import {
  classifySyncFailure,
  DETAIL_MESSAGE_MAX,
  logSyncFailureDetail,
  redactErrorMessage,
  SyncFailureDetailLog,
  storedSyncFailureReason,
  SYNC_FAILURE_TEXT,
  syncFailureDetail,
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
    const fiber = yield* Effect.forkChild(mailbox.sync.sync());
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

// `openmail sync --log-level warn` showed only fixed fields, so no line named the error. The
// detail it now logs keeps addresses, URL queries and token-length strings out.
it("names the error and redacts what could identify the person", () => {
  const detail = syncFailureDetail({ provider: "gmail" }, "full", {
    _tag: "ProviderError",
    status: 400,
    message: `Bad request for alex@example.com (/gmail/v1/users/me/messages?q=from:priya@example.com&pageToken=abc) ${"x".repeat(48)}`,
  });
  assert.deepStrictEqual(detail, {
    provider: "gmail",
    scope: "full",
    failure: "unknown",
    tag: "ProviderError",
    status: 400,
    message: "Bad request for <address> (/gmail/v1/users/me/messages) <redacted>",
  });
});

// A provider message with escape codes and a line break printed raw on stderr under
// `openmail sync --log-level warn`, so it could set the terminal title, clear the screen and
// forge a line. Encoded addresses, display names and URL fragments came through as well.
it("keeps a failure detail on one line and redacts encoded addresses, names and fragments", () => {
  const forged = redactErrorMessage(
    "bad\u001b]0;pwned\u0007\u001b[2J\r\nFAKE: sync ok\u009b\u202e",
  );
  assert.notMatch(forged, /[\p{Cc}\u202e]/u);
  assert.strictEqual(forged, "bad ]0;pwned [2J FAKE: sync ok");
  assert.strictEqual(
    redactErrorMessage("No mailbox user%40example.com, owner Jane Doe <jane@example.com>"),
    "No mailbox <address>, <address>",
  );
  assert.strictEqual(
    redactErrorMessage('From "Doe, Jane" <jane@example.com>: rejected'),
    "From <address>: rejected",
  );
  assert.strictEqual(
    redactErrorMessage("Redirected to https://login.example.com/cb#code=s3cr3t&state=1 (302)"),
    "Redirected to https://login.example.com/cb (302)",
  );
  assert.strictEqual(redactErrorMessage("error #5"), "error #5");
  const long = redactErrorMessage(`${"word ".repeat(100)}tail`);
  assert.isAtMost(long.length, DETAIL_MESSAGE_MAX + 1);
  assert.isTrue(long.endsWith("…"));
  // A token the cut splits leaves none of its characters.
  const cut = redactErrorMessage(`${"a ".repeat(140)}${"k".repeat(39)} end ${"x".repeat(400)}`);
  assert.notInclude(cut, "kkk");
});

// The redaction regexes were quadratic on a long unbroken run (200k characters took 31 s with
// the event loop blocked), and every sync failure paid for them, though only the CLI logs it.
it("redacts a provider body of any size in bounded time", () => {
  const started = performance.now();
  const message = redactErrorMessage(`Gmail API 500: ${"a".repeat(200_000)}`);
  // The regression takes seconds; a loaded runner takes a few milliseconds.
  assert.isBelow(performance.now() - started, 1000);
  assert.isAtMost(message.length, DETAIL_MESSAGE_MAX + 1);
});

it.effect("builds a failure detail only when a caller logs it", () =>
  Effect.gen(function* () {
    let reads = 0;
    const error = {
      _tag: "ProviderError",
      get message() {
        reads++;
        return "boom";
      },
    };
    yield* logSyncFailureDetail({ provider: "gmail" }, "full", error);
    assert.strictEqual(reads, 0, "the default sink drops the detail unbuilt");
    const seen: string[] = [];
    yield* logSyncFailureDetail({ provider: "gmail" }, "full", error).pipe(
      Effect.provideService(SyncFailureDetailLog, (detail) =>
        Effect.sync(() => seen.push(detail.message)),
      ),
    );
    assert.deepStrictEqual(seen, ["boom"]);
  }),
);

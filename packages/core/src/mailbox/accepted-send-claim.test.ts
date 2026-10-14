import { expect, it, vi } from "vitest";
import { Effect, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";
import { Mailbox } from "./mailbox.js";
import { fakeServer } from "../platform/node/fake-provider.js";
import { TestMailbox } from "../platform/node/testing.js";
import { Store } from "../store/service.js";
import { scaledMs, waitLimit } from "../../test-support/test-time.js";

// R11 CH-1: the SMTP-accepted record a live send writes before its Sent APPEND looked like a
// crash leftover to the retry every successful sync runs, here or in another process. The retry
// filed a second Sent copy and finished the send under the live path.
const outgoing = {
  to: [{ name: "", address: "bob@example.com" }],
  cc: [],
  bcc: [],
  subject: "Live",
  text: "Hello",
  attachments: [],
};
const raw = new TextEncoder().encode("Message-ID: <live@example.com>\r\n\r\nHello\r\n");

/** Long enough for the background retry a sync starts to have run. */
const retrySettles = Effect.sleep(scaledMs(300));

it("a sync during a live send leaves the send's SMTP-accepted record alone", async () => {
  const server = fakeServer("me@example.com");
  server.acceptedRaw = raw;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.afterAccepted = Effect.promise(() => gate);
  await Effect.runPromise(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const store = yield* Store;
      const account = yield* mailbox.accounts.connect({ provider: "gmail" });
      const draft = { id: "draft:live", accountId: account.id, message: outgoing };
      yield* mailbox.compose.saveDraft(draft);
      yield* mailbox.outbox.queueSend(draft, 0);
      const fiber = yield* Effect.forkChild(mailbox.outbox.flushQueuedSends());
      yield* Effect.promise(() =>
        vi.waitFor(() => expect(server.acceptedMarks).toBe(1), waitLimit),
      );
      // The live send is between SMTP 250 and the end of its own Sent filing.
      yield* mailbox.sync.sync(account.id);
      yield* retrySettles;
      expect(server.sentCopies).toHaveLength(0);
      expect(Option.isSome(yield* store.getDraft("draft:live"))).toBe(true);
      expect((yield* mailbox.outbox.queuedSends).map((item) => item.status)).toEqual(["sending"]);
      expect(yield* store.smtpAccepted).toHaveLength(1);
      release();
      yield* Fiber.join(fiber);
      expect(server.sentCopies).toHaveLength(0);
      expect(server.sent).toHaveLength(1);
      expect(yield* store.smtpAccepted).toEqual([]);
      expect(yield* mailbox.outbox.queuedSends).toEqual([]);
      expect(Option.isNone(yield* store.getDraft("draft:live"))).toBe(true);
    }).pipe(
      Effect.provide(
        TestMailbox({ gmail: server }, { backgroundFlush: false, resumeDesktopSends: true }),
      ),
    ),
  );
});

it("a record another process holds is skipped until its claim goes stale", async () => {
  const server = fakeServer("me@example.com");
  await Effect.runPromise(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const store = yield* Store;
      const account = yield* mailbox.accounts.connect({ provider: "gmail" });
      // A CLI send in another process wrote this record and is filing its Sent copy now.
      yield* store.markSmtpAccepted("draft:other", account.id, raw, "other-process");
      yield* mailbox.sync.sync(account.id);
      yield* retrySettles;
      expect(server.sentCopies).toHaveLength(0);
      expect(yield* store.smtpAccepted).toHaveLength(1);
      // That process died three minutes ago without renewing its claim.
      yield* Effect.gen(function* () {
        yield* TestClock.setTime(Date.now() - 3 * 60_000);
        yield* store.markSmtpAccepted("draft:other", account.id, raw, "other-process");
      }).pipe(Effect.provide(TestClock.layer()));
      yield* mailbox.sync.sync(account.id);
      yield* Effect.promise(() =>
        vi.waitFor(() => expect(server.sentCopies).toHaveLength(1), waitLimit),
      );
      yield* Effect.promise(() =>
        vi.waitFor(
          async () => expect(await Effect.runPromise(store.smtpAccepted)).toEqual([]),
          waitLimit,
        ),
      );
    }).pipe(
      Effect.provide(
        TestMailbox({ gmail: server }, { backgroundFlush: false, resumeDesktopSends: true }),
      ),
    ),
  );
});

it("a failed live send gives its claim back, so the next retry finishes it at once", async () => {
  const server = fakeServer("me@example.com");
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* Store;
      const mailbox = yield* Mailbox;
      const account = yield* mailbox.accounts.connect({ provider: "gmail" });
      yield* store.markSmtpAccepted("draft:dropped", account.id, raw, "live");
      yield* store.releaseSmtpAccepted("draft:dropped", "not-the-owner");
      expect(yield* store.claimSmtpAccepted("draft:dropped", "retry")).toBe(false);
      yield* store.releaseSmtpAccepted("draft:dropped", "live");
      expect(yield* store.claimSmtpAccepted("draft:dropped", "retry")).toBe(true);
      expect(yield* store.claimSmtpAccepted("draft:dropped", "second-retry")).toBe(false);
    }).pipe(Effect.provide(TestMailbox({ gmail: server }, { backgroundFlush: false }))),
  );
});

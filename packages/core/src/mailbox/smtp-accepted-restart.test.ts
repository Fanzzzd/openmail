import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/sql";
import { Mailbox } from "./mailbox.js";
import { ProviderError } from "../domain/errors.js";
import { fakeServer } from "../platform/node/fake-provider.js";
import { TestMailbox } from "../platform/node/testing.js";
import { Store } from "../store/service.js";
import { waitLimit } from "../../test-support/test-time.js";

// E9-9: OpenMail stopping between SMTP 250 and the Sent APPEND left no record, and the restart
// told the person to check Sent on servers that never file SMTP mail there.
const outgoing = {
  to: [{ name: "", address: "bob@example.com" }],
  cc: [],
  bcc: [],
  subject: "Accepted",
  text: "Hello",
  attachments: [],
};
const raw = new TextEncoder().encode("Message-ID: <accepted@example.com>\r\n\r\nHello\r\n");

/** Runs `before` in one process, then `after` in a reopened one on the same database. */
const restart = async (
  server: ReturnType<typeof fakeServer>,
  before: (accountId: string) => Effect.Effect<void, unknown, Mailbox | Store>,
  after: (accountId: string) => Effect.Effect<void, unknown, Mailbox | Store>,
) => {
  const directory = mkdtempSync(join(tmpdir(), "openmail-smtp-accepted-"));
  const layer = () =>
    TestMailbox(
      { imap: server },
      { backgroundFlush: false, localDraftQueue: true, resumeDesktopSends: true },
      {},
      Layer.empty,
      { database: join(directory, "mail.db") },
    );
  let accountId = "";
  const first = ManagedRuntime.make(layer());
  try {
    await first.runPromise(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        accountId = (yield* mailbox.accounts.connect({
          provider: "imap",
          input: {
            preset: "custom",
            email: server.email,
            password: "pw",
            imapHost: "imap.example.com",
            imapPort: 993,
            smtpHost: "smtp.example.com",
            smtpPort: 465,
          },
        })).id;
        const store = yield* Store;
        // A server outside the presets that file SMTP mail in Sent themselves.
        yield* store.setImapSettings(accountId, {
          preset: "custom",
          username: server.email,
          imapHost: "imap.example.com",
          imapPort: 993,
          smtpHost: "smtp.example.com",
          smtpPort: 465,
          smtpSecure: true,
        });
        yield* store.putDraft({ id: "draft:accepted", accountId, message: outgoing });
        yield* store.putQueuedSend({
          id: "draft:accepted",
          accountId,
          message: outgoing,
          due: Date.now(),
          status: "sending",
          desktopUndo: true,
        });
        yield* store.setSendUncertain("draft:accepted", true);
        yield* before(accountId);
      }),
    );
  } finally {
    await first.dispose();
  }
  const reopened = ManagedRuntime.make(layer());
  try {
    await reopened.runPromise(after(accountId));
  } finally {
    await reopened.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
};

/** Moves every record's last failed try an hour back, as if that time had passed. */
const backdateLastTry = Effect.gen(function* () {
  // The test layer provides SqlClient without naming it in its type.
  const sql = Option.getOrThrow(yield* Effect.serviceOption(SqlClient.SqlClient));
  yield* sql`UPDATE prefs SET value_json=json_set(value_json,'$.lastTryAt',json_extract(value_json,'$.lastTryAt')-3600000) WHERE key LIKE 'smtp-accepted:%'`;
});

const settled = Effect.gen(function* () {
  const store = yield* Store;
  yield* Effect.promise(() =>
    vi.waitFor(async () => {
      expect(await Effect.runPromise(store.smtpAccepted)).toEqual([]);
    }, waitLimit),
  );
});

it("start files the Sent copy of a send SMTP accepted before a crash and finishes it", async () => {
  const server = fakeServer("me@example.com");
  await restart(
    server,
    (accountId) =>
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.markSmtpAccepted("draft:accepted", accountId, raw);
      }),
    () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const mailbox = yield* Mailbox;
        yield* settled;
        expect(server.sentCopies.map((copy) => new TextDecoder().decode(copy))).toEqual([
          new TextDecoder().decode(raw),
        ]);
        expect(yield* mailbox.outbox.queuedSends).toEqual([]);
        expect(Option.isNone(yield* store.getDraft("draft:accepted"))).toBe(true);
        expect(yield* store.sendUncertain("draft:accepted")).toBe(false);
        expect(yield* mailbox.proposals.listFailedOps).toEqual([]);
        expect(server.sent).toHaveLength(0);
      }),
  );
});

/** Waits until the record for the accepted send shows `tries` failed filings. */
const failedTimes = (tries: number) =>
  Effect.gen(function* () {
    const store = yield* Store;
    yield* Effect.promise(() =>
      vi.waitFor(async () => {
        expect((await Effect.runPromise(store.smtpAccepted)).map((entry) => entry.tries)).toEqual([
          tries,
        ]);
      }, waitLimit),
    );
  });

// One failed filing at launch (offline, say) used to clear the record, so the Sent copy was
// never filed even once the server was back.
it("a Sent copy that fails at launch is filed on the next successful sync", async () => {
  const server = fakeServer("me@example.com");
  await restart(
    server,
    (accountId) =>
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.markSmtpAccepted("draft:accepted", accountId, raw);
        server.sentCopyFailure = new ProviderError({ message: "offline" });
      }),
    (accountId) =>
      Effect.gen(function* () {
        const store = yield* Store;
        const mailbox = yield* Mailbox;
        yield* failedTimes(1);
        // The send itself is finished: no queue entry, draft or uncertainty is left.
        expect(yield* mailbox.outbox.queuedSends).toEqual([]);
        expect(Option.isNone(yield* store.getDraft("draft:accepted"))).toBe(true);
        expect(yield* store.sendUncertain("draft:accepted")).toBe(false);
        expect(yield* mailbox.proposals.listFailedOps).toEqual([]);
        expect(server.sentCopies).toHaveLength(0);
        // The retry after a failure waits an hour; that hour has passed.
        yield* backdateLastTry;
        yield* mailbox.sync.sync(accountId);
        yield* settled;
        expect(server.sentCopies.map((copy) => new TextDecoder().decode(copy))).toEqual([
          new TextDecoder().decode(raw),
        ]);
        expect(yield* mailbox.proposals.listFailedOps).toEqual([]);
        expect(server.sent).toHaveLength(0);
      }),
  );
});

it("a Sent copy that keeps failing is reported after the last try, and the send is not repeated", async () => {
  const server = fakeServer("me@example.com");
  await restart(
    server,
    (accountId) =>
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.markSmtpAccepted("draft:accepted", accountId, raw);
        for (let i = 0; i < 9; i++) {
          yield* store.claimSmtpAccepted("draft:accepted", "earlier-try");
          yield* store.noteSentCopyFailure(
            "draft:accepted",
            { subject: "Accepted", sender: "" },
            "earlier-try",
          );
        }
        server.sentCopyFailure = new ProviderError({ message: "APPEND refused" });
      }),
    () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const mailbox = yield* Mailbox;
        yield* settled;
        expect(yield* mailbox.outbox.queuedSends).toEqual([]);
        expect(yield* store.sendUncertain("draft:accepted")).toBe(false);
        const notices = yield* mailbox.proposals.listFailedOps;
        expect(notices).toMatchObject([
          { kind: "sentCopyMissing", providerId: "draft:accepted", subject: "Accepted" },
        ]);
        expect(notices[0]?.reason).toContain("APPEND refused");
        expect(server.sent).toHaveLength(0);
      }),
  );
});

it("a Sent copy still missing after a week is reported with the subject it was sent with", async () => {
  const server = fakeServer("me@example.com");
  await restart(
    server,
    (accountId) =>
      Effect.gen(function* () {
        const store = yield* Store;
        yield* Effect.gen(function* () {
          yield* TestClock.setTime(Date.now() - 8 * 86_400_000);
          yield* store.markSmtpAccepted("draft:accepted", accountId, raw);
        }).pipe(Effect.provide(TestClock.layer()));
        yield* store.claimSmtpAccepted("draft:accepted", "earlier-try");
        yield* store.noteSentCopyFailure(
          "draft:accepted",
          { subject: "Accepted", sender: "me@example.com" },
          "earlier-try",
        );
        // The draft went away on the first try; the notice still names the message.
        yield* store.deleteQueuedSend("draft:accepted");
        yield* store.deleteDraft("draft:accepted");
        server.sentCopyFailure = new ProviderError({ message: "APPEND refused" });
      }),
    () =>
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        yield* settled;
        expect(yield* mailbox.proposals.listFailedOps).toMatchObject([
          { kind: "sentCopyMissing", subject: "Accepted", sender: "me@example.com" },
        ]);
      }),
  );
});

it("an interrupted send without an SMTP answer does not point at Sent on a server that never files there", async () => {
  const server = fakeServer("me@example.com");
  await restart(
    server,
    () => Effect.void,
    () =>
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const notices = yield* mailbox.proposals.listFailedOps;
        expect(notices).toHaveLength(1);
        expect(notices[0]?.reason).toContain("does not save sent mail itself");
        expect((yield* mailbox.outbox.queuedSends)[0]?.status).toBe("failed");
      }),
  );
});

it("a send that finishes clears the SMTP-accepted record the adapter wrote", async () => {
  const server = fakeServer("me@example.com");
  server.acceptedRaw = raw;
  await Effect.runPromise(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const store = yield* Store;
      const account = yield* mailbox.accounts.connect({ provider: "gmail" });
      yield* mailbox.compose.saveDraft({
        id: "draft:live",
        accountId: account.id,
        message: outgoing,
      });
      yield* mailbox.outbox.queueSend(
        { id: "draft:live", accountId: account.id, message: outgoing },
        0,
      );
      yield* mailbox.outbox.flushQueuedSends();
      expect(server.sent).toHaveLength(1);
      expect(server.acceptedMarks).toBe(1);
      expect(yield* store.smtpAccepted).toEqual([]);
    }).pipe(Effect.provide(TestMailbox({ gmail: server }, { backgroundFlush: false }))),
  );
});

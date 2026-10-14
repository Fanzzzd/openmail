import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { Mailbox } from "../mailbox/mailbox.js";
import { fakeServer, incoming, TestMailbox } from "../platform/node/testing.js";

// A reply to a snoozed conversation used to notify while the Inbox kept hiding
// the conversation until the snooze was due. New mail ends the snooze, as in Gmail.
for (const provider of ["gmail", "outlook", "imap"] as const)
  it.effect(`${provider}: a reply to a snoozed conversation is notified and shown`, () => {
    const server = fakeServer(provider === "imap" ? "me@example.com" : `me@${provider}.com`);
    return Effect.gen(function* () {
      yield* TestClock.setTime(1_000_000);
      const m = yield* Mailbox;
      server.messages.set(
        "a",
        incoming("a", { threadId: "t", date: 999_000, rfcMessageId: "<a@x>" }),
      );
      yield* m.accounts.connect(
        provider === "imap"
          ? { provider, input: { preset: "qq", email: server.email, password: "fake" } }
          : { provider },
      );
      yield* m.sync.sync();
      const a = (yield* m.reading.threads({ mailbox: "inbox" }))[0]!.id;
      yield* m.organize.snooze([a], 1_000_000 + 86_400_000);
      yield* m.sync.sync();
      yield* TestClock.adjust("1 minute");
      server.messages.set(
        "b",
        incoming("b", {
          threadId: "t",
          date: 1_060_000,
          rfcMessageId: "<b@x>",
          parentRfcMessageId: "<a@x>",
        }),
      );
      yield* m.sync.sync();
      const notified = (yield* m.app.takeNotifications).flatMap((b) => b.messages.map((x) => x.id));
      const inbox = (yield* m.reading.threads({ mailbox: "inbox" })).map((t) => t.id);
      const reply = notified.find((id) => id.endsWith("/b"));
      // The reply notifies once; waking the snooze adds no reminder on top.
      assert.deepStrictEqual({ notified, inbox }, { notified: [reply], inbox: [reply] });
      const thread = yield* m.reading.thread(a);
      assert.deepStrictEqual(
        thread.map((message) => message.labels.includes("INBOX")),
        [true, true],
      );
    }).pipe(Effect.provide(TestMailbox({ [provider]: server })));
  });

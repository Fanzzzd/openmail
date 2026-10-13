import { assert, it } from "@effect/vitest";
import { Effect, Ref, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";

import { DEFAULT_PREFS, Prefs } from "../domain/prefs.js";
import type { Account } from "../domain/account.js";
import type { IncomingMessage, Message } from "../domain/message.js";
import { PermanentError } from "../domain/errors.js";
import { Mailbox, type MailboxEvent } from "../mailbox/mailbox.js";
import {
  inQuietHours,
  messageLink,
  parseAppLink,
  shouldNotify,
  spaceAccountIds,
} from "./system.js";
import { fakeServer, TestMailbox } from "../platform/node/testing.js";
import { SYNC_FAILURE_TEXT } from "../sync/sync-failure.js";

const account: Account = {
  id: "gmail:me@gmail.com",
  provider: "gmail",
  email: "me@gmail.com",
  createdAt: 0,
  lastSyncedAt: 0,
  lastSyncError: null,
  profileId: "work",
  needsReauth: false,
};
const incoming = (id: string, patch: Partial<IncomingMessage> = {}): IncomingMessage => ({
  providerId: id,
  threadId: `t-${id}`,
  from: { name: "Ann", address: "ann@example.com" },
  to: [],
  cc: [],
  date: 1000,
  subject: id,
  snippet: "Hi",
  bodyText: "Hi",
  bodyHtml: "",
  labels: ["INBOX", "UNREAD"],
  attachments: [],
  isUnread: true,
  isStarred: false,
  ...patch,
});
const message: Message = {
  ...incoming("one"),
  id: `${account.id}/one`,
  accountId: account.id,
  hasAttachments: false,
};

it("parses mailto fields without sending, preserves plus and Unicode, and rejects header injection", () => {
  assert.deepStrictEqual(
    parseAppLink(
      "mailto:alice+tag@example.com?to=bob%40example.com&CC=c%40example.com&bcc=d%40example.com&subject=%E4%B8%AD%E6%96%87%2Btest&body=one%0D%0Atwo&from=attacker&attachment=file",
    ),
    {
      kind: "compose",
      draft: {
        to: "alice+tag@example.com, bob@example.com",
        cc: "c@example.com",
        bcc: "d@example.com",
        subject: "中文+test",
        body: "one\ntwo",
      },
    },
  );
  for (const link of [
    "mailto:a@example.com?subject=Hello%0D%0ABcc:evil@example.com",
    "mailto:a@example.com?cc=bad%00",
    "mailto:%zz",
    "https://example.com",
    "mailto://host/a@example.com",
  ])
    assert.strictEqual(parseAppLink(link), null);
});
it("deep links round-trip opaque message ids and reject unrelated routes", () => {
  const id = "imap:me@example.com/Work:报价/170000:42";
  assert.deepStrictEqual(parseAppLink(messageLink(id)), { kind: "message", id });
  for (const link of [
    "openmail://message/",
    "openmail://message/a/b",
    "openmail://message/%zz",
    "openmail://other/a",
    "openmail://user@message/a",
    "openmail://message/a?op=delete",
  ])
    assert.strictEqual(parseAppLink(link), null);
});
it("quiet hours include start and exclude end, including midnight and all-day intervals", () => {
  const at = (h: number, m = 0) => new Date(2026, 8, 30, h, m);
  const hours = { enabled: true, start: 22 * 60, end: 8 * 60 };
  assert.isTrue(inQuietHours(hours, at(22)));
  assert.isTrue(inQuietHours(hours, at(0)));
  assert.isTrue(inQuietHours(hours, at(7, 59)));
  assert.isFalse(inQuietHours(hours, at(8)));
  assert.isFalse(inQuietHours({ ...hours, enabled: false }, at(22)));
  assert.isTrue(inQuietHours({ ...hours, start: 0, end: 0 }, at(12)));
  assert.isTrue(inQuietHours({ ...hours, start: 9 * 60, end: 17 * 60 }, at(9)));
  assert.isFalse(inQuietHours({ ...hours, start: 9 * 60, end: 17 * 60 }, at(17)));
});
it("per-account modes and per-space quiet hours decide notifications", () => {
  const now = new Date(2026, 8, 30, 12);
  assert.isTrue(shouldNotify(account, message, DEFAULT_PREFS, now));
  const secondary = { ...message, labels: [...message.labels, "CATEGORY_PROMOTIONS"] };
  assert.isFalse(shouldNotify(account, secondary, DEFAULT_PREFS, now));
  assert.isTrue(
    shouldNotify(
      account,
      secondary,
      { ...DEFAULT_PREFS, notifications: { [account.id]: "inbox" } },
      now,
    ),
  );
  assert.isTrue(shouldNotify({ ...account, provider: "outlook" }, secondary, DEFAULT_PREFS, now));
  assert.isTrue(
    shouldNotify(
      { ...account, provider: "outlook" },
      { ...message, labels: [...message.labels, "CATEGORY_PERSONAL"] },
      DEFAULT_PREFS,
      now,
    ),
  );
  assert.isFalse(
    shouldNotify(
      account,
      message,
      { ...DEFAULT_PREFS, notifications: { [account.id]: "off" } },
      now,
    ),
  );
  assert.isFalse(shouldNotify(account, { ...message, isUnread: false }, DEFAULT_PREFS, now));
  assert.isFalse(shouldNotify(account, { ...message, labels: ["UNREAD"] }, DEFAULT_PREFS, now));
  assert.isFalse(
    shouldNotify(
      account,
      message,
      { ...DEFAULT_PREFS, quietHours: { work: { enabled: true, start: 0, end: 0 } } },
      now,
    ),
  );
  assert.deepStrictEqual(spaceAccountIds("empty", [account]), []);
  assert.deepStrictEqual(
    spaceAccountIds("work", [account, { ...account, id: "other", profileId: "home" }]),
    [account.id],
  );
});
it.effect(
  "new system preferences persist, and invalid quiet hours fail at the schema boundary",
  () =>
    Effect.gen(function* () {
      const m = yield* Mailbox;
      yield* m.setPrefs({
        shortcutSet: "apple",
        notifications: { a: "off" },
        quietHours: { work: { enabled: true, start: 1320, end: 480 } },
      });
      const prefs = yield* m.prefs;
      assert.strictEqual(prefs.shortcutSet, "apple");
      assert.deepStrictEqual(prefs.notifications, { a: "off" });
      assert.deepStrictEqual(prefs.quietHours.work, { enabled: true, start: 1320, end: 480 });
      assert.throws(() =>
        Schema.decodeUnknownSync(Prefs)({
          ...prefs,
          quietHours: { work: { enabled: true, start: -1, end: 1440 } },
        }),
      );
    }).pipe(Effect.provide(TestMailbox())),
);

it.effect(
  "first sync is silent; only new unread inbox ids notify once across polling and full sync",
  () => {
    const server = fakeServer(account.email, [incoming("initial")]);
    return Effect.gen(function* () {
      const m = yield* Mailbox;
      const events = yield* Ref.make<MailboxEvent[]>([]);
      yield* m.events.pipe(
        Stream.runForEach((event) => Ref.update(events, (all) => [...all, event])),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* m.connect({ provider: "gmail" });
      yield* m.sync();
      const notices = () =>
        Ref.get(events).pipe(
          Effect.map((all) => all.filter((e) => e._tag === "NewMail").flatMap((e) => e.ids)),
        );
      assert.deepStrictEqual(yield* notices(), []);
      server.messages.set("new", incoming("new"));
      server.messages.set("read", incoming("read", { isUnread: false, labels: ["INBOX"] }));
      server.messages.set("archive", incoming("archive", { labels: ["UNREAD"] }));
      yield* m.pollInbox();
      yield* Effect.yieldNow;
      assert.deepStrictEqual(yield* notices(), [`${account.id}/new`]);
      assert.isTrue(
        (yield* m.threads({ mailbox: "inbox" })).some((t) => t.id === `${account.id}/new`),
      );
      yield* m.sync();
      yield* m.pollInbox();
      server.messages.set("read", incoming("read"));
      yield* m.sync();
      yield* Effect.yieldNow;
      assert.deepStrictEqual(yield* notices(), [`${account.id}/new`]);
      // Reappearing ids remain seen after provider removal and a later re-import.
      server.messages.delete("new");
      yield* m.sync();
      server.messages.set("new", incoming("new"));
      yield* m.sync();
      yield* Effect.yieldNow;
      assert.deepStrictEqual(yield* notices(), [`${account.id}/new`]);
      // Notification actions use the same audited user pipeline, including offline retry.
      const outcome = yield* m.perform(
        { kind: "modify", threads: [`${account.id}/new`], op: { kind: "archive" } },
        { kind: "user", surface: "app" },
      );
      assert.strictEqual(outcome.status, "applied");
      assert.deepStrictEqual(server.pushed.at(-1), { providerId: "new", op: { kind: "archive" } });
      assert.strictEqual((yield* m.audit(1))[0]?.actor, "user:app");
    }).pipe(Effect.provide(TestMailbox({ gmail: server })));
  },
);

it.effect("desktop polling repeats every 45 seconds", () => {
  const server = fakeServer(account.email, [incoming("initial")]);
  return Effect.gen(function* () {
    const m = yield* Mailbox;
    yield* m.connect({ provider: "gmail" });
    yield* m.sync();
    server.messages.set("first", incoming("first"));
    yield* TestClock.adjust("44 seconds");
    assert.isFalse((yield* m.threads({ mailbox: "inbox" })).some((m) => m.subject === "first"));
    yield* TestClock.adjust("1 second");
    yield* TestClock.adjust("250 millis");
    assert.isTrue((yield* m.threads({ mailbox: "inbox" })).some((m) => m.subject === "first"));
    server.messages.set("second", incoming("second"));
    yield* TestClock.adjust("45 seconds");
    yield* TestClock.adjust("250 millis");
    assert.isTrue((yield* m.threads({ mailbox: "inbox" })).some((m) => m.subject === "second"));
  }).pipe(
    Effect.provide(
      TestMailbox({ gmail: server }, { inboxPoll: "45 seconds", backgroundFlush: false }),
    ),
  );
});

it.effect("CLI and MCP mailbox layers do not start new-mail polling", () => {
  const server = fakeServer(account.email, [incoming("initial")]);
  return Effect.gen(function* () {
    const m = yield* Mailbox;
    yield* m.connect({ provider: "gmail" });
    yield* m.sync();
    server.messages.set("later", incoming("later"));
    yield* TestClock.adjust("2 minutes");
    assert.isFalse(
      (yield* m.threads({ mailbox: "inbox" })).some((thread) => thread.subject === "later"),
    );
  }).pipe(Effect.provide(TestMailbox({ gmail: server })));
});

it.effect("IMAP mail moved into Inbox under a different UID stays seen", () => {
  const original = incoming("archive:1", {
    threadId: "root@example.com",
    subject: "Seen mail",
    labels: ["ARCHIVE", "UNREAD"],
  });
  const server = fakeServer("me@example.com", [original]);
  return Effect.gen(function* () {
    const m = yield* Mailbox;
    yield* m.connect({
      provider: "imap",
      input: { preset: "qq", email: "me@example.com", password: "fake" },
    });
    yield* m.sync();
    const events = yield* Ref.make<MailboxEvent[]>([]);
    yield* m.events.pipe(
      Stream.runForEach((event) => Ref.update(events, (all) => [...all, event])),
      Effect.forkScoped,
    );
    yield* Effect.yieldNow;
    server.messages.delete(original.providerId);
    server.messages.set("inbox:2", {
      ...original,
      providerId: "inbox:2",
      labels: ["INBOX", "UNREAD"],
    });
    yield* m.pollInbox();
    yield* m.sync();
    yield* Effect.yieldNow;
    assert.isFalse((yield* Ref.get(events)).some((event) => event._tag === "NewMail"));
    assert.strictEqual((yield* m.threads({ mailbox: "inbox" })).length, 1);
  }).pipe(Effect.provide(TestMailbox({ imap: server })));
});

it.effect("idle inbox polling emits no Changed and preserves a full-sync error", () => {
  const server = fakeServer(account.email);
  return Effect.gen(function* () {
    const m = yield* Mailbox;
    yield* m.connect({ provider: "gmail" });
    yield* m.sync();
    const events = yield* Ref.make<MailboxEvent[]>([]);
    yield* m.events.pipe(
      Stream.runForEach((event) => Ref.update(events, (all) => [...all, event])),
      Effect.forkScoped,
    );
    yield* Effect.yieldNow;
    yield* m.pollInbox();
    yield* Effect.yieldNow;
    assert.isFalse((yield* Ref.get(events)).some((event) => event._tag === "Changed"));
  }).pipe(Effect.provide(TestMailbox({ gmail: server })));
});
it.effect("catch-up suppresses unread mail older than the previous sync", () => {
  const server = fakeServer(account.email);
  return Effect.gen(function* () {
    const m = yield* Mailbox;
    yield* m.connect({ provider: "gmail" });
    yield* m.sync();
    yield* TestClock.adjust("10 seconds");
    yield* m.sync();
    const ids = yield* Ref.make<string[]>([]);
    yield* m.events.pipe(
      Stream.runForEach((event) =>
        event._tag === "NewMail" ? Ref.update(ids, (all) => [...all, ...event.ids]) : Effect.void,
      ),
      Effect.forkScoped,
    );
    yield* Effect.yieldNow;
    server.messages.set("old", incoming("old", { date: 9000 }));
    server.messages.set("fresh", incoming("fresh", { date: 11000 }));
    yield* m.pollInbox();
    yield* Effect.yieldNow;
    assert.deepStrictEqual(yield* Ref.get(ids), [`${account.id}/fresh`]);
    assert.strictEqual((yield* m.threads({ mailbox: "inbox" })).length, 2);
  }).pipe(Effect.provide(TestMailbox({ gmail: server })));
});

it.effect(
  "poll recovery does not erase full-sync errors and only error transitions invalidate",
  () => {
    const server = fakeServer(account.email);
    return Effect.gen(function* () {
      const m = yield* Mailbox;
      yield* m.connect({ provider: "gmail" });
      yield* m.sync();
      server.failNext = new PermanentError({ message: "full sync error" });
      yield* m.sync();
      const changes = yield* Ref.make(0);
      yield* m.events.pipe(
        Stream.runForEach((event) =>
          event._tag === "Changed" ? Ref.update(changes, (n) => n + 1) : Effect.void,
        ),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* m.pollInbox();
      assert.strictEqual((yield* m.accounts)[0]?.lastSyncError, SYNC_FAILURE_TEXT.unknown);
      yield* Effect.yieldNow;
      assert.strictEqual(yield* Ref.get(changes), 0);
      server.failNext = new PermanentError({ message: "offline" });
      yield* m.pollInbox();
      yield* Effect.yieldNow;
      assert.strictEqual(yield* Ref.get(changes), 1);
      yield* m.pollInbox();
      yield* Effect.yieldNow;
      assert.strictEqual(yield* Ref.get(changes), 1);
      yield* TestClock.adjust("90 seconds");
      yield* m.pollInbox();
      yield* Effect.yieldNow;
      assert.strictEqual(yield* Ref.get(changes), 2);
      assert.strictEqual((yield* m.accounts)[0]?.lastSyncError, SYNC_FAILURE_TEXT.unknown);
    }).pipe(Effect.provide(TestMailbox({ gmail: server })));
  },
);
it.effect("offline inbox polling backs off independently until recovery", () => {
  const server = fakeServer(account.email);
  return Effect.gen(function* () {
    const m = yield* Mailbox;
    yield* m.connect({ provider: "gmail" });
    yield* m.sync();
    server.failNext = new PermanentError({ message: "offline" });
    yield* TestClock.adjust("45 seconds");
    yield* TestClock.adjust("250 millis");
    server.messages.set("later", incoming("later", { date: 100_000 }));
    yield* TestClock.adjust("45 seconds");
    yield* TestClock.adjust("250 millis");
    assert.deepStrictEqual(yield* m.threads({ mailbox: "inbox" }), []);
    yield* TestClock.adjust("45 seconds");
    yield* TestClock.adjust("250 millis");
    assert.strictEqual((yield* m.threads({ mailbox: "inbox" })).length, 1);
  }).pipe(
    Effect.provide(
      TestMailbox({ gmail: server }, { inboxPoll: "45 seconds", backgroundFlush: false }),
    ),
  );
});
it.effect("battery polling waits twice as long as AC polling", () => {
  const server = fakeServer(account.email);
  return Effect.gen(function* () {
    const m = yield* Mailbox;
    yield* m.connect({ provider: "gmail" });
    yield* m.sync();
    server.messages.set("battery", incoming("battery"));
    yield* TestClock.adjust("45 seconds");
    yield* TestClock.adjust("250 millis");
    assert.deepStrictEqual(yield* m.threads({ mailbox: "inbox" }), []);
    yield* TestClock.adjust("45 seconds");
    yield* TestClock.adjust("250 millis");
    assert.strictEqual((yield* m.threads({ mailbox: "inbox" })).length, 1);
  }).pipe(
    Effect.provide(
      TestMailbox(
        { gmail: server },
        { inboxPoll: "45 seconds", pollOnBattery: () => true, backgroundFlush: false },
      ),
    ),
  );
});

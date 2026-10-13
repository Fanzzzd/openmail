import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { MailboxLive } from "./mailbox-live.js";
import { StoreLive } from "../store/store.js";
import { MemoryPlatform } from "../platform/node/platform-memory.js";
import { Providers } from "../providers/adapter.js";
import { Store } from "../store/service.js";
import { makeFakeProvider } from "../platform/node/fake-provider.js";
import { TestClock } from "effect/testing";
import type { IncomingMessage } from "../domain/message.js";
import { FeatureScopeMissing } from "../domain/errors.js";
import { Mailbox } from "./mailbox.js";
import { fakeServer, TestMailbox } from "../platform/node/testing.js";
import { parseCalendar } from "../calendar/invites.js";

const incoming: IncomingMessage = {
  providerId: "m1",
  threadId: "t1",
  subject: "Meeting",
  from: { name: "Alice", address: "alice@example.com" },
  to: [{ name: "Me", address: "me@example.com" }],
  cc: [],
  date: 1000,
  snippet: "",
  bodyText: "Meeting",
  bodyHtml: "",
  labels: ["INBOX"],
  attachments: [{ filename: "invite.ics", mimeType: "text/calendar", size: 100 }],
  isUnread: false,
  isStarred: false,
  hasCalendar: true,
};
const ics = (method = "REQUEST", sequence = 1) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:${method}\r\nBEGIN:VEVENT\r\nUID:meeting\r\nSEQUENCE:${sequence}\r\nDTSTART:20261001T090000Z\r\nSUMMARY:Meeting\r\nORGANIZER:mailto:alice@example.com\r\nATTENDEE:mailto:me@example.com\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
const raw = (method = "REQUEST", sequence = 1) =>
  Buffer.from(
    `From: alice@example.com\r\nTo: me@example.com\r\nMIME-Version: 1.0\r\nContent-Type: text/calendar; method=${method}\r\n\r\n${ics(method, sequence)}`,
  );
const user = { kind: "user", surface: "app" } as const;

it.effect(
  "reading and syncing invitations never respond; IMAP explicit click uses the audited send pipeline",
  () => {
    const server = fakeServer("me@example.com", [incoming]);
    server.raw.set("m1", raw());
    return Effect.gen(function* () {
      const m = yield* Mailbox;
      const account = yield* m.connect({
        provider: "imap",
        input: { preset: "custom", email: "me@example.com", password: "test" },
      });
      yield* m.sync();
      const id = `${account.id}/m1`;
      const [invite] = yield* m.invitations(id);
      assert.ok(invite);
      assert.strictEqual(server.sent.length, 0);
      assert.strictEqual(server.responses.length, 0);
      const agent = yield* m
        .respondInvite(id, invite.key, "accepted", { kind: "agent", surface: "mcp", name: "bot" })
        .pipe(Effect.result);
      assert.strictEqual(agent._tag, "Failure");
      assert.strictEqual(server.sent.length, 0);
      yield* m.respondInvite(id, invite.key, "accepted", user);
      assert.strictEqual(server.sent.length, 1);
      assert.strictEqual(server.responses.length, 0);
      const reply = server.sent[0]?.message.calendar;
      assert.ok(reply);
      const [parsed] = parseCalendar(reply.content);
      assert.strictEqual(parsed?.invite.method, "REPLY");
      assert.strictEqual(parsed?.invite.attendees[0]?.status, "ACCEPTED");
      const audit = yield* m.audit(20);
      assert.ok(audit.some((a) => a.action === "send" && a.actor === "user:app"));
      assert.ok(audit.some((a) => a.action === "calendar_response"));
      server.raw.set("m1", raw("CANCEL"));
      assert.strictEqual(
        (yield* m.respondInvite(id, invite.key, "declined", user).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.strictEqual(server.sent.length, 1);
    }).pipe(Effect.provide(TestMailbox({ imap: server })));
  },
);

it.effect(
  "contacts merge local history, respect hiding/exclusion, refresh periodically and retain cache on missing scope",
  () => {
    const server = fakeServer("me@example.com", [
      { ...incoming, attachments: [], from: { name: "Local Alice", address: "alice@example.com" } },
    ]);
    server.contacts = [
      { name: "Server Alice", address: "ALICE@example.com" },
      { name: "Remote", address: "remote@example.com" },
      { name: "Me", address: "me@example.com" },
    ];
    return Effect.gen(function* () {
      const m = yield* Mailbox;
      const account = yield* m.connect({ provider: "gmail" });
      yield* m.sync();
      assert.strictEqual((yield* m.contactSync)[0]?.count, 3);
      assert.strictEqual((yield* m.suggestContacts("remote"))[0]?.address, "remote@example.com");
      assert.strictEqual((yield* m.suggestContacts("alice")).length, 1);
      assert.deepStrictEqual(yield* m.suggestContacts("me@", { exclude: "ME@example.com" }), []);
      yield* m.setContactHidden("REMOTE@example.com", true);
      assert.deepStrictEqual(yield* m.suggestContacts("remote"), []);
      yield* m.setContactHidden("remote@example.com", false);
      server.contacts = [{ name: "Updated", address: "updated@example.com" }];
      yield* m.sync();
      assert.strictEqual((yield* m.contactSync)[0]?.count, 3);
      yield* TestClock.adjust("6 hours");
      yield* m.sync();
      assert.strictEqual((yield* m.contactSync)[0]?.count, 1);
      assert.deepStrictEqual(yield* m.suggestContacts("remote"), []);
      server.featureFailure = new FeatureScopeMissing({
        accountId: account.id,
        feature: "contacts",
        message: "missing contacts scope",
      });
      const result = yield* m.refreshContacts(account.id).pipe(Effect.result);
      assert.strictEqual(result._tag, "Success");
      assert.strictEqual((yield* m.contactSync)[0]?.scopeMissing, true);
      assert.strictEqual((yield* m.suggestContacts("updated")).length, 1);
      const mail = yield* m.sync();
      assert.ok(!mail[0]?.error);
      assert.strictEqual((yield* m.accounts)[0]?.needsReauth, false);
      server.featureFailure = undefined;
      yield* m.reauth(account.id);
      yield* m.refreshContacts(account.id);
      assert.strictEqual((yield* m.contactSync)[0]?.scopeMissing, false);
      yield* m.perform({ kind: "removeAccount", accountId: account.id }, user);
      assert.deepStrictEqual(yield* m.contactSync, []);
      assert.deepStrictEqual(yield* m.suggestContacts("updated"), []);
    }).pipe(Effect.provide(TestMailbox({ gmail: server })));
  },
);

it.effect(
  "a newer update or cancellation in the cached thread blocks responses to an old invitation",
  () => {
    const server = fakeServer("me@example.com", [incoming]);
    server.raw.set("m1", raw());
    return Effect.gen(function* () {
      const m = yield* Mailbox;
      const account = yield* m.connect({ provider: "gmail" });
      yield* m.sync();
      const [invite] = yield* m.invitations(`${account.id}/m1`);
      assert.ok(invite);
      for (const method of ["REQUEST", "CANCEL"]) {
        server.messages.set("m2", { ...incoming, providerId: "m2", date: 2000 });
        server.raw.set("m2", raw(method, 2));
        yield* m.sync();
        yield* m.invitations(`${account.id}/m2`);
        const result = yield* m
          .respondInvite(`${account.id}/m1`, invite.key, "accepted", user)
          .pipe(Effect.result);
        assert.strictEqual(result._tag, "Failure");
        assert.strictEqual(server.responses.length, 0);
      }
    }).pipe(Effect.provide(TestMailbox({ gmail: server })));
  },
);

it.effect("OAuth providers decide attendee identity for Gmail and Outlook aliases", () => {
  const gmail = fakeServer("first.last@gmail.com", [incoming]);
  const outlook = fakeServer("primary@outlook.com", [incoming]);
  gmail.raw.set(
    "m1",
    Buffer.from(
      raw().toString().replaceAll("mailto:me@example.com", "mailto:firstlast@googlemail.com"),
    ),
  );
  outlook.raw.set(
    "m1",
    Buffer.from(raw().toString().replaceAll("mailto:me@example.com", "mailto:alias@hotmail.com")),
  );
  return Effect.gen(function* () {
    const m = yield* Mailbox;
    for (const [provider, server] of [
      ["gmail", gmail],
      ["outlook", outlook],
    ] as const) {
      const account = yield* m.connect({ provider });
      yield* m.sync();
      const [invite] = yield* m.invitations(`${account.id}/m1`);
      assert.ok(invite);
      yield* m.respondInvite(`${account.id}/m1`, invite.key, "accepted", user);
      assert.strictEqual(server.responses.length, 1);
      assert.strictEqual(server.sent.length, 0);
    }
  }).pipe(Effect.provide(TestMailbox({ gmail, outlook })));
});

it.effect("IMAP flags an organizer differing from both From and Sender", () => {
  const server = fakeServer("me@example.com", [incoming]);
  server.raw.set(
    "m1",
    Buffer.from(
      raw()
        .toString()
        .replace(
          "From: alice@example.com",
          "From: stranger@example.com\r\nSender: delegate@example.com",
        ),
    ),
  );
  return Effect.gen(function* () {
    const m = yield* Mailbox;
    const account = yield* m.connect({
      provider: "imap",
      input: { preset: "custom", email: server.email, password: "test" },
    });
    yield* m.sync();
    const [invite] = yield* m.invitations(`${account.id}/m1`);
    assert.ok(invite);
    assert.strictEqual("organizerMismatch" in invite ? invite.organizerMismatch : undefined, true);
    assert.strictEqual(server.sent.length, 0);
  }).pipe(Effect.provide(TestMailbox({ imap: server })));
});

it.effect(
  "IMAP matches known login and send-as addresses and echoes the exact attendee in its REPLY",
  () => {
    const server = fakeServer("primary@example.com", [incoming]);
    const providers = Layer.succeed(Providers, { get: () => makeFakeProvider(server) });
    return Effect.gen(function* () {
      const m = yield* Mailbox;
      const store = yield* Store;
      const account = yield* m.connect({
        provider: "imap",
        input: { preset: "custom", email: server.email, password: "test" },
      });
      yield* store.setImapSettings(account.id, {
        preset: "custom",
        username: "login@example.com",
        imapHost: "imap.example.com",
        imapPort: 993,
        smtpHost: "smtp.example.com",
        smtpPort: 465,
        smtpSecure: true,
      });
      yield* store.replaceSendAs(account.id, [
        {
          accountId: account.id,
          address: "alias@example.com",
          name: "Alias",
          isDefault: false,
          signature: "",
        },
      ]);
      yield* m.sync();
      for (const alias of ["login@example.com", "alias@example.com"]) {
        server.raw.set(
          "m1",
          Buffer.from(
            raw().toString().replace("mailto:me@example.com", `mailto:${alias.toUpperCase()}`),
          ),
        );
        const [invite] = yield* m.invitations(`${account.id}/m1`);
        assert.ok(invite);
        assert.strictEqual(invite.responseAddress?.address, alias.toUpperCase());
        yield* m.respondInvite(`${account.id}/m1`, invite.key, "tentative", user);
        const content = server.sent.at(-1)?.message.calendar?.content;
        assert.ok(content);
        const [reply] = parseCalendar(content);
        assert.strictEqual(reply?.invite.attendees[0]?.address, alias.toUpperCase());
        assert.strictEqual(reply?.invite.attendees[0]?.status, "TENTATIVE");
        assert.strictEqual(server.sent.at(-1)?.message.to[0]?.address, "alice@example.com");
      }
    }).pipe(
      Effect.provide(
        MailboxLive({ backgroundFlush: false }).pipe(
          Layer.provideMerge(StoreLive),
          Layer.provide(providers),
          Layer.provide(MemoryPlatform()),
        ),
      ),
    );
  },
);

it.effect("connect returns while optional contacts pagination is still blocked", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const server = fakeServer("me@gmail.com");
    const adapter = makeFakeProvider(server);
    const providers = Layer.succeed(Providers, {
      get: () => ({
        ...adapter,
        contacts: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as([]),
          ),
      }),
    });
    yield* Effect.gen(function* () {
      const m = yield* Mailbox;
      const connecting = yield* Effect.forkChild(m.connect({ provider: "gmail" }));
      yield* Deferred.await(started);
      yield* Effect.yieldNow;
      const outcome = connecting.pollUnsafe();
      assert.ok(outcome);
      assert.strictEqual(outcome._tag, "Success");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(connecting);
    }).pipe(
      Effect.provide(
        MailboxLive({ backgroundFlush: false }).pipe(
          Layer.provide(
            Layer.mergeAll(StoreLive, providers).pipe(Layer.provideMerge(MemoryPlatform())),
          ),
        ),
      ),
    );
  }),
);

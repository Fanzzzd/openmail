import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databaseLayer } from "./platform/node/db.js";
import type { IncomingMessage, MailOp, Provider } from "./domain.js";
import { fakeServer, makeFakeProvider } from "./platform/node/fake-provider.js";
import { Mailbox } from "./mailbox.js";
import { MailboxLive } from "./mailbox-live.js";
import { MemoryPlatform } from "./platform/node/platform-memory.js";
import { NodeSystem } from "./platform/node/platform-node.js";
import { Providers } from "./services.js";
import { StoreLive } from "./store.js";
import {
  prepareQuoteHistory,
  meetingLinks,
  meetingUrl,
  messagesFrom,
  splitRepeatedQuote,
} from "./reading.js";
import { parseCalendar } from "./invites.js";

const incoming = (
  providerId: string,
  date: number,
  threadId = "conversation",
): IncomingMessage => ({
  providerId,
  date,
  threadId,
  subject: providerId,
  from: { name: providerId, address: `${providerId}@example.com` },
  to: [],
  cc: [],
  replyTo: [],
  bodyText: `Original ${providerId}`,
  bodyHtml: "",
  snippet: "",
  attachments: [],
  labels: ["INBOX"],
  isUnread: false,
  isStarred: false,
});

for (const provider of ["gmail", "outlook", "imap"] satisfies Provider[]) {
  it.effect(
    `${provider}: exact message actions, chronological unread suffix and older-message reply in a temp DB`,
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.sync(() => mkdtempSync(join(tmpdir(), "openmail-reader-"))),
          (folder) => Effect.sync(() => rmSync(folder, { recursive: true, force: true })),
        );
        const server = fakeServer(`${provider}@example.com`, [
          incoming("older", 1000),
          incoming("chosen", 2000),
          { ...incoming("draft", 2500), labels: ["DRAFT"] },
          { ...incoming("trashed", 2600), labels: ["TRASH"] },
          { ...incoming("spam", 2700), labels: ["SPAM"] },
          incoming("newer", 3000),
          { ...incoming("blocked", 5000, "blocked-thread"), labels: ["DRAFT"] },
          incoming("other", 4000, "other-thread"),
        ]);
        const adapter = makeFakeProvider(server, { strictFolders: true });
        const layer = MailboxLive({ backgroundFlush: false }).pipe(
          Layer.provide(
            Layer.merge(
              StoreLive.pipe(
                Layer.provide(
                  databaseLayer(join(directory, "mail.db")).pipe(Layer.provide(NodeSystem)),
                ),
              ),
              Layer.succeed(Providers, Providers.of({ get: () => adapter })),
            ),
          ),
          Layer.provide(MemoryPlatform()),
        );
        yield* Effect.gen(function* () {
          const mailbox = yield* Mailbox;
          const account = yield* mailbox.connect(
            provider === "imap"
              ? { provider, input: { preset: "icloud", email: server.email, password: "test" } }
              : { provider },
          );
          yield* mailbox.sync();
          const id = `${account.id}/chosen`;
          const original = yield* mailbox.thread(id);
          const ops: MailOp[] = [
            { kind: "archive" },
            { kind: "trash" },
            { kind: "star", value: true },
            { kind: "read", value: false },
          ];
          for (const op of ops) {
            server.pushed.length = 0;
            const batch = yield* mailbox.modifyWithUndo([id], op, true);
            yield* mailbox.sync();
            assert.ok(server.pushed.length > 0);
            assert.ok(server.pushed.every((push) => push.providerId === "chosen"));
            const thread = yield* mailbox.thread(id);
            assert.deepStrictEqual(
              thread.filter((message) => message.id !== id),
              original.filter((message) => message.id !== id),
            );
            const selected = thread.find((message) => message.id === id);
            assert.ok(selected);
            if (op.kind === "archive") assert.ok(!selected.labels.includes("INBOX"));
            if (op.kind === "trash") assert.ok(selected.labels.includes("TRASH"));
            if (op.kind === "star") assert.ok(selected.isStarred);
            if (op.kind === "read") assert.ok(selected.isUnread);
            yield* mailbox.undoBatch(batch.undoId);
            yield* mailbox.sync();
            assert.deepStrictEqual(yield* mailbox.thread(id), original);
          }
          server.pushed.length = 0;
          const suffix = yield* mailbox.markUnreadFrom(id);
          yield* mailbox.sync();
          assert.deepStrictEqual(server.pushed.map((push) => push.providerId).toSorted(), [
            "chosen",
            "newer",
          ]);
          assert.deepStrictEqual(
            (yield* mailbox.thread(id)).map((message) => [message.subject, message.isUnread]),
            [
              ["older", false],
              ["chosen", true],
              ["draft", false],
              ["trashed", false],
              ["spam", false],
              ["newer", true],
            ],
          );
          assert.strictEqual((yield* mailbox.thread(`${account.id}/other`))[0]?.isUnread, false);
          yield* mailbox.undoBatch(suffix.undoId);
          yield* mailbox.sync();
          assert.ok((yield* mailbox.thread(id)).every((message) => !message.isUnread));
          for (const excluded of ["draft", "trashed", "spam"]) {
            server.pushed.length = 0;
            const batch = yield* mailbox.markUnreadFrom(`${account.id}/${excluded}`);
            yield* mailbox.sync();
            assert.deepStrictEqual(
              server.pushed.map((push) => push.providerId),
              ["newer"],
            );
            yield* mailbox.undoBatch(batch.undoId);
            yield* mailbox.sync();
          }
          server.pushed.length = 0;
          assert.strictEqual(
            (yield* mailbox.markUnreadFrom(`${account.id}/blocked`).pipe(Effect.result))._tag,
            "Failure",
          );
          yield* mailbox.sync();
          assert.deepStrictEqual(server.pushed, []);
          assert.strictEqual(
            (yield* mailbox.markUnreadFrom(`${account.id}/missing`).pipe(Effect.result))._tag,
            "Failure",
          );
          yield* mailbox.perform(
            {
              kind: "send",
              accountId: account.id,
              message: {
                to: [{ name: "Older sender", address: "older@example.com" }],
                cc: [],
                bcc: [],
                subject: "Re: older",
                text: "Reply to older",
                attachments: [],
                mode: "reply",
                inReplyTo: `${account.id}/older`,
              },
            },
            { kind: "user", surface: "app" },
          );
          assert.deepStrictEqual(
            server.sent[0]?.original,
            Option.some({ providerId: "older", threadId: "conversation" }),
          );
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped),
  );
}

it("suffix selection includes equal-date successors and ignores display order", () => {
  const rows = [
    { id: "a", date: 1 },
    { id: "b", date: 1 },
    { id: "c", date: 2 },
  ];
  assert.deepStrictEqual(
    messagesFrom(rows, "b").map((message) => message.id),
    ["b", "c"],
  );
  assert.deepStrictEqual(
    messagesFrom(rows.toReversed(), "c").map((message) => message.id),
    ["c"],
  );
  assert.deepStrictEqual(messagesFrom(rows, "gone"), []);
});

it("meeting links require supported paths at exact allow-listed HTTPS origins", () => {
  const supported = [
    "https://meet.google.com/abc-defg-hij",
    "https://teams.microsoft.com/l/meetup-join/one?context=abc",
    "https://teams.live.com/meet/123",
    "https://us02web.zoom.us/j/123?pwd=secret",
    "https://zoom.us/my/example",
  ];
  for (const url of supported) assert.strictEqual(meetingUrl(url), url);
  for (const url of [
    "http://meet.google.com/abc-defg-hij",
    "https://meet.google.com.evil.test/abc-defg-hij",
    "https://meet.google.com:444/abc-defg-hij",
    "https://user@meet.google.com/abc-defg-hij",
    "https://evil.test/?next=https://meet.google.com/abc-defg-hij",
    "https://meet.google.com/",
    "https://zoom.us/download",
    "javascript:alert(1)",
    "https://unlisted.zoom.us/j/123",
  ])
    assert.strictEqual(meetingUrl(url), null);
  assert.deepStrictEqual(
    meetingLinks(
      `Join (${supported[0]}).`,
      `<a href="${supported[3]}&amp;next=1">meeting</a>`,
      supported[0] ?? "",
    ),
    [supported[0], `${supported[3]}&next=1`],
  );
});

it("only repeated trailing plain-text quotes collapse; unique content remains", () => {
  const old = "The original message has enough text to compare.";
  assert.deepStrictEqual(splitRepeatedQuote(`New reply\n> ${old}`, prepareQuoteHistory([old])), {
    body: "New reply",
    quote: `\n> ${old}`,
  });
  const unique = "New reply\n> This is a new quotation, not prior thread text.";
  assert.deepStrictEqual(splitRepeatedQuote(unique, prepareQuoteHistory([old])), {
    body: unique,
    quote: "",
  });
});

it("calendar-only descriptions and URL fields retain meeting links", () => {
  const parsed = parseCalendar(
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:meeting\r\nSUMMARY:Call\r\nDTSTART:20261002T090000Z\r\nDESCRIPTION:Join https://meet.google.com/abc-defg-hij\r\nURL:https://zoom.us/j/123\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
  );
  assert.strictEqual(parsed[0]?.invite.description, "Join https://meet.google.com/abc-defg-hij");
  assert.strictEqual(parsed[0]?.invite.url, "https://zoom.us/j/123");
});

it("quote history is normalized once and matching excludes the current and later bodies", () => {
  const old = "Original body with enough words to detect a repeated quotation.";
  const future = "A later message must never be used to collapse an earlier quotation.";
  let reads = 0;
  const bodies: string[] = [];
  Object.defineProperty(bodies, 0, {
    get: () => {
      reads++;
      return `> ${old}`;
    },
  });
  const history = prepareQuoteHistory(bodies);
  for (let index = 0; index < 10; index++)
    assert.ok(splitRepeatedQuote(`Reply\n> ${old}`, history).quote);
  assert.strictEqual(reads, 1);
  const thread = prepareQuoteHistory([old, future]);
  assert.deepStrictEqual(splitRepeatedQuote(`Reply\n> ${future}`, { ...thread, before: 1 }), {
    body: `Reply\n> ${future}`,
    quote: "",
  });
});

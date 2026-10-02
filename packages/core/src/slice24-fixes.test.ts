import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { StoreLive } from "./store.js";
import { Store } from "./services.js";
import { MemoryPlatform } from "./platform/node/platform-memory.js";
import { DEFAULT_PREFS, type IncomingMessage } from "./domain.js";
import { invitesFromRaw, parseCalendar } from "./platform/node/portable-helpers.js";
import { Mailbox } from "./mailbox.js";
import { TestMailbox, fakeServer } from "./platform/node/testing.js";

const calendar = (fields = "") =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:travel\r\nDTSTART:20261010T090000Z\r\nDTEND:20261010T100000Z\r\n${fields}END:VEVENT\r\nEND:VCALENDAR`;
it.effect(
  "MIME REQUEST is respected even without METHOD in the calendar; methodless participants are never personal events",
  () =>
    Effect.gen(function* () {
      const raw = Buffer.from(
        `MIME-Version: 1.0\r\nContent-Type: text/calendar; method=REQUEST\r\n\r\n${calendar("ORGANIZER:mailto:sender@example.com\r\n")}`,
      );
      const parsed = yield* invitesFromRaw(raw, true);
      assert.strictEqual(parsed[0]?.invite.method, "REQUEST");
      assert.deepStrictEqual(
        parseCalendar(calendar("ORGANIZER:mailto:sender@example.com\r\n"), true),
        [],
      );
      assert.deepStrictEqual(
        parseCalendar(calendar("ATTENDEE:mailto:me@example.com\r\n"), true),
        [],
      );
      assert.strictEqual(parseCalendar(calendar(), true)[0]?.invite.method, "PUBLISH");
    }),
);
it.effect(
  "preferences retain known elements and fields when future versions leave unknown settings",
  () =>
    Effect.gen(function* () {
      const store = yield* Store,
        sql = yield* SqlClient.SqlClient;
      for (const [key, value] of Object.entries({
        toolbarActions: ["star", "future-action", "archive"],
        labs: { markdown: false, futureLab: true },
        swipeActions: { leftShort: "star", leftLong: "future-action", futureGesture: "trash" },
      })) {
        yield* sql`INSERT INTO prefs(key,value_json) VALUES(${key},${JSON.stringify(value)})`;
      }
      const prefs = yield* store.prefs;
      assert.deepStrictEqual(prefs.toolbarActions, ["star", "archive"]);
      assert.deepStrictEqual(prefs.labs, { ...DEFAULT_PREFS.labs, markdown: false });
      assert.deepStrictEqual(prefs.swipeActions, {
        ...DEFAULT_PREFS.swipeActions,
        leftShort: "star",
      });
    }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
);
const mail: IncomingMessage = {
  providerId: "one",
  threadId: "one",
  subject: "Travel",
  from: { name: "", address: "a@example.com" },
  to: [],
  cc: [],
  date: 1,
  snippet: "",
  bodyText: "2026-10-10 09:00",
  bodyHtml: "",
  labels: ["INBOX"],
  attachments: [],
  isUnread: false,
  isStarred: false,
};
it.effect(
  "disabled accounts reject calendar reads and writes before fetching raw MIME; invalid link IDs never reach providers",
  () => {
    const server = fakeServer("me@outlook.com", [mail]);
    return Effect.gen(function* () {
      const m = yield* Mailbox,
        account = yield* m.connect({ provider: "outlook" });
      yield* m.sync();
      const id = `${account.id}/one`,
        [candidate] = yield* m.detectedEvents(id);
      assert.ok(candidate);
      yield* m.setAccountSettings(account.id, { enabled: false, description: "", color: null });
      assert.strictEqual((yield* m.detectedEvents(id).pipe(Effect.result))._tag, "Failure");
      assert.strictEqual(
        (yield* m
          .createCalendarEvent(id, candidate.key, { kind: "user", surface: "app" })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.strictEqual(server.createdEvents.length, 0);
      for (const request of [
        m.invitations(id),
        m.calendarEvents(id, "unused"),
        m.respondInvite(id, "unused", "accepted", { kind: "user", surface: "app" }),
      ]) {
        const result = yield* request.pipe(Effect.result);
        assert.strictEqual(result._tag === "Failure" && result.failure._tag, "InvalidInput");
      }
      const fetched = server.bodyFetched.length;
      for (const suffix of ["../events", "A?redirect=evil", "A#fragment", "%2Fusers", "A\nB"]) {
        const result = yield* m.messageWebUrl(`${account.id}/${suffix}`).pipe(Effect.result);
        assert.strictEqual(result._tag === "Failure" && result.failure._tag, "InvalidInput");
      }
      assert.strictEqual(server.bodyFetched.length, fetched);
    }).pipe(Effect.provide(TestMailbox({ outlook: server })));
  },
);

it.effect("disabled Outlook accounts cannot fetch a webLink for cached or absent messages", () => {
  const server = fakeServer("me@outlook.com", [mail]);
  return Effect.gen(function* () {
    const m = yield* Mailbox,
      account = yield* m.connect({ provider: "outlook" });
    yield* m.sync();
    server.messages.set("one", { ...mail, webLink: "https://outlook.live.com/mail/id/one" });
    server.messages.set("two", {
      ...mail,
      providerId: "two",
      webLink: "https://outlook.live.com/mail/id/two",
    });
    yield* m.setAccountSettings(account.id, { enabled: false, description: "", color: null });
    const before = server.bodyFetched.length;
    for (const id of ["one", "two"])
      assert.strictEqual(
        (yield* m.messageWebUrl(`${account.id}/${id}`).pipe(Effect.result))._tag,
        "Failure",
      );
    assert.strictEqual(server.bodyFetched.length, before);
  }).pipe(Effect.provide(TestMailbox({ outlook: server })));
});

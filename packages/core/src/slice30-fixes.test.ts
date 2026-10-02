import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { CalendarEvent } from "./calendar.js";
import type { IncomingMessage } from "./domain.js";
import { graphRecurrence } from "./graph-recurrence.js";
import { Mailbox } from "./mailbox.js";
import { fakeServer, TestMailbox } from "./testing.js";
import { Store, Providers } from "./services.js";
import { StoreLive } from "./store.js";
import { MemoryPlatform } from "./platform-memory.js";
import { invitesFromRaw } from "./invites.js";
import { makeProviderCalendar } from "./provider-calendar.js";
import { makeFakeProvider } from "./fake-provider.js";
import { MailboxLive } from "./mailbox-live.js";

const event: CalendarEvent = {
  key: "test",
  title: "Personal event",
  description: "",
  location: "",
  start: { kind: "date", value: "2026-10-26" },
  end: { kind: "date", value: "2026-10-27" },
  recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
};

it("Outlook refuses clamped dates and rules whose DTSTART does not match the pattern", () => {
  for (const [date, rule] of [
    ["2026-10-31", "FREQ=MONTHLY;BYMONTHDAY=31"],
    ["2026-10-29", "FREQ=MONTHLY"],
    ["2028-02-29", "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29"],
    ["2026-10-26", "FREQ=YEARLY;BYMONTHDAY=26"],
    ["2026-10-26", "FREQ=WEEKLY;BYDAY=WE"],
    ["2026-10-26", "FREQ=MONTHLY;BYMONTHDAY=15"],
    ["2026-10-26", "FREQ=MONTHLY;BYDAY=1MO"],
    ["2026-10-26", "FREQ=YEARLY;BYMONTH=11;BYMONTHDAY=26"],
  ]) {
    assert.throws(() =>
      graphRecurrence({
        ...event,
        start: { kind: "date", value: date ?? "" },
        recurrence: [`RRULE:${rule}`],
      }),
    );
  }
});

it.effect(
  "invitation history uses the UID index, has bounded results, and invalidates when the cached content changes",
  () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      const account = yield* store.upsertAccount("gmail", "me@example.com");
      const [parsed] = yield* invitesFromRaw(raw("indexed"));
      assert.ok(parsed);
      for (let i = 0; i < 225; i++) {
        const message = incoming(`cached-${i}`);
        yield* store.upsertMessage(account.id, message);
        yield* store.cacheInvites(`${account.id}/${message.providerId}`, [
          { ...parsed.invite, sequence: i },
        ]);
      }
      const history = yield* store.cachedInvites(account.id, "indexed");
      assert.strictEqual(history.length, 200);
      assert.strictEqual(history[0]?.sequence, 25);
      assert.strictEqual(history.at(-1)?.sequence, 224);
      assert.strictEqual((yield* store.inviteSiblingIds(account.id, "indexed", "none")).length, 20);
      assert.deepStrictEqual(yield* store.cachedInvites("another-account", "indexed"), []);
      const plan =
        yield* sql`EXPLAIN QUERY PLAN SELECT invite_json FROM calendar_invites WHERE account_id=${account.id} AND uid='indexed' ORDER BY sequence DESC,message_date DESC LIMIT 200`;
      const rows = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ detail: Schema.String })))(
        plan,
      );
      assert.ok(rows.some((row) => row.detail.includes("calendar_invites_uid")));
      assert.ok(!rows.some((row) => row.detail.includes("SCAN messages")));
      yield* store.upsertMessage(account.id, { ...incoming("cached-224"), bodyText: "Changed" });
      assert.strictEqual((yield* store.cachedInvites(account.id, "indexed")).at(-1)?.sequence, 223);
    }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
);

it.effect(
  "Outlook refuses a published recurring master with RECURRENCE-ID overrides in the same ICS before posting",
  () => {
    const server = fakeServer("me@example.com", [incoming("personal")]);
    server.raw.set(
      "personal",
      Buffer.from(
        "Content-Type: text/calendar; method=PUBLISH\r\n\r\nBEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:PUBLISH\r\nBEGIN:VEVENT\r\nUID:series\r\nSUMMARY:Personal event\r\nDTSTART;TZID=America/New_York:20261026T090000\r\nDTEND;TZID=America/New_York:20261026T100000\r\nRRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:series\r\nRECURRENCE-ID;TZID=America/New_York:20261102T090000\r\nDTSTART;TZID=America/New_York:20261102T110000\r\nDTEND;TZID=America/New_York:20261102T120000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
      ),
    );
    const posted: unknown[] = [];
    const graph = makeProviderCalendar(
      "outlook",
      <A>(_id: string, schema: Schema.Decoder<A>) =>
        Schema.decodeUnknownEffect(schema)({ value: [] }).pipe(Effect.orDie),
      (_id, _path, body) =>
        Effect.sync(() => {
          posted.push(body);
        }),
    );
    const adapter = { ...makeFakeProvider(server), ...graph };
    const provider = Layer.succeed(Providers, { get: () => adapter });
    return Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const account = yield* mailbox.connect({ provider: "outlook" });
      yield* mailbox.sync();
      const id = `${account.id}/personal`;
      const events = yield* mailbox.detectedEvents(id);
      const master = events.find((item) => item.recurrence.length);
      assert.ok(master?.hasRecurrenceOverrides);
      const result = yield* mailbox
        .createCalendarEvent(id, master.key, { kind: "user", surface: "app" })
        .pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(posted.length, 0);
    }).pipe(
      Effect.provide(
        MailboxLive({ backgroundFlush: false }).pipe(
          Layer.provide(
            Layer.mergeAll(StoreLive, provider).pipe(Layer.provideMerge(MemoryPlatform())),
          ),
        ),
      ),
    );
  },
);

const incoming = (id: string): IncomingMessage => ({
  providerId: id,
  threadId: id,
  subject: "Meeting",
  date: 1,
  snippet: "",
  from: { name: "", address: "organizer@example.com" },
  to: [{ name: "", address: "me@example.com" }],
  cc: [],
  bodyText: "",
  bodyHtml: "",
  labels: ["INBOX"],
  attachments: [{ filename: "meeting.ics", mimeType: "text/calendar", size: 1 }],
  hasCalendar: true,
  isUnread: false,
  isStarred: false,
});
const raw = (uid: string, sequence = 1, method = "REQUEST") =>
  Buffer.from(
    `From: organizer@example.com\r\nContent-Type: text/calendar; method=${method}\r\n\r\nBEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:${method}\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nSEQUENCE:${sequence}\r\nDTSTART:20261026T090000Z\r\nORGANIZER:mailto:organizer@example.com\r\nATTENDEE;PARTSTAT=ACCEPTED:mailto:me@example.com\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`,
  );

it.effect(
  "banner reads only its MIME and cached UID history; an unavailable cached sibling cannot block a response",
  () => {
    const ids = ["target", "reply", ...Array.from({ length: 12 }, (_, i) => `unrelated-${i}`)];
    const server = fakeServer("me@example.com", ids.map(incoming));
    for (const id of ids)
      server.raw.set(
        id,
        raw(
          id === "reply" || id === "target" ? "same" : id,
          1,
          id === "reply" ? "REPLY" : "REQUEST",
        ),
      );
    return Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const account = yield* mailbox.connect({ provider: "gmail" });
      yield* mailbox.sync();
      yield* mailbox.invitations(`${account.id}/reply`);
      server.rawFetched.length = 0;
      const [invite] = yield* mailbox.invitations(`${account.id}/target`);
      assert.ok(invite);
      assert.deepStrictEqual(server.rawFetched, ["target"]);
      assert.strictEqual(invite.threadStatus?.statuses[0]?.status, "ACCEPTED");
      server.raw.delete("reply");
      server.messages.delete("reply");
      yield* mailbox.respondInvite(`${account.id}/target`, invite.key, "accepted", {
        kind: "user",
        surface: "app",
      });
      assert.strictEqual(server.responses.length, 1);
      assert.ok(!server.rawFetched.some((id) => id.startsWith("unrelated")));
    }).pipe(Effect.provide(TestMailbox({ gmail: server })));
  },
);

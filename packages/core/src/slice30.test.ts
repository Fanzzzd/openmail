import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import type { Account, IncomingMessage } from "./domain.js";
import type { CalendarEvent } from "./calendar.js";
import { graphRecurrence } from "./graph-recurrence.js";
import { graphTimestamp } from "./graph-time.js";
import { parseCalendar } from "./invites.js";
import { makeProviderCalendar } from "./provider-calendar.js";
import { Mailbox } from "./mailbox.js";
import { fakeServer, TestMailbox } from "./testing.js";

const event: CalendarEvent = {
  key: "personal",
  uid: "personal@example.com",
  title: "Weekly train",
  location: "Station",
  description: "",
  start: {
    kind: "zoned",
    value: "2026-10-26T09:00:00",
    zone: "America/New_York",
    timestamp: Date.parse("2026-10-26T13:00:00Z"),
  },
  end: {
    kind: "zoned",
    value: "2026-10-26T10:00:00",
    zone: "Eastern Standard Time",
    timestamp: Date.parse("2026-10-26T14:00:00Z"),
  },
  recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3"],
};

it("Graph preserves TZID wall times through DST and maps all six patterns and three ranges", () => {
  const mapped = graphRecurrence(event);
  assert.deepStrictEqual(mapped.start, {
    dateTime: "2026-10-26T09:00:00",
    timeZone: "America/New_York",
  });
  assert.strictEqual(mapped.end.timeZone, "America/New_York");
  assert.deepStrictEqual(mapped.recurrence, {
    pattern: { type: "weekly", interval: 1, daysOfWeek: ["monday"], firstDayOfWeek: "monday" },
    range: {
      type: "numbered",
      startDate: "2026-10-26",
      recurrenceTimeZone: "America/New_York",
      numberOfOccurrences: 3,
    },
  });
  assert.strictEqual(
    graphTimestamp({ dateTime: "2026-11-02T09:00:00", timeZone: mapped.start.timeZone }),
    Date.parse("2026-11-02T14:00:00Z"),
  );
  for (const [rule, pattern] of [
    ["FREQ=DAILY;INTERVAL=2", { type: "daily", interval: 2 }],
    [
      "FREQ=WEEKLY;BYDAY=MO,WE;WKST=SU",
      {
        type: "weekly",
        interval: 1,
        daysOfWeek: ["monday", "wednesday"],
        firstDayOfWeek: "sunday",
      },
    ],
    ["FREQ=MONTHLY;BYMONTHDAY=26", { type: "absoluteMonthly", interval: 1, dayOfMonth: 26 }],
    [
      "FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=26",
      { type: "absoluteYearly", interval: 1, month: 10, dayOfMonth: 26 },
    ],
    [
      "FREQ=MONTHLY;BYDAY=-1MO",
      { type: "relativeMonthly", interval: 1, daysOfWeek: ["monday"], index: "last" },
    ],
    [
      "FREQ=YEARLY;BYMONTH=10;BYDAY=MO;BYSETPOS=4",
      { type: "relativeYearly", interval: 1, month: 10, daysOfWeek: ["monday"], index: "fourth" },
    ],
  ] satisfies [string, unknown][]) {
    const result = graphRecurrence({ ...event, recurrence: [`RRULE:${rule}`] });
    assert.deepStrictEqual(result.recurrence.pattern, pattern);
    assert.strictEqual(result.recurrence.range.type, "noEnd");
  }
  // Inclusive UNTIL is converted in the event zone, including a cutoff before today's occurrence.
  assert.deepStrictEqual(
    graphRecurrence({ ...event, recurrence: ["RRULE:FREQ=DAILY;UNTIL=20261103T135959Z"] })
      .recurrence.range,
    {
      type: "endDate",
      startDate: "2026-10-26",
      recurrenceTimeZone: "America/New_York",
      endDate: "2026-11-02",
    },
  );
  assert.deepStrictEqual(
    graphRecurrence({
      ...event,
      start: { kind: "date", value: "2026-10-26" },
      end: { kind: "date", value: "2026-10-27" },
      recurrence: ["RRULE:FREQ=DAILY;UNTIL=20261029"],
    }).recurrence.range.type,
    "endDate",
  );
});

it("Graph rejects exceptions, ambiguous/lossy patterns, malformed ranges and unknown recurring zones", () => {
  for (const recurrence of [
    ["RRULE:FREQ=DAILY", "EXDATE:20261027T090000Z"],
    ["RDATE:20261027T090000Z"],
    ["RRULE:FREQ=MONTHLY;BYDAY=MO"],
    ["RRULE:FREQ=YEARLY;BYDAY=1MO"],
    ["RRULE:FREQ=DAILY;BYHOUR=9"],
    ["RRULE:FREQ=DAILY;INTERVAL=0"],
    ["RRULE:FREQ=DAILY;COUNT=2;UNTIL=20261029"],
    ["RRULE:FREQ=DAILY;COUNT=0"],
    ["RRULE:FREQ=DAILY;UNTIL=20261032T090000Z"],
    ["RRULE:FREQ=MONTHLY;BYDAY=5MO"],
    ["RRULE:FREQ=DAILY;FREQ=WEEKLY"],
    ["RRULE:FREQ=DAILY;UNTIL=20251001T090000Z"],
  ])
    assert.throws(() => graphRecurrence({ ...event, recurrence }));
  assert.throws(() =>
    graphRecurrence({
      ...event,
      start: {
        ...event.start,
        kind: "zoned",
        zone: "Custom/Office",
        value: "2026-10-26T09:00:00",
        timestamp: event.start.kind === "zoned" ? event.start.timestamp : null,
      },
    }),
  );
});

it.effect(
  "a published recurring personal ICS maps to Graph and deduplicates; unsupported recurrence never posts",
  () =>
    Effect.gen(function* () {
      const [parsed] = parseCalendar(
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:PUBLISH\r\nBEGIN:VEVENT\r\nUID:personal@example.com\r\nDTSTART;TZID=America/New_York:20261026T090000\r\nDTEND;TZID=America/New_York:20261026T100000\r\nRRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3\r\nSUMMARY:Weekly train\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
        true,
      );
      assert.ok(parsed?.invite.start && parsed.invite.end);
      const imported: CalendarEvent = {
        ...event,
        start: parsed.invite.start,
        end: parsed.invite.end,
        recurrence: parsed.invite.recurrence,
      };
      const account: Account = {
        id: "outlook:me@example.com",
        provider: "outlook",
        email: "me@example.com",
        createdAt: 0,
        lastSyncedAt: null,
        lastSyncError: null,
        profileId: null,
        needsReauth: false,
      };
      const posts: unknown[] = [];
      const adapter = makeProviderCalendar(
        "outlook",
        <A>(_id: string, schema: Schema.Decoder<A>) =>
          Schema.decodeUnknownEffect(schema)({ value: [] }).pipe(Effect.orDie),
        (_id, _path, body) =>
          Effect.sync(() => {
            posts.push(body);
          }),
      );
      yield* adapter.createCalendarEvent(account, imported);
      yield* adapter.createCalendarEvent(account, imported);
      assert.strictEqual(posts.length, 1);
      const body = Schema.decodeUnknownSync(Schema.Struct({ recurrence: Schema.Unknown }))(
        posts[0],
      );
      assert.deepStrictEqual(body.recurrence, graphRecurrence(imported).recurrence);
      const failed = yield* adapter
        .createCalendarEvent(account, {
          ...imported,
          recurrence: [...imported.recurrence, "EXDATE:20261102T140000Z"],
        })
        .pipe(Effect.result);
      assert.strictEqual(failed._tag, "Failure");
      assert.strictEqual(posts.length, 1);
    }),
);

const incoming = (id: string): IncomingMessage => ({
  providerId: id,
  threadId: id,
  subject: "Meeting",
  from: { name: "", address: "alice@example.com" },
  to: [{ name: "", address: "me@example.com" }],
  cc: [],
  date: Number(id.slice(1)) * 1000,
  snippet: "",
  bodyText: "",
  bodyHtml: "",
  labels: ["INBOX"],
  attachments: [{ filename: "invite.ics", mimeType: "text/calendar", size: 100 }],
  isUnread: false,
  isStarred: false,
  hasCalendar: true,
});
const raw = (method: string, sequence: number, extra = "", organizer = "alice@example.com") =>
  Buffer.from(
    `Content-Type: text/calendar; method=${method}\r\n\r\nBEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:${method}\r\nBEGIN:VEVENT\r\nUID:shared-event\r\nSEQUENCE:${sequence}\r\nDTSTART:20261026T090000Z\r\nSUMMARY:Meeting\r\nORGANIZER:mailto:${organizer}\r\n${extra}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`,
  );
const user = { kind: "user", surface: "app" } as const;

it.effect(
  "invitation replies, reschedules and cancellation aggregate across independent threads, scoped by account and organizer",
  () => {
    const server = fakeServer("me@example.com", [
      incoming("m1"),
      incoming("m2"),
      incoming("m3"),
      incoming("m4"),
    ]);
    const other = fakeServer("other@example.com", [incoming("m5")]);
    other.raw.set("m5", raw("CANCEL", 50));
    server.raw.set("m1", raw("REQUEST", 1, "ATTENDEE:mailto:me@example.com"));
    server.raw.set("m2", raw("REPLY", 1, "ATTENDEE;PARTSTAT=ACCEPTED:mailto:me@example.com"));
    server.raw.set("m3", raw("CANCEL", 9, "", "stranger@example.com"));
    server.raw.set(
      "m4",
      raw(
        "REPLY",
        1,
        "RECURRENCE-ID:20261102T090000Z\r\nATTENDEE;PARTSTAT=DECLINED:mailto:me@example.com",
      ),
    );
    return Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const account = yield* mailbox.connect({ provider: "gmail" });
      yield* mailbox.connect({ provider: "outlook" });
      yield* mailbox.sync();
      const id = `${account.id}/m1`;
      for (const providerId of ["m2", "m3", "m4"])
        yield* mailbox.invitations(`${account.id}/${providerId}`);
      let [invite] = yield* mailbox.invitations(id);
      assert.ok(invite);
      assert.strictEqual(invite.threadStatus?.cancelled, false);
      assert.strictEqual(invite.threadStatus?.statuses[0]?.status, "ACCEPTED");
      yield* mailbox.respondInvite(id, invite.key, "tentative", user);
      assert.strictEqual(
        (yield* mailbox.invitations(id))[0]?.threadStatus?.statuses[0]?.status,
        "TENTATIVE",
      );
      server.raw.set(
        "m2",
        Buffer.from(
          raw("REQUEST", 2, "ATTENDEE:mailto:me@example.com")
            .toString()
            .replace("DTSTART:20261026T090000Z", "DTSTART:20261026T100000Z"),
        ),
      );
      yield* mailbox.invitations(`${account.id}/m2`);
      [invite] = yield* mailbox.invitations(id);
      assert.ok(invite);
      assert.strictEqual(invite.threadStatus?.sequence, 2);
      assert.notStrictEqual(invite.threadStatus?.statuses[0]?.status, "TENTATIVE");
      assert.strictEqual(
        (yield* mailbox.respondInvite(id, invite.key, "accepted", user).pipe(Effect.result))._tag,
        "Failure",
      );
      const latest = (yield* mailbox.invitations(`${account.id}/m2`))[0];
      assert.ok(latest?.previous);
      server.raw.set("m2", raw("CANCEL", 2));
      yield* mailbox.invitations(`${account.id}/m2`);
      assert.strictEqual((yield* mailbox.invitations(id))[0]?.threadStatus?.cancelled, true);
      assert.strictEqual(
        (yield* mailbox.respondInvite(id, invite.key, "accepted", user).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.strictEqual(server.responses.length, 1);
    }).pipe(Effect.provide(TestMailbox({ gmail: server, outlook: other })));
  },
);

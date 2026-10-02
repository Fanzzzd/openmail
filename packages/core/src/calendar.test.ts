import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { simpleParser } from "mailparser";
import { buildMime } from "./platform/node/compose.js";
import { formatCalendarRange, formatCalendarTime, shouldLoadInvitation } from "./calendar.js";
import {
  inviteCanRespond,
  inviteReply,
  invitesFromRaw,
  parseCalendar,
} from "./platform/node/portable-helpers.js";

const calendar = (event: string, method = "REQUEST", zones = "") =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:${method}\r\n${zones}BEGIN:VEVENT\r\nUID:meeting@example.com\r\nSEQUENCE:3\r\nSUMMARY:Planning\\, review\r\nLOCATION:Room 1\\nSecond floor\r\nORGANIZER;CN="Alice, Organizer":mailto:alice@example.com\r\nATTENDEE;CN=Me;PARTSTAT=NEEDS-ACTION:mailto:me@example.com\r\nATTENDEE;PARTSTAT=ACCEPTED:mailto:other@example.com\r\n${event}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

it("parses folded, escaped fields, zones, attendees and recurrence without expanding it", () => {
  const [p] = parseCalendar(
    calendar(
      "DTSTART;TZID=America/New_York:20260701T090000\r\nDTEND;TZID=America/New_York:20260701T100000\r\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,\r\n WE;COUNT=10\r\nEXDATE;TZID=America/New_York:20260708T090000",
    ),
  );
  assert.ok(p);
  assert.strictEqual(p.invite.title, "Planning, review");
  assert.strictEqual(p.invite.location, "Room 1\nSecond floor");
  assert.deepStrictEqual(p.invite.organizer, {
    name: "Alice, Organizer",
    address: "alice@example.com",
  });
  assert.strictEqual(p.invite.attendees.length, 2);
  assert.deepStrictEqual(p.invite.start, {
    kind: "zoned",
    value: "2026-07-01T09:00:00",
    zone: "America/New_York",
    timestamp: Date.parse("2026-07-01T13:00:00Z"),
  });
  assert.strictEqual(p.invite.recurrence.length, 2);
  assert.ok(p.invite.recurrence[0]?.includes("INTERVAL=2"));
  assert.ok(inviteCanRespond(p.invite, "ME@example.com"));
  assert.ok(!inviteCanRespond(p.invite, "stranger@example.com"));
  assert.ok(!inviteCanRespond(p.invite, "alice@example.com"));
});

it("preserves date-only, floating and unknown-zone values, and derives end from DURATION", () => {
  assert.deepStrictEqual(
    parseCalendar(calendar("DTSTART;VALUE=DATE:20260701\r\nDTEND;VALUE=DATE:20260702"))[0]?.invite
      .start,
    { kind: "date", value: "2026-07-01" },
  );
  const [floating] = parseCalendar(calendar("DTSTART:20260701T090000\r\nDURATION:PT1H"));
  assert.deepStrictEqual(floating?.invite.end, { kind: "floating", value: "2026-07-01T10:00:00" });
  const [unknown] = parseCalendar(calendar("DTSTART;TZID=MadeUp/Zone:20260701T090000"));
  assert.deepStrictEqual(unknown?.invite.start, {
    kind: "zoned",
    value: "2026-07-01T09:00:00",
    zone: "MadeUp/Zone",
    timestamp: null,
  });
  assert.ok(
    unknown?.invite.start && formatCalendarTime(unknown.invite.start, "en").includes("MadeUp/Zone"),
  );
});

it("uses embedded VTIMEZONE rules without registering untrusted global zones", () => {
  const zone =
    "BEGIN:VTIMEZONE\r\nTZID:Custom/Office\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0530\r\nTZOFFSETTO:+0530\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n";
  const [p] = parseCalendar(
    calendar("DTSTART;TZID=Custom/Office:20260701T090000", "REQUEST", zone),
  );
  assert.strictEqual(p?.invite.start?.kind, "zoned");
  if (p?.invite.start?.kind === "zoned")
    assert.strictEqual(p.invite.start.timestamp, Date.parse("2026-07-01T03:30:00Z"));
  const [next] = parseCalendar(calendar("DTSTART;TZID=Custom/Office:20260701T090000"));
  if (next?.invite.start?.kind === "zoned") assert.strictEqual(next.invite.start.timestamp, null);
});

it("recognizes sparse cancellation and replies, rejects invalid requests and ignores unrelated formats", () => {
  const [cancel] = parseCalendar(calendar("", "CANCEL"));
  assert.strictEqual(cancel?.invite.cancelled, true);
  assert.ok(cancel && !inviteCanRespond(cancel.invite, "me@example.com"));
  assert.strictEqual(parseCalendar(calendar("", "REPLY"))[0]?.invite.method, "REPLY");
  assert.deepStrictEqual(parseCalendar(calendar("", "REQUEST")), []);
  assert.deepStrictEqual(parseCalendar("broken"), []);
  assert.deepStrictEqual(parseCalendar(calendar("DTSTART:20260701T090000Z", "PUBLISH")), []);
});

it.effect("reads inline and attached .ics MIME with transfer encodings and deduplicates them", () =>
  Effect.gen(function* () {
    const source = calendar("DTSTART:20260701T090000Z\r\nDTEND:20260701T100000Z");
    for (const contentType of [
      "text/calendar; method=REQUEST; charset=utf-8",
      "application/octet-stream",
    ]) {
      const raw = yield* buildMime(
        { name: "Alice", address: "alice@example.com" },
        {
          to: [{ name: "Me", address: "me@example.com" }],
          cc: [],
          bcc: [],
          subject: "Meeting",
          text: "Invitation",
          attachments: [
            {
              filename: "invite.ics",
              mimeType: contentType,
              content: Buffer.from(source).toString("base64"),
            },
          ],
        },
      );
      const invites = yield* invitesFromRaw(raw);
      assert.strictEqual(invites.length, 1);
      assert.strictEqual(invites[0]?.invite.uid, "meeting@example.com");
    }
    const raw = Buffer.from(
      `MIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nInvitation\r\n--b\r\nContent-Type: text/calendar; method=REQUEST\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${source.replaceAll("=", "=3D")}\r\n--b--\r\n`,
    );
    assert.strictEqual((yield* invitesFromRaw(raw)).length, 1);
  }),
);

it.effect(
  "iTIP REPLY preserves identity, occurrence and sequence and contains only the responding attendee",
  () =>
    Effect.gen(function* () {
      const [parsed] = parseCalendar(
        calendar(
          "DTSTART;TZID=America/New_York:20260708T090000\r\nRECURRENCE-ID;TZID=America/New_York:20260708T090000",
        ),
      );
      assert.ok(parsed);
      for (const response of ["accepted", "tentative", "declined"] as const) {
        const outgoing = inviteReply(
          parsed,
          { name: "Me", address: "me@example.com" },
          response,
          "m1",
        );
        const raw = yield* buildMime({ name: "Me", address: "me@example.com" }, outgoing, {
          messageId: "<original@example.com>",
        });
        const mime = yield* Effect.promise(() => simpleParser(raw));
        assert.strictEqual(mime.inReplyTo, "<original@example.com>");
        const content = mime.attachments[0];
        assert.ok(content);
        assert.strictEqual(content.contentType, "text/calendar");
        assert.ok(content.headers.get("content-type"));
        const wire = raw.toString();
        assert.match(wire, /Content-Type: multipart\/alternative/i);
        assert.match(wire, /Content-Type: text\/calendar;[^\r\n]*method=REPLY/i);
        // The calendar alternative must not be treated as a downloadable attachment.
        const calendarPart = wire
          .split(/(?=Content-Type: text\/calendar)/i)[1]
          ?.split(/\r\n\r\n/)[0];
        assert.ok(calendarPart);
        assert.ok(!/Content-Disposition: attachment/i.test(calendarPart));
        const [reply] = parseCalendar(content.content.toString());
        assert.ok(reply);
        assert.strictEqual(reply.invite.method, "REPLY");
        assert.strictEqual(reply.invite.uid, parsed.invite.uid);
        assert.strictEqual(reply.invite.sequence, 3);
        assert.deepStrictEqual(reply.invite.recurrenceId, parsed.invite.recurrenceId);
        assert.deepStrictEqual(reply.invite.attendees, [
          { name: "Me", address: "me@example.com", status: response.toUpperCase() },
        ]);
        assert.ok(parsed.invite.organizer);
        assert.deepStrictEqual(outgoing.to, [parsed.invite.organizer]);
        assert.ok(!content.content.toString().includes("other@example.com"));
      }
    }),
);

it("all-day display uses the last inclusive day; invalid calendar dates are not normalized into a different meeting", () => {
  const [day] = parseCalendar(calendar("DTSTART;VALUE=DATE:20261001\r\nDTEND;VALUE=DATE:20261002"));
  assert.ok(day);
  assert.strictEqual(formatCalendarRange(day.invite, "en-US"), "Thursday, October 1, 2026");
  const [days] = parseCalendar(
    calendar("DTSTART;VALUE=DATE:20261001\r\nDTEND;VALUE=DATE:20261004"),
  );
  assert.ok(days);
  assert.ok(formatCalendarRange(days.invite, "en-US").endsWith("Saturday, October 3, 2026"));
  assert.deepStrictEqual(parseCalendar(calendar("DTSTART:20260231T090000Z")), []);
});

it("old messages without calendar evidence do not request raw MIME", () => {
  assert.strictEqual(shouldLoadInvitation({ attachments: [] }), false);
  assert.strictEqual(
    shouldLoadInvitation({
      hasCalendar: false,
      attachments: [{ filename: "photo.png", mimeType: "image/png", size: 10 }],
    }),
    false,
  );
  assert.strictEqual(shouldLoadInvitation({ hasCalendar: true, attachments: [] }), true);
  assert.strictEqual(
    shouldLoadInvitation({
      attachments: [{ filename: "INVITE.ICS", mimeType: "application/octet-stream", size: 10 }],
    }),
    true,
  );
  assert.strictEqual(
    shouldLoadInvitation({
      attachments: [{ filename: "part", mimeType: "Text/Calendar; charset=utf-8", size: 10 }],
    }),
    true,
  );
});

it.effect("calendar MIME respects its declared charset", () =>
  Effect.gen(function* () {
    const source = calendar("DTSTART:20260701T090000Z").replace(
      "Planning\\, review",
      "Café Müller",
    );
    const raw = Buffer.from(
      `MIME-Version: 1.0\r\nContent-Type: text/calendar; method=REQUEST; charset=iso-8859-1\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(source, "latin1").toString("base64")}`,
    );
    assert.strictEqual((yield* invitesFromRaw(raw))[0]?.invite.title, "Café Müller");
  }),
);

it.effect(
  "calendar parsing skips oversized parts and caps single- and multi-part invitations",
  () =>
    Effect.gen(function* () {
      const source = calendar("DTSTART:20260701T090000Z");
      const huge = source.replace(
        "END:VEVENT",
        `DESCRIPTION:${"a".repeat(1024 * 1024)}\r\nEND:VEVENT`,
      );
      assert.deepStrictEqual(parseCalendar(huge), []);
      const event = source.slice(source.indexOf("BEGIN:VEVENT"), source.indexOf("END:VCALENDAR"));
      const many = `BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\n${Array.from({ length: 25 }, (_, i) => event.replace("UID:meeting@example.com", `UID:meeting-${i}@example.com`)).join("")}END:VCALENDAR\r\n`;
      assert.strictEqual(parseCalendar(many).length, 20);
      const message = {
        to: [{ name: "", address: "me@example.com" }],
        cc: [],
        bcc: [],
        subject: "Invites",
        text: "Invites",
        attachments: [
          {
            filename: "huge.ics",
            mimeType: "text/calendar",
            content: Buffer.from(huge).toString("base64"),
          },
          ...Array.from({ length: 25 }, (_, i) => ({
            filename: `invite-${i}.ics`,
            mimeType: "text/calendar",
            content: Buffer.from(
              source.replace("UID:meeting@example.com", `UID:meeting-${i}@example.com`),
            ).toString("base64"),
          })),
        ],
      };
      const boundary = "calendar-size-test";
      const raw = Buffer.from(
        `MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=${boundary}\r\n\r\n${message.attachments.map((a) => `--${boundary}\r\nContent-Type: text/calendar; name=${a.filename}\r\nContent-Transfer-Encoding: base64\r\n\r\n${a.content.match(/.{1,76}/g)?.join("\r\n")}\r\n`).join("")}--${boundary}--\r\n`,
      );
      const invites = yield* invitesFromRaw(raw);
      assert.strictEqual(invites.length, 20);
      assert.strictEqual(invites[0]?.invite.uid, "meeting-0@example.com");
    }),
  { timeout: 15000 },
);

it.effect(
  "delegated Sender or From matching the organizer does not raise an IMAP spoof warning",
  () =>
    Effect.gen(function* () {
      for (const headers of [
        "From: alice@example.com\r\nSender: delegate@example.com",
        "From: delegate@example.com\r\nSender: ALICE@example.com",
      ]) {
        const raw = Buffer.from(
          `${headers}\r\nMIME-Version: 1.0\r\nContent-Type: text/calendar; method=REQUEST\r\n\r\n${calendar("DTSTART:20260701T090000Z")}`,
        );
        const [invite] = yield* invitesFromRaw(raw);
        assert.ok(invite);
        assert.strictEqual(invite.invite.organizerMismatch, false);
      }
    }),
);

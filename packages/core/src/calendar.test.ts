import { incoming as makeIncoming, TestMailbox, fakeServer } from "./platform/node/testing.js";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { simpleParser } from "mailparser";
import { buildMime } from "./platform/node/compose.js";
import {
  calendarRangeParts,
  formatCalendarRange,
  formatCalendarTime,
  shouldLoadInvitation,
  calendarTimestamp,
  calendarWindow,
  detectMailEvents,
  type CalendarEvent,
  inviteHistory,
  calendarEventIcs,
} from "./calendar.js";
import {
  inviteCanRespond,
  inviteReply,
  invitesFromRaw,
  parseCalendar,
} from "./platform/node/portable-helpers.js";
import { type IncomingMessage } from "./domain.js";
import { Mailbox } from "./mailbox.js";
{
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
    assert.deepStrictEqual(floating?.invite.end, {
      kind: "floating",
      value: "2026-07-01T10:00:00",
    });
    const [unknown] = parseCalendar(calendar("DTSTART;TZID=MadeUp/Zone:20260701T090000"));
    assert.deepStrictEqual(unknown?.invite.start, {
      kind: "zoned",
      value: "2026-07-01T09:00:00",
      zone: "MadeUp/Zone",
      timestamp: null,
    });
    assert.ok(
      unknown?.invite.start &&
        formatCalendarTime(unknown.invite.start, "en").includes("MadeUp/Zone"),
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

  it.effect(
    "reads inline and attached .ics MIME with transfer encodings and deduplicates them",
    () =>
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
    const [day] = parseCalendar(
      calendar("DTSTART;VALUE=DATE:20261001\r\nDTEND;VALUE=DATE:20261002"),
    );
    assert.ok(day);
    assert.strictEqual(formatCalendarRange(day.invite, "en-US"), "Thursday, October 1, 2026");
    const [days] = parseCalendar(
      calendar("DTSTART;VALUE=DATE:20261001\r\nDTEND;VALUE=DATE:20261004"),
    );
    assert.ok(days);
    assert.ok(formatCalendarRange(days.invite, "en-US").endsWith("Saturday, October 3, 2026"));
    assert.deepStrictEqual(calendarRangeParts(day.invite, "en-US"), {
      start: "Thursday, October 1, 2026",
      end: null,
    });
    assert.strictEqual(calendarRangeParts(days.invite, "en-US").end, "Saturday, October 3, 2026");
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

  it.effect("only the MIME From can suppress an organizer mismatch warning", () =>
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
        assert.strictEqual(invite.invite.organizerMismatch, headers.startsWith("From: delegate"));
      }
    }),
  );
}

{
  const message: IncomingMessage = makeIncoming("one", {
    threadId: "one",
    subject: "Train",
    from: { name: "", address: "tickets@example.com" },
    to: [],
    date: Date.parse("2026-10-01T00:00:00Z"),
    bodyText: "Departure 2026-10-10 09:00 to 10:30",
    labels: ["INBOX"],
  });

  const event: CalendarEvent = {
    key: "busy",
    title: "Personal meeting",
    start: { kind: "floating", value: "2026-10-10T09:30:00" },
    end: { kind: "floating", value: "2026-10-10T10:00:00" },
    location: "",
    description: "",
    recurrence: [],
  };

  const source = (method: string, title = "Travel") =>
    `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${method ? `METHOD:${method}\r\n` : ""}BEGIN:VEVENT\r\nUID:invite\r\nDTSTART:20261010T090000\r\nDTEND:20261010T103000\r\nSUMMARY:${title}\r\nEND:VEVENT\r\nEND:VCALENDAR`;

  const raw = (method: string, title?: string) =>
    Buffer.from(`MIME-Version: 1.0\r\nContent-Type: text/calendar\r\n\r\n${source(method, title)}`);

  it("detects explicit dates and ranges in local time, preserves all-day dates and rejects invalid times", () => {
    const [found] = detectMailEvents(message);
    assert.ok(found);
    assert.deepStrictEqual(found.start, {
      kind: "zoned",
      value: "2026-10-10T09:00:00",
      zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      timestamp: new Date("2026-10-10T09:00:00").getTime(),
    });
    assert.strictEqual(calendarTimestamp(found.end) - calendarTimestamp(found.start), 90 * 60000);
    const [day] = detectMailEvents({ ...message, bodyText: "Meeting 2026-10-10" });
    assert.ok(day);
    assert.deepStrictEqual(day.end, { kind: "date", value: "2026-10-11" });
    assert.strictEqual(calendarWindow(day).timeMin, new Date("2026-10-10T00:00:00").toISOString());
    assert.deepStrictEqual(
      detectMailEvents({
        ...message,
        bodyText: "2026-02-31 09:00, 2026-10-10 24:30, 2026-10-10 12:80",
      }),
      [],
    );
    assert.deepStrictEqual(parseCalendar(source("PUBLISH")), []);
    assert.strictEqual(parseCalendar(source("PUBLISH"), true)[0]?.invite.method, "PUBLISH");
    assert.strictEqual(parseCalendar(source(""), true)[0]?.invite.method, "PUBLISH");
  });

  it.effect(
    "event reading never creates; creation is app-only, rechecks the confirmed content and separates iTIP requests",
    () => {
      const server = fakeServer("me@gmail.com", [message]);
      return Effect.gen(function* () {
        const m = yield* Mailbox;
        const account = yield* m.connect({ provider: "gmail" });
        yield* m.sync();
        const id = `${account.id}/one`;
        const [candidate] = yield* m.detectedEvents(id);
        assert.ok(candidate);
        assert.strictEqual(server.createdEvents.length, 0);
        for (const actor of [
          { kind: "agent", surface: "mcp", name: "bot" },
          { kind: "user", surface: "cli" },
        ] as const)
          assert.strictEqual(
            (yield* m.createCalendarEvent(id, candidate.key, actor).pipe(Effect.result))._tag,
            "Failure",
          );
        yield* m.createCalendarEvent(id, candidate.key, { kind: "user", surface: "app" });
        assert.strictEqual(server.createdEvents.length, 1);
        server.messages.set("one", {
          ...message,
          hasCalendar: true,
          attachments: [{ filename: "travel.ics", mimeType: "text/calendar", size: 300 }],
        });
        server.raw.set("one", raw("PUBLISH"));
        yield* m.sync();
        const [published] = yield* m.detectedEvents(id);
        assert.ok(published);
        server.raw.set("one", raw("PUBLISH", "Changed details"));
        assert.strictEqual(
          (yield* m
            .createCalendarEvent(id, published.key, { kind: "user", surface: "app" })
            .pipe(Effect.result))._tag,
          "Failure",
        );
        server.raw.set("one", raw("REQUEST"));
        assert.deepStrictEqual(yield* m.detectedEvents(id), []);
        const [invite] = yield* m.invitations(id);
        assert.ok(invite);
        server.calendarEvents.push(event, {
          ...event,
          key: "later",
          start: { kind: "floating", value: "2026-10-10T11:00:00" },
          end: { kind: "floating", value: "2026-10-10T12:00:00" },
        });
        assert.deepStrictEqual(
          (yield* m.calendarEvents(id, invite.key)).map((e) => e.key),
          ["busy"],
        );
        assert.strictEqual(server.createdEvents.length, 1);
        assert.ok((yield* m.audit(10)).some((entry) => entry.action === "calendar_create"));
      }).pipe(Effect.provide(TestMailbox({ gmail: server })));
    },
  );

  it("all-day query windows follow local DST rather than assuming every day has 24 hours", () => {
    const previous = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      const window = calendarWindow({
        start: { kind: "date", value: "2026-03-08" },
        end: { kind: "date", value: "2026-03-09" },
      });
      assert.strictEqual(window.timeMin, "2026-03-08T08:00:00.000Z");
      assert.strictEqual(window.timeMax, "2026-03-09T07:00:00.000Z");
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
}

{
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

  const mail: IncomingMessage = makeIncoming("one", {
    threadId: "one",
    subject: "Travel",
    from: { name: "", address: "a@example.com" },
    to: [],
    date: 1,
    bodyText: "2026-10-10 09:00",
    labels: ["INBOX"],
    isUnread: false,
  });

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
}

{
  const fixture = (providerId: string, overrides: Partial<IncomingMessage> = {}): IncomingMessage =>
    makeIncoming(providerId, {
      threadId: providerId,
      subject: "Project report",
      to: [{ name: "Bob", address: "bob@example.com" }],
      cc: [{ name: "Carol", address: "carol@example.com" }],
      bcc: [{ name: "Hidden", address: "hidden@example.com" }],
      rfcMessageId: `<${providerId}@example.com>`,
      size: 2_000_000,
      date: new Date(2026, 8, 20).getTime(),
      bodyText: "red fox budget",
      labels: ["INBOX", "UNREAD", "IMPORTANT", "CATEGORY_PERSONAL", "work"],
      attachments: [{ filename: "budget.pdf", mimeType: "application/pdf", size: 42 }],
      ...overrides,
    });

  const invitation = (
    sequence: number,
    start: string,
    location: string,
    method = "REQUEST",
    status = "NEEDS-ACTION",
  ) =>
    `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:${method}\r\nBEGIN:VEVENT\r\nUID:event@example.com\r\nSEQUENCE:${sequence}\r\nDTSTART:${start}\r\nDTEND:20261003T110000Z\r\nSUMMARY:Meeting\r\nLOCATION:${location}\r\nORGANIZER:mailto:org@example.com\r\nATTENDEE;ROLE=OPT-PARTICIPANT;PARTSTAT=${status}:mailto:me@example.com\r\nEND:VEVENT\r\nEND:VCALENDAR`;

  it("optional attendees survive replies and invite history compares time/location and summarizes responses", () => {
    const old = parseCalendar(invitation(1, "20261003T090000Z", "Old room"))[0];
    const next = parseCalendar(invitation(2, "20261003T100000Z", "New room"))[0];
    const response = parseCalendar(
      invitation(2, "20261003T100000Z", "New room", "REPLY", "ACCEPTED"),
    )[0];
    assert.ok(old && next && response);
    assert.strictEqual(next.invite.attendees[0]?.optional, true);
    const reply = inviteReply(
      next,
      { name: "Me", address: "me@example.com" },
      "accepted",
      "source",
    );
    assert.ok(reply.calendar?.content.includes("ROLE=OPT-PARTICIPANT"));
    const annotated = inviteHistory(next.invite, [old.invite, next.invite, response.invite]);
    assert.deepStrictEqual(annotated.previous, {
      start: old.invite.start,
      end: old.invite.end,
      location: "Old room",
    });
    assert.strictEqual(annotated.threadStatus?.statuses[0]?.status, "ACCEPTED");
    assert.strictEqual(
      inviteHistory(old.invite, [old.invite, next.invite]).threadStatus?.sequence,
      2,
    );
  });

  it.effect(
    "explicit RSVP persists in the thread summary and a newer sequence requires a new response",
    () => {
      const message = fixture("invite", { threadId: "meeting", hasCalendar: true });
      const server = fakeServer("me@example.com", [message]);
      const source = (sequence: number) =>
        Buffer.from(
          `From: org@example.com\r\nTo: me@example.com\r\nContent-Type: text/calendar; method=REQUEST\r\n\r\n${invitation(sequence, "20261003T100000Z", "Room")}`,
        );
      server.raw.set("invite", source(1));
      return Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const account = yield* mailbox.connect({ provider: "gmail" });
        yield* mailbox.sync();
        const id = `${account.id}/invite`;
        const [initial] = yield* mailbox.invitations(id);
        assert.ok(initial);
        yield* mailbox.respondInvite(id, initial.key, "accepted", { kind: "user", surface: "app" });
        assert.strictEqual(
          (yield* mailbox.invitations(id))[0]?.threadStatus?.statuses.find(
            (a) => a.address === "me@example.com",
          )?.status,
          "ACCEPTED",
        );
        server.raw.set("invite", source(2));
        assert.strictEqual(
          (yield* mailbox.invitations(id))[0]?.threadStatus?.statuses.find(
            (a) => a.address === "me@example.com",
          )?.status,
          "NEEDS-ACTION",
        );
        assert.strictEqual(server.responses.length, 1);
      }).pipe(Effect.provide(TestMailbox({ gmail: server })));
    },
  );
}

{
  const message = (id: string, bodyText = "alpha one beta"): IncomingMessage =>
    makeIncoming(id, {
      threadId: id,
      subject: "Travel",
      from: { name: "Sender", address: "sender@example.com" },
      to: [],
      date: 1,
      bodyText,
      labels: ["INBOX"],
      isUnread: false,
    });

  const actor = { kind: "user", surface: "app" } as const;

  it("structured JSON-LD flights, train microdata and reservations export inert, escaped ICS", () => {
    const flight = {
      "@context": "https://remote.invalid/context",
      "@type": "FlightReservation",
      reservationFor: {
        "@type": "Flight",
        flightNumber: "UA110",
        departureTime: "2026-10-03T20:15:00-08:00",
        arrivalTime: "2026-10-04T06:30:00-05:00",
        departureAirport: { name: "SFO" },
        arrivalAirport: { name: "JFK" },
      },
    };
    const events = detectMailEvents({
      subject: "Reservation",
      bodyText: "",
      bodyHtml: `<script type="application/ld+json">${JSON.stringify(flight)}</script><img src="https://remote.invalid/image">`,
    });
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0]?.title, "UA110");
    assert.strictEqual(events[0]?.location, "SFO → JFK");
    const train = detectMailEvents({
      subject: "Train",
      bodyText: "",
      bodyHtml:
        '<div itemscope itemtype="http://schema.org/TrainReservation"><div itemprop="reservationFor" itemscope itemtype="http://schema.org/TrainTrip"><meta itemprop="trainNumber" content="G123"><time itemprop="departureTime" datetime="2026-10-03T09:00:00+08:00"></time><meta itemprop="arrivalTime" content="2026-10-03T11:00:00+08:00"><div itemprop="departureStation" itemscope itemtype="https://schema.org/TrainStation"><span itemprop="name">南站</span></div></div></div>',
    });
    assert.strictEqual(train[0]?.title, "G123");
    const event = events[0];
    assert.ok(event);
    const ics = calendarEventIcs({
      ...event,
      title: "Trip, test\r\nLOCATION:injected",
      description: "行程".repeat(80),
    });
    assert.ok(!ics.includes("\r\nLOCATION:injected"));
    const parsed = parseCalendar(ics, true)[0]?.invite;
    assert.strictEqual(parsed?.title, "Trip, test\nLOCATION:injected");
    assert.strictEqual(
      parsed?.start?.kind === "zoned" ? parsed.start.timestamp : 0,
      Date.parse("2026-10-04T04:15:00Z"),
    );
    assert.strictEqual(parsed?.description, "行程".repeat(80));
    assert.ok(ics.split("\r\n").every((line) => new TextEncoder().encode(line).length <= 75));
    for (const reservation of [
      {
        "@type": "FoodEstablishmentReservation",
        startDate: "2026-10-03T18:00:00",
        endDate: "2026-10-03T20:00:00",
      },
      { "@type": "LodgingReservation", checkinTime: "2026-10-03", checkoutTime: "2026-10-05" },
    ])
      assert.strictEqual(
        detectMailEvents({
          subject: "Stay",
          bodyText: "",
          bodyHtml: `<script type="application/ld+json">${JSON.stringify(reservation)}</script>`,
        }).length,
        1,
      );
    for (const invalid of [
      { ...flight, reservationStatus: "https://schema.org/ReservationCancelled" },
      { "@type": "Event", startDate: "2026-02-30", endDate: "2026-03-01" },
      { "@type": "Event", startDate: "2026-10-03T12:00", endDate: "2026-10-03T11:00" },
    ])
      assert.deepStrictEqual(
        detectMailEvents({
          subject: "",
          bodyText: "",
          bodyHtml: `<script type="application/ld+json">${JSON.stringify(invalid)}</script>`,
        }),
        [],
      );
    assert.deepStrictEqual(
      detectMailEvents({
        subject: "",
        bodyText: "",
        bodyHtml: '<script type="application/ld+json">{broken</script>',
      }),
      [],
    );
  });

  it.effect(
    "structured event creation requires app confirmation and never fetches raw mail",
    () => {
      const server = fakeServer("me@gmail.com", [
        {
          ...message("one"),
          bodyText: "",
          bodyHtml:
            '<script type="application/ld+json">{"@type":"Event","name":"Dinner","startDate":"2026-10-03T18:00:00Z","endDate":"2026-10-03T20:00:00Z"}</script>',
        },
      ]);
      return Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const account = yield* mailbox.connect({ provider: "gmail" });
        yield* mailbox.sync();
        const id = `${account.id}/one`,
          event = (yield* mailbox.detectedEvents(id))[0];
        assert.ok(event);
        assert.strictEqual(
          (yield* mailbox
            .createCalendarEvent(id, event.key, { kind: "agent", name: "test", surface: "mcp" })
            .pipe(Effect.result))._tag,
          "Failure",
        );
        yield* mailbox.createCalendarEvent(id, event.key, actor);
        assert.strictEqual(server.createdEvents.length, 1);
        assert.deepStrictEqual(server.rawFetched, []);
      }).pipe(Effect.provide(TestMailbox({ gmail: server })));
    },
  );

  it("structured missing ends are estimated, date-only endDate is inclusive and unusable data falls back", () => {
    const parse = (data: unknown, bodyText = "") =>
      detectMailEvents({
        subject: "Trip",
        bodyText,
        bodyHtml: `<script type="application/ld+json">${JSON.stringify(data)}</script>`,
        date: Date.parse("2026-10-01T00:00:00Z"),
      });
    const food = parse({
      "@type": "FoodEstablishmentReservation",
      startTime: "2026-10-03T22:30:00",
    })[0];
    assert.ok(food);
    assert.strictEqual(food.endEstimated, true);
    assert.deepStrictEqual(food.end, { kind: "floating", value: "2026-10-04T00:30:00" });
    const flight = parse({
      "@type": "FlightReservation",
      reservationFor: { "@type": "Flight", departureTime: "2026-10-03T09:00:00+08:00" },
    })[0];
    assert.ok(flight);
    assert.strictEqual(flight.endEstimated, true);
    assert.strictEqual(
      flight.end.kind === "zoned" ? flight.end.timestamp : 0,
      Date.parse("2026-10-03T02:00:00Z"),
    );
    const event = parse({ "@type": "Event", startDate: "2026-10-03T09:00:00" })[0];
    assert.ok(event);
    assert.strictEqual(event.endEstimated, true);
    assert.deepStrictEqual(event.end, { kind: "floating", value: "2026-10-03T10:00:00" });
    for (const endDate of ["2026-10-03", "2026-10-05"]) {
      const day = parse({ "@type": "Event", startDate: "2026-10-03", endDate })[0];
      assert.ok(day);
      assert.deepStrictEqual(day.end, {
        kind: "date",
        value: endDate === "2026-10-03" ? "2026-10-04" : "2026-10-06",
      });
      assert.strictEqual(day.endEstimated, undefined);
    }
    const lodging = parse({
      "@type": "LodgingReservation",
      checkinTime: "2026-10-03",
      checkoutTime: "2026-10-05",
    })[0];
    assert.deepStrictEqual(lodging?.end, { kind: "date", value: "2026-10-05" });
    const body = "2026-10-03 09:00 to 10:00";
    assert.strictEqual(parse({ "@type": "Event", startDate: "invalid" }, body).length, 1);
    assert.strictEqual(
      parse(
        {
          "@type": "FlightReservation",
          reservationStatus: "https://schema.org/ReservationCancelled",
        },
        body,
      ).length,
      0,
    );
  });
}

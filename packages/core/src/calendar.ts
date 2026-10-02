import { Schema } from "effect";
import { Address, type Message, type Provider } from "./domain.js";

export const InviteResponse = Schema.Literals(["accepted", "tentative", "declined"]);
export type InviteResponse = typeof InviteResponse.Type;

export const InviteResponseRecord = Schema.Struct({
  accountId: Schema.String,
  uid: Schema.String,
  organizer: Schema.String,
  recurrenceId: Schema.String,
  sequence: Schema.Int,
  address: Address,
  response: InviteResponse,
});
export type InviteResponseRecord = typeof InviteResponseRecord.Type;

/** Preserve wall time when a sender uses an unknown zone; never guess UTC. */
export const CalendarTime = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("date"), value: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("floating"), value: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("zoned"),
    value: Schema.String,
    zone: Schema.String,
    timestamp: Schema.NullOr(Schema.Number),
  }),
]);
export type CalendarTime = typeof CalendarTime.Type;

export const CalendarEvent = Schema.Struct({
  key: Schema.String,
  uid: Schema.optionalKey(Schema.String),
  title: Schema.String,
  start: CalendarTime,
  end: CalendarTime,
  location: Schema.String,
  description: Schema.String,
  recurrence: Schema.Array(Schema.String),
  hasRecurrenceOverrides: Schema.optionalKey(Schema.Boolean),
});
export type CalendarEvent = typeof CalendarEvent.Type;

/** Date-only and floating values belong to the user's local calendar day. */
export function calendarTimestamp(time: CalendarTime): number {
  return time.kind === "zoned"
    ? (time.timestamp ?? NaN)
    : new Date(time.kind === "date" ? `${time.value}T00:00:00` : time.value).getTime();
}

export function calendarWindow(event: Pick<CalendarEvent, "start" | "end">) {
  const start = calendarTimestamp(event.start);
  const end = calendarTimestamp(event.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    throw new RangeError("Invalid calendar event time");
  return { timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString() };
}

/** Detect explicit ISO dates and times only; ambiguous prose is left to the person. */
export function detectMailEvents(message: Pick<Message, "subject" | "bodyText">): CalendarEvent[] {
  const result: CalendarEvent[] = [];
  const pattern =
    /\b(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(?::\d{2})?(Z|[+-]\d{2}:\d{2})?)?(?:\s*(?:–|—|-|to|至)\s*(\d{2}:\d{2}))?/g;
  for (const match of message.bodyText.slice(0, 100_000).matchAll(pattern)) {
    if (result.length >= 20) break;
    const date = match[1] ?? "";
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date
    )
      continue;
    if (
      [match[2], match[4]].some(
        (time) => time && (Number(time.slice(0, 2)) > 23 || Number(time.slice(3, 5)) > 59),
      )
    )
      continue;
    const wall = `${date}T${match[2]}:00`;
    const start: CalendarTime = !match[2]
      ? { kind: "date", value: date }
      : match[3]
        ? {
            kind: "zoned",
            value: `${wall}${match[3]}`,
            zone: "UTC",
            timestamp: Date.parse(`${wall}${match[3]}`),
          }
        : { kind: "floating", value: wall };
    const stamp = calendarTimestamp(start);
    if (!Number.isFinite(stamp)) continue;
    let end: CalendarTime;
    if (start.kind === "date") {
      const day = new Date(`${date}T00:00:00Z`);
      day.setUTCDate(day.getUTCDate() + 1);
      end = { kind: "date", value: day.toISOString().slice(0, 10) };
    } else if (match[4]) {
      const value = `${date}T${match[4]}:00${match[3] ?? ""}`;
      end =
        start.kind === "floating"
          ? { kind: "floating", value }
          : { kind: "zoned", value, zone: "UTC", timestamp: Date.parse(value) };
    } else
      end = {
        kind: "zoned",
        value: new Date(stamp + 3600000).toISOString(),
        zone: "UTC",
        timestamp: stamp + 3600000,
      };
    if (calendarTimestamp(end) <= stamp || !Number.isFinite(calendarTimestamp(end))) continue;
    result.push({
      key: `text:${match.index}:${match[0]}`,
      title: message.subject,
      start,
      end,
      location: "",
      description: message.bodyText.slice(0, 8000),
      recurrence: [],
    });
  }
  return result;
}

export const CalendarInvite = Schema.Struct({
  key: Schema.String,
  uid: Schema.String,
  sequence: Schema.Int,
  method: Schema.Literals(["REQUEST", "CANCEL", "REPLY", "PUBLISH"]),
  cancelled: Schema.Boolean,
  title: Schema.String,
  start: Schema.NullOr(CalendarTime),
  end: Schema.NullOr(CalendarTime),
  location: Schema.String,
  description: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  organizer: Schema.NullOr(Address),
  attendees: Schema.Array(
    Schema.Struct({
      ...Address.fields,
      status: Schema.String,
      optional: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  /** RFC 5545 rules/dates, rendered without expanding an unbounded series. */
  recurrence: Schema.Array(Schema.String),
  recurrenceId: Schema.NullOr(CalendarTime),
  /** Derived from the MIME From and Sender, never from the invitation's own claim. */
  organizerMismatch: Schema.optionalKey(Schema.Boolean),
  /** IMAP identity matched against addresses the user has already configured. */
  responseAddress: Schema.optionalKey(Address),
  previous: Schema.optionalKey(
    Schema.Struct({
      start: Schema.NullOr(CalendarTime),
      end: Schema.NullOr(CalendarTime),
      location: Schema.String,
    }),
  ),
  threadStatus: Schema.optionalKey(
    Schema.Struct({
      sequence: Schema.Int,
      cancelled: Schema.Boolean,
      statuses: Schema.Array(Schema.Struct({ ...Address.fields, status: Schema.String })),
    }),
  ),
});
export type CalendarInvite = typeof CalendarInvite.Type;

/** Local time plus the sender's zone. Date-only values do not shift zones. */
export function formatCalendarTime(time: CalendarTime, locale: string): string {
  if (time.kind === "date")
    return new Intl.DateTimeFormat(locale, { dateStyle: "full", timeZone: "UTC" }).format(
      new Date(`${time.value}T00:00:00Z`),
    );
  if (time.kind === "floating")
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(time.value),
    );
  if (time.timestamp === null) return `${time.value.replace("T", " ")} (${time.zone})`;
  const local = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
    time.timestamp,
  );
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (localZone === time.zone) return `${local} (${time.zone})`;
  return `${local} (${localZone}); ${time.value.replace("T", " ").replace(/Z$/, "")} (${time.zone})`;
}

/** DTEND on an all-day event is exclusive, unlike the last day shown to a person. */
export function formatCalendarRange(
  invite: Pick<CalendarInvite, "start" | "end">,
  locale: string,
): string {
  if (!invite.start) return "";
  if (!invite.end) return formatCalendarTime(invite.start, locale);
  if (invite.start.kind === "date" && invite.end.kind === "date") {
    const last = new Date(Date.parse(`${invite.end.value}T00:00:00Z`) - 86400000)
      .toISOString()
      .slice(0, 10);
    const start = formatCalendarTime(invite.start, locale);
    return last <= invite.start.value
      ? start
      : `${start} → ${formatCalendarTime({ kind: "date", value: last }, locale)}`;
  }
  return `${formatCalendarTime(invite.start, locale)} → ${formatCalendarTime(invite.end, locale)}`;
}

/** Old NULL hints are not evidence of an invite. Do not fetch every cached message. */
export function shouldLoadInvitation(
  message: Pick<Message, "hasCalendar" | "attachments">,
): boolean {
  return (
    message.hasCalendar === true ||
    message.attachments.some(
      (a) =>
        a.mimeType.split(";", 1)[0]?.trim().toLowerCase() === "text/calendar" ||
        /\.ics$/i.test(a.filename),
    )
  );
}

export function matchingInviteAttendee(
  invite: CalendarInvite,
  addresses: readonly string[],
): Address | null {
  const known = new Set(addresses.map((a) => a.trim().toLowerCase()));
  const attendee = invite.attendees.find((a) => known.has(a.address.toLowerCase()));
  return attendee ? { name: attendee.name, address: attendee.address } : null;
}

/** OAuth providers know their account aliases. SMTP needs an explicit local identity. */
export function inviteCanRespond(
  invite: CalendarInvite,
  email: string,
  provider: Provider = "imap",
  knownAddresses: readonly string[] = [],
): boolean {
  if (invite.method !== "REQUEST" || invite.cancelled || !invite.organizer) return false;
  if (provider !== "imap") return true;
  const attendee = matchingInviteAttendee(invite, [email, ...knownAddresses]);
  return (
    attendee !== null && invite.organizer.address.toLowerCase() !== attendee.address.toLowerCase()
  );
}

/** Compare only the same organizer/event occurrence; later replies supply attendee status. */
export function inviteHistory(
  invite: CalendarInvite,
  history: readonly CalendarInvite[],
): CalendarInvite {
  const same = history
    .filter(
      (other) =>
        other.uid === invite.uid &&
        other.organizer?.address.toLowerCase() === invite.organizer?.address.toLowerCase() &&
        (other.recurrenceId?.value ?? "") === (invite.recurrenceId?.value ?? ""),
    )
    .toSorted((a, b) => a.sequence - b.sequence);
  const requests = same.filter((other) => other.method === "REQUEST");
  const previous = requests.filter((other) => other.sequence < invite.sequence).at(-1);
  const latest = same.filter((other) => other.method !== "REPLY").at(-1) ?? invite;
  const statuses = new Map(
    latest.attendees.map((attendee) => [attendee.address.toLowerCase(), attendee]),
  );
  for (const reply of same.filter(
    (other) => other.method === "REPLY" && other.sequence === latest.sequence,
  ))
    for (const attendee of reply.attendees) statuses.set(attendee.address.toLowerCase(), attendee);
  const changed =
    previous &&
    (JSON.stringify(previous.start) !== JSON.stringify(invite.start) ||
      JSON.stringify(previous.end) !== JSON.stringify(invite.end) ||
      previous.location !== invite.location);
  return {
    ...invite,
    ...(changed
      ? { previous: { start: previous.start, end: previous.end, location: previous.location } }
      : {}),
    threadStatus: {
      sequence: latest.sequence,
      cancelled: latest.cancelled,
      statuses: [...statuses.values()],
    },
  };
}

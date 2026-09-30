import { Schema } from "effect";
import { Address, type Message, type Provider } from "./domain.js";

export const InviteResponse = Schema.Literals(["accepted", "tentative", "declined"]);
export type InviteResponse = typeof InviteResponse.Type;

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

export const CalendarInvite = Schema.Struct({
  key: Schema.String,
  uid: Schema.String,
  sequence: Schema.Int,
  method: Schema.Literals(["REQUEST", "CANCEL", "REPLY"]),
  cancelled: Schema.Boolean,
  title: Schema.String,
  start: Schema.NullOr(CalendarTime),
  end: Schema.NullOr(CalendarTime),
  location: Schema.String,
  organizer: Schema.NullOr(Address),
  attendees: Schema.Array(Schema.Struct({ ...Address.fields, status: Schema.String })),
  /** RFC 5545 rules/dates, rendered without expanding an unbounded series. */
  recurrence: Schema.Array(Schema.String),
  recurrenceId: Schema.NullOr(CalendarTime),
  /** Derived from the MIME From and Sender, never from the invitation's own claim. */
  organizerMismatch: Schema.optionalKey(Schema.Boolean),
  /** IMAP identity matched against addresses the user has already configured. */
  responseAddress: Schema.optionalKey(Address),
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

import { sha256Hex } from "./platform/crypto.js";
import { structuredMailEvents } from "./structured-events.js";
import { CalendarTime, calendarTimestamp } from "./calendar-time.js";
export { CalendarTime, calendarTimestamp } from "./calendar-time.js";
import { Schema } from "effect";
import {
  calendarAmbiguousDays,
  calendarDateCandidates,
  calendarParseDates,
  type DateContext,
  type DateParseResult,
  calendarWallTime,
  calendarZoneName,
  localCalendarTimeZone,
} from "./event-dates.js";
import {
  eventRecurrenceRule,
  validateRecurrenceStart,
  type CalendarEventEdits,
} from "./event-recurrence.js";
import { InvalidInput } from "./domain/errors.js";
export * from "./event-dates.js";
export * from "./event-recurrence.js";
import { Address, type Message, type Provider } from "./domain/domain.js";

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

export const CalendarEvent = Schema.Struct({
  key: Schema.String,
  uid: Schema.optionalKey(Schema.String),
  title: Schema.String,
  start: CalendarTime,
  end: CalendarTime,
  location: Schema.String,
  description: Schema.String,
  recurrence: Schema.Array(Schema.String),
  endEstimated: Schema.optionalKey(Schema.Boolean),
  dateInput: Schema.optionalKey(Schema.String),
  hasRecurrenceOverrides: Schema.optionalKey(Schema.Boolean),
});
export type CalendarEvent = typeof CalendarEvent.Type;

export function calendarWindow(event: Pick<CalendarEvent, "start" | "end">) {
  const start = calendarTimestamp(event.start);
  const end = calendarTimestamp(event.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    throw new RangeError("Invalid calendar event time");
  return { timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString() };
}

/**
 * Words that make a date in prose likely to be an appointment rather than a mention.
 * Rooms and "stay tuned" name no appointment.
 */
const EVENT_WORDS =
  /\b(?:meeting(?!\s+rooms?\b)|meet|call|sync|catch(?:ing)?\s+up|webinar|deadline|appointment|interview|conference(?!\s+rooms?\b)|workshop|seminar|lecture|class|session|demo|rsvp|invit(?:e|ation)|reservation|booking|check-?in|check-?out|stay(?!\s+(?:tuned|current|updated|safe|connected|informed|ahead|in\s+touch)\b)|flight|departure|dinner|lunch|breakfast|party|dentist|doctor)s?\b|(?<![\d:])1:1(?![\d:])|会议(?!室)|开会|截止|面试|预约|讲座|研讨会|航班|出发|入住|聚餐/i;
/** How far an event word may sit from a numbered date, and from "today" or "Friday". */
const NUMBERED_REACH = 40;
const WORD_REACH = 30;
/** Prose rarely names more appointments than this; more is a sign of a digest or newsletter. */
const MAX_TEXT_EVENTS = 5;
/** A clock or clock range without any date word, like a "3:12 read time". */
const TIME_ONLY =
  /^(?:at\s+)?(?:[\d:.\s–—~-]|am|pm|a\.m\.|p\.m\.|noon|midnight|to|上午|下午|晚上|中午|凌晨|早上|点|分|半|至|到|[零一二两三四五六七八九十])+$/i;
/** Digits that form a date: 2026-10-10, 10/12 or 12.10.2026. */
const NUMERIC_DATE = /\d{4}-\d{1,2}|\d{1,2}\/\d{1,2}|\d{1,2}\.\d{1,2}\.\d{2,4}/;
/** A date that names a day by number, not only by a word like "today" or "Tuesday". */
const NUMBERED_DAY = /\d|[零一二两三四五六七八九十]+[月日号]/;
const SENTENCE_END = /[.!?](?:\s|$)|[。！？\n]/;
const DAY = 86_400_000;
const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / DAY;

/** An event word in the candidate's sentence, at most `reach` characters away. */
function nearEventWord(text: string, index: number, length: number, reach: number): boolean {
  const before =
    text
      .slice(Math.max(0, index - reach), index)
      .split(SENTENCE_END)
      .at(-1) ?? "";
  const after = text.slice(index + length, index + length + reach).split(SENTENCE_END)[0] ?? "";
  return EVENT_WORDS.test(`${before} ${text.slice(index, index + length)} ${after}`);
}

/**
 * A prose date becomes a candidate with a time, or next to an event word in its
 * sentence. "Today" or "Friday" needs the word closer than a numbered date does.
 * Nothing before the message is offered: not a past day, not an earlier time, and
 * not an ambiguous date whose every reading is past. An all-day date at most about
 * a year ahead is offered; a timed one may be later.
 */
function usefulTextEvent(
  parsed: DateParseResult,
  input: string,
  index: number,
  text: string,
  context: DateContext,
): boolean {
  const messageDay = calendarWallTime(context.reference, context.timeZone).slice(0, 10);
  const nearWord = () =>
    nearEventWord(
      text,
      index,
      input.length,
      NUMBERED_DAY.test(input) ? NUMBERED_REACH : WORD_REACH,
    );
  if (parsed.kind === "invalid") return false;
  if (parsed.kind === "ambiguous") {
    const days = calendarAmbiguousDays(input, context);
    return !(days.length && days.every((day) => day < messageDay)) && nearWord();
  }
  const start = parsed.start.value.slice(0, 10);
  if (!Number.isFinite(dayNumber(start)) || start < messageDay) return false;
  // A time before the message was sent reports something that already happened.
  if (parsed.start.kind === "zoned")
    return (parsed.start.timestamp ?? Infinity) >= context.reference;
  if (parsed.start.kind !== "date") return true;
  // A whole day of "today" is how promotions talk; an appointment today has a time.
  if (start === messageDay && !NUMBERED_DAY.test(input)) return false;
  return dayNumber(start) - dayNumber(messageDay) <= 366 && nearWord();
}

/** The message date anchors relative expressions, so reopening never moves a candidate. */
export function detectMailEvents(
  message: Pick<Message, "subject" | "bodyText"> & Partial<Pick<Message, "bodyHtml" | "date">>,
  context: DateContext = {
    reference: message.date ?? Date.now(),
    timeZone: localCalendarTimeZone(),
  },
): CalendarEvent[] {
  const structured = structuredMailEvents(message.bodyHtml ?? "", message.subject);
  if (structured.events.length || structured.cancelled) return structured.events;
  const starts = new Set<string>();
  const candidates = calendarDateCandidates(message.bodyText);
  return candidates
    .flatMap(({ input, index }, position) => {
      // "24/7" means always, never July 24.
      if ((TIME_ONLY.test(input) && !NUMERIC_DATE.test(input)) || input === "24/7") return [];
      // A weekday beside a numbered date, as in "Tuesday, October 6", only names that date.
      const previous = candidates[position - 1];
      const next = candidates[position + 1];
      if (
        !NUMBERED_DAY.test(input) &&
        ((previous && index - (previous.index + previous.input.length) <= 2) ||
          (next && next.index - (index + input.length) <= 2))
      )
        return [];
      const parsed = calendarParseDates(input, context);
      if (!usefulTextEvent(parsed, input, index, message.bodyText, context)) return [];
      // An ambiguous date stays for the person to complete in the dialog.
      const times =
        parsed.kind === "parsed"
          ? { start: parsed.start, end: parsed.end }
          : {
              start: { kind: "floating", value: "" } satisfies CalendarTime,
              end: { kind: "floating", value: "" } satisfies CalendarTime,
            };
      // Repeated mentions of one start, like a subject line and a footer, collapse into one.
      const start = parsed.kind === "parsed" ? JSON.stringify(parsed.start) : `?${input}`;
      if (starts.has(start)) return [];
      starts.add(start);
      return [
        {
          key: `text:${index}:${input}`,
          title: message.subject,
          ...times,
          dateInput: input,
          endEstimated: parsed.kind === "parsed" && parsed.endEstimated,
          location: "",
          description: message.bodyText.slice(0, 8000),
          recurrence: [],
        },
      ];
    })
    .slice(0, MAX_TEXT_EVENTS);
}

/** Only dates and a typed repeat rule can be edited; identity and source details stay server-owned. */
export function editCalendarEvent(
  event: CalendarEvent,
  edits: CalendarEventEdits,
  reference: number,
): CalendarEvent {
  let result = event;
  if (edits.dates) {
    const parsed = calendarParseDates(edits.dates.input, {
      reference,
      timeZone: edits.dates.timeZone,
    });
    if (parsed.kind !== "parsed")
      throw new InvalidInput({
        message:
          parsed.kind === "ambiguous"
            ? parsed.reason === "dst"
              ? "This time is skipped or repeated by daylight saving. Enter a date and time with a UTC offset"
              : "Date is ambiguous. Enter an explicit date and time"
            : "Invalid calendar event time",
      });
    result = {
      ...result,
      start: parsed.start,
      end: parsed.end,
      endEstimated: parsed.endEstimated,
      dateInput: edits.dates.input,
    };
  }
  if (edits.recurrence !== undefined) {
    if (event.hasRecurrenceOverrides)
      throw new InvalidInput({ message: "Cannot edit a series with recurrence overrides" });
    result = {
      ...result,
      recurrence:
        edits.recurrence === null ? [] : [eventRecurrenceRule(edits.recurrence, result.start)],
    };
  }
  if (
    event.uid &&
    JSON.stringify([event.start, event.end, event.recurrence]) !==
      JSON.stringify([result.start, result.end, result.recurrence])
  ) {
    const { uid: _sourceUid, ...copy } = result;
    result = copy;
  }
  calendarWindow(result);
  validateRecurrenceStart(result);
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
  /** Derived from the MIME From, never from the invitation's own claim. */
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
  const localZone = localCalendarTimeZone();
  if (localZone === time.zone) return `${local} (${time.zone})`;
  return `${local} (${localZone}); ${time.value.replace("T", " ").replace(/Z$/, "")} (${time.zone})`;
}

/** DTEND on an all-day event is exclusive, unlike the last day shown to a person. */
/** The formatted start and end; end is null for a single time or a one-day event. */
export function calendarRangeParts(
  invite: Pick<CalendarInvite, "start" | "end">,
  locale: string,
): { start: string; end: string | null } {
  if (!invite.start) return { start: "", end: null };
  const start = formatCalendarTime(invite.start, locale);
  if (!invite.end) return { start, end: null };
  if (invite.start.kind === "date" && invite.end.kind === "date") {
    const last = new Date(Date.parse(`${invite.end.value}T00:00:00Z`) - 86400000)
      .toISOString()
      .slice(0, 10);
    return {
      start,
      end:
        last <= invite.start.value
          ? null
          : formatCalendarTime({ kind: "date", value: last }, locale),
    };
  }
  return { start, end: formatCalendarTime(invite.end, locale) };
}

export function formatCalendarRange(
  invite: Pick<CalendarInvite, "start" | "end">,
  locale: string,
): string {
  const { start, end } = calendarRangeParts(invite, locale);
  return end === null ? start : `${start} → ${end}`;
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

const escapeCalendarText = (value: string) =>
  value
    .replaceAll("\\", "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replaceAll(",", "\\,")
    .replaceAll(";", "\\;")
    .replaceAll("\r", "");
const icsTime = (time: CalendarTime) => {
  if (time.kind === "date") return `;VALUE=DATE:${time.value.replaceAll("-", "")}`;
  if (time.kind === "floating")
    return `:${(time.value.length === 16 ? `${time.value}:00` : time.value).replaceAll("-", "").replaceAll(":", "")}`;
  if (time.timestamp === null) throw new RangeError("Cannot export an unknown time zone");
  return `:${new Date(time.timestamp)
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(/\.\d{3}/, "")}`;
};

/** IANA TZID keeps a downloaded series on its local clock across DST. */
function recurringIcsTime(time: CalendarTime): string {
  if (time.kind === "date") return icsTime(time);
  const zone = time.kind === "zoned" ? time.zone : localCalendarTimeZone();
  const stamp = calendarTimestamp(time);
  const wall = calendarWallTime(stamp, zone).replaceAll("-", "").replaceAll(":", "");
  // Intl validates and canonicalizes the TZID before it becomes an ICS parameter.
  const canonical = calendarZoneName(zone);
  return `;TZID=${canonical}:${wall}`;
}

/** Export confirmed events without needing a calendar permission. */
export function calendarEventIcs(event: CalendarEvent): string {
  calendarWindow(event);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//OpenMail//Calendar//EN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${escapeCalendarText(event.uid ?? `openmail-${sha256Hex(event.key)}@openmail.local`)}`,
    "DTSTAMP:19700101T000000Z",
    `DTSTART${event.recurrence.length ? recurringIcsTime(event.start) : icsTime(event.start)}`,
    `DTEND${event.recurrence.length ? recurringIcsTime(event.end) : icsTime(event.end)}`,
    `SUMMARY:${escapeCalendarText(event.title)}`,
    `LOCATION:${escapeCalendarText(event.location)}`,
    `DESCRIPTION:${escapeCalendarText(event.description)}`,
    ...event.recurrence,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines
    .map((line) => {
      const folded: string[] = [];
      let part = "",
        bytes = 0;
      for (const character of line) {
        const size = new TextEncoder().encode(character).length;
        if (bytes + size > 75) {
          folded.push(part);
          part = " ";
          bytes = 1;
        }
        part += character;
        bytes += size;
      }
      folded.push(part);
      return folded.join("\r\n");
    })
    .join("\r\n")}\r\n`;
}

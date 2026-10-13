import { Buffer } from "../platform/bytes.js";
import { Effect, Result, Schema } from "effect";
import ICAL from "ical.js";
import { parseMime } from "../platform/mail-codec.js";
import {
  inviteCanRespond,
  type CalendarInvite,
  type CalendarTime,
  type InviteResponse,
} from "./calendar.js";
export { inviteCanRespond } from "./calendar.js";
import type { Address } from "../domain/message.js";
import type { OutgoingMessage } from "../domain/changes.js";
import { InvalidInput, ProviderError } from "../domain/errors.js";
import { graphTimestamp } from "./graph-time.js";
import { decodeBytes } from "../mime/mime.js";

const value = (component: ICAL.Component, name: string): unknown =>
  component.getFirstPropertyValue(name);
const text = (component: ICAL.Component, name: string): string => {
  const v = value(component, name);
  return typeof v === "string" ? v : "";
};
const parameter = (property: ICAL.Property, name: string): string => {
  const v: unknown = property.getParameter(name);
  return typeof v === "string" ? v : "";
};
const address = (property: ICAL.Property): Address | null => {
  const v: unknown = property.getFirstValue();
  if (typeof v !== "string" || !/^mailto:/i.test(v)) return null;
  const email = v.slice(7);
  if (!/^[^\s@<>;,]+@[^\s@<>;,]+$/.test(email)) return null;
  return { name: parameter(property, "cn"), address: email };
};

function calendarTime(component: ICAL.Component, name: string): CalendarTime | null {
  const p = component.getFirstProperty(name);
  const original: unknown = p?.toJSON()[3];
  if (typeof original === "string") {
    const fields = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})Z?)?$/.exec(original);
    if (
      !fields ||
      Number(fields[2]) < 1 ||
      Number(fields[2]) > 12 ||
      Number(fields[3]) < 1 ||
      Number(fields[3]) > ICAL.Time.daysInMonth(Number(fields[2]), Number(fields[1])) ||
      Number(fields[4] ?? 0) > 23 ||
      Number(fields[5] ?? 0) > 59 ||
      Number(fields[6] ?? 0) > 59
    )
      throw new RangeError("Invalid calendar date");
  }
  const time: unknown = p?.getFirstValue();
  if (!(time instanceof ICAL.Time)) return null;
  const wall = time.toString();
  if (time.isDate) return { kind: "date", value: wall };
  const zone = p ? parameter(p, "tzid") : "";
  if (!zone && !wall.endsWith("Z")) return { kind: "floating", value: wall };
  const tz = zone || "UTC";
  const stamp = Result.try(() => {
    if (wall.endsWith("Z")) return Date.parse(wall);
    // A VTIMEZONE carried by this calendar takes priority over the system database.
    if (time.zone.tzid !== "floating") return time.toUnixTime() * 1000;
    return graphTimestamp({ dateTime: wall, timeZone: tz });
  });
  return { kind: "zoned", value: wall, zone: tz, timestamp: Result.getOrElse(stamp, () => null) };
}

export interface ParsedInvite {
  readonly invite: CalendarInvite;
  readonly event: ICAL.Component;
  readonly calendar: ICAL.Component;
}

const MAX_CALENDAR_BYTES = 1024 * 1024;
const MAX_INVITES = 20;
const ContentType = Schema.Struct({
  params: Schema.Struct({
    charset: Schema.optionalKey(Schema.String),
    method: Schema.optionalKey(Schema.String),
  }),
});
/** Malformed events do not hide valid siblings. Parsing never performs a response. */
export function parseCalendar(
  source: string,
  includePublished = false,
  mimeMethod = "",
): ParsedInvite[] {
  if (Buffer.byteLength(source, "utf8") > MAX_CALENDAR_BYTES) return [];
  const parsed = Result.try(() => ICAL.Component.fromString(source));
  if (parsed._tag === "Failure" || parsed.success.name !== "vcalendar") return [];
  const calendar = parsed.success;
  const declared = text(calendar, "method").toUpperCase();
  const mime = mimeMethod.trim().toUpperCase();
  if (declared && mime && declared !== mime) return [];
  const rawMethod = mime || declared;
  const method = !rawMethod && includePublished ? "PUBLISH" : rawMethod;
  if (
    method !== "REQUEST" &&
    method !== "CANCEL" &&
    method !== "REPLY" &&
    !(includePublished && method === "PUBLISH")
  )
    return [];
  const out: ParsedInvite[] = [];
  for (const event of calendar.getAllSubcomponents("vevent")) {
    if (out.length === MAX_INVITES) break;
    const result = Result.try((): CalendarInvite | null => {
      const uid = text(event, "uid");
      if (!uid) return null;
      const sequence = value(event, "sequence");
      const recurrenceId = calendarTime(event, "recurrence-id");
      const org = event.getFirstProperty("organizer");
      if (!rawMethod && (org || event.getAllProperties("attendee").length)) return null;
      const start = calendarTime(event, "dtstart");
      // REQUEST must carry DTSTART. CANCEL/REPLY can be sparse.
      if (method === "REQUEST" && !start) return null;
      let end = calendarTime(event, "dtend");
      const duration = value(event, "duration");
      if (!end && duration instanceof ICAL.Duration) {
        const time = value(event, "dtstart");
        if (time instanceof ICAL.Time) {
          const clone = time.clone();
          clone.addDuration(duration);
          const temp = new ICAL.Component("vevent");
          temp.addPropertyWithValue("dtend", clone);
          const startProperty = event.getFirstProperty("dtstart");
          const tz = startProperty ? parameter(startProperty, "tzid") : "";
          if (tz) temp.getFirstProperty("dtend")?.setParameter("tzid", tz);
          end = calendarTime(temp, "dtend");
        }
      }
      return {
        key: JSON.stringify([
          uid,
          recurrenceId?.value ?? "",
          typeof sequence === "number" ? sequence : 0,
        ]),
        uid,
        sequence:
          typeof sequence === "number" && Number.isInteger(sequence) && sequence >= 0
            ? sequence
            : 0,
        method,
        cancelled: method === "CANCEL" || text(event, "status").toUpperCase() === "CANCELLED",
        title: text(event, "summary"),
        start,
        end,
        location: text(event, "location"),
        description: text(event, "description"),
        url: text(event, "url"),
        organizer: org ? address(org) : null,
        attendees: event.getAllProperties("attendee").flatMap((p) => {
          const a = address(p);
          return a
            ? [
                {
                  ...a,
                  status: parameter(p, "partstat") || "NEEDS-ACTION",
                  ...(parameter(p, "role").toUpperCase() === "OPT-PARTICIPANT"
                    ? { optional: true }
                    : {}),
                },
              ]
            : [];
        }),
        recurrence: ["rrule", "rdate", "exdate"].flatMap((name) =>
          event.getAllProperties(name).map((p) => p.toICALString()),
        ),
        recurrenceId,
      };
    });
    if (result._tag === "Success" && result.success)
      out.push({ invite: result.success, event, calendar });
  }
  return out;
}

/** mailparser exposes inline text/calendar as an attachment too, including base64/QP. */
export const invitesFromRaw = (raw: Uint8Array, includePublished = false) =>
  parseMime(raw, { skipImageLinks: true }).pipe(
    Effect.mapError(() => new ProviderError({ message: "Cannot read calendar invitation" })),
    Effect.map((mail): ParsedInvite[] => {
      const sourceAddresses = new Set(
        [...(mail.from?.value ?? [])].flatMap((a) => (a.address ? [a.address.toLowerCase()] : [])),
      );
      const unique = new Map<string, ParsedInvite>();
      const add = (source: string, method = "") => {
        for (const p of parseCalendar(source, includePublished, method)) {
          if (unique.size === MAX_INVITES) break;
          unique.set(`${p.invite.method}:${p.invite.key}`, {
            ...p,
            invite: {
              ...p.invite,
              organizerMismatch:
                !!p.invite.organizer &&
                !sourceAddresses.has(p.invite.organizer.address.toLowerCase()),
            },
          });
        }
      };
      for (const attachment of mail.attachments) {
        if (unique.size === MAX_INVITES) break;
        if (
          attachment.content.length > MAX_CALENDAR_BYTES ||
          (attachment.contentType.toLowerCase() !== "text/calendar" &&
            !/\.ics$/i.test(attachment.filename ?? ""))
        )
          continue;
        const contentType = Schema.decodeUnknownOption(ContentType)(
          attachment.headers.get("content-type"),
        );
        add(
          decodeBytes(
            attachment.content,
            contentType._tag === "Some" ? contentType.value.params.charset : undefined,
          ),
          contentType._tag === "Some" ? contentType.value.params.method : undefined,
        );
      }
      // Also handle a calendar sent as a plain text file/body.
      if (
        unique.size < MAX_INVITES &&
        mail.text?.trimStart().startsWith("BEGIN:VCALENDAR") &&
        Buffer.byteLength(mail.text, "utf8") <= MAX_CALENDAR_BYTES
      ) {
        const type = Schema.decodeUnknownOption(ContentType)(mail.headers.get("content-type"));
        add(mail.text.trim(), type._tag === "Some" ? type.value.params.method : undefined);
      }
      return [...unique.values()];
    }),
  );

const RESPONSE_LABELS: Record<InviteResponse, string> = {
  accepted: "Accepted",
  tentative: "Tentative",
  declined: "Declined",
};

/**
 * Minimal iTIP REPLY, retaining UID, SEQUENCE, RECURRENCE-ID and sender timezone.
 * `label` names the response in the subject and text, in the language of the
 * person answering; callers without a language get English.
 */
export function inviteReply(
  parsed: ParsedInvite,
  me: Address,
  response: InviteResponse,
  messageId: string,
  label = RESPONSE_LABELS[response],
): OutgoingMessage {
  if (!inviteCanRespond(parsed.invite, me.address) || !parsed.invite.organizer)
    throw new InvalidInput({ message: "This invitation cannot be answered by this account" });
  const calendar = new ICAL.Component("vcalendar");
  calendar.addPropertyWithValue("version", "2.0");
  calendar.addPropertyWithValue("prodid", "-//OpenMail//Calendar//EN");
  calendar.addPropertyWithValue("method", "REPLY");
  for (const tz of parsed.calendar.getAllSubcomponents("vtimezone"))
    calendar.addSubcomponent(ICAL.Component.fromString(tz.toString()));
  const event = new ICAL.Component("vevent");
  for (const name of [
    "uid",
    "sequence",
    "recurrence-id",
    "dtstart",
    "dtend",
    "duration",
    "organizer",
    "summary",
  ]) {
    for (const p of parsed.event.getAllProperties(name))
      event.addProperty(ICAL.Property.fromString(p.toICALString()));
  }
  event.addPropertyWithValue("dtstamp", ICAL.Time.fromJSDate(new Date(), true));
  const attendee = new ICAL.Property("attendee");
  attendee.setValue(`mailto:${me.address}`);
  attendee.setParameter("partstat", response.toUpperCase());
  const originalAttendee = parsed.event
    .getAllProperties("attendee")
    .find((p) => address(p)?.address.toLowerCase() === me.address.toLowerCase());
  const role = originalAttendee ? parameter(originalAttendee, "role") : "";
  if (role) attendee.setParameter("role", role);
  if (me.name) attendee.setParameter("cn", me.name);
  event.addProperty(attendee);
  calendar.addSubcomponent(event);
  return {
    to: [parsed.invite.organizer],
    cc: [],
    bcc: [],
    subject: `${label}: ${parsed.invite.title}`,
    text: `${me.address}: ${label}\n${parsed.invite.title}`,
    attachments: [],
    calendar: { method: "REPLY", content: calendar.toString() },
    inReplyTo: messageId,
    mode: "reply",
  };
}

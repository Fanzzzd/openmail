import { Schema } from "effect";
import type { CalendarEvent } from "./calendar.js";
import { graphRecurrence } from "./graph-recurrence.js";
import type { CalendarTime } from "./calendar-time.js";
import {
  calendarTimeDate,
  calendarZoneName,
  calendarWallInstants,
  calendarDateValid,
  localCalendarTimeZone,
} from "./event-dates.js";
import { InvalidInput } from "./domain/errors.js";

const Positive = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2147483647 }));
export const RecurrenceWeekday = Schema.Literals(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]);
export type RecurrenceWeekday = typeof RecurrenceWeekday.Type;
const Month = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 12 }));
const Day = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 31 }));
export const Ordinal = Schema.Literals([1, 2, 3, 4, 5, -1]);
export type Ordinal = typeof Ordinal.Type;
export const EventRecurrence = Schema.Struct({
  pattern: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("daily"), interval: Positive }),
    Schema.Struct({
      kind: Schema.Literal("weekly"),
      interval: Positive,
      weekdays: Schema.Array(RecurrenceWeekday).check(Schema.isMinLength(1)),
    }),
    Schema.Struct({ kind: Schema.Literal("monthly-date"), interval: Positive, day: Day }),
    Schema.Struct({
      kind: Schema.Literal("monthly-weekday"),
      interval: Positive,
      weekday: RecurrenceWeekday,
      ordinal: Ordinal,
    }),
    Schema.Struct({
      kind: Schema.Literal("yearly-date"),
      interval: Positive,
      month: Month,
      day: Day,
    }),
    Schema.Struct({
      kind: Schema.Literal("yearly-weekday"),
      interval: Positive,
      month: Month,
      weekday: RecurrenceWeekday,
      ordinal: Ordinal,
    }),
  ]),
  ending: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("never") }),
    Schema.Struct({ kind: Schema.Literal("count"), count: Positive }),
    Schema.Struct({ kind: Schema.Literal("until"), date: Schema.String }),
  ]),
});
export type EventRecurrence = typeof EventRecurrence.Type;
export const CalendarEventEdits = Schema.Struct({
  dates: Schema.optionalKey(Schema.Struct({ input: Schema.String, timeZone: Schema.String })),
  // Absence preserves an imported rule. Null explicitly removes it.
  recurrence: Schema.optionalKey(Schema.NullOr(EventRecurrence)),
});
export type CalendarEventEdits = typeof CalendarEventEdits.Type;

/** https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10
 * RFC 5545: timed DTSTART requires a UTC UNTIL; date-only DTSTART requires a DATE UNTIL. */
export function eventRecurrenceRule(rule: EventRecurrence, start: CalendarTime): string {
  if (start.kind === "zoned") calendarZoneName(start.zone);
  const pattern = rule.pattern;
  if (pattern.kind === "yearly-date" && !validMonthDay(pattern.month, pattern.day))
    throw new InvalidInput({ message: "Invalid calendar event time" });
  let body: string;
  switch (pattern.kind) {
    case "daily":
      body = "FREQ=DAILY";
      break;
    case "weekly":
      body = `FREQ=WEEKLY;BYDAY=${[...new Set(pattern.weekdays)].join(",")};WKST=MO`;
      break;
    case "monthly-date":
      body = `FREQ=MONTHLY;BYMONTHDAY=${pattern.day}`;
      break;
    case "monthly-weekday":
      body = `FREQ=MONTHLY;BYDAY=${pattern.ordinal}${pattern.weekday}`;
      break;
    case "yearly-date":
      body = `FREQ=YEARLY;BYMONTH=${pattern.month};BYMONTHDAY=${pattern.day}`;
      break;
    case "yearly-weekday":
      body = `FREQ=YEARLY;BYMONTH=${pattern.month};BYDAY=${pattern.ordinal}${pattern.weekday}`;
      break;
    default: {
      const exhaustive: never = pattern;
      return exhaustive;
    }
  }
  body += `;INTERVAL=${pattern.interval}`;
  if (rule.ending.kind === "count") body += `;COUNT=${rule.ending.count}`;
  if (rule.ending.kind === "until") {
    const date = rule.ending.date;
    const zone = start.kind === "zoned" ? start.zone : localCalendarTimeZone();
    const startDate = calendarTimeDate(start);
    if (!calendarDateValid(date) || date < startDate)
      throw new InvalidInput({ message: "Repeat end date must be on or after the event" });
    if (start.kind === "date") body += `;UNTIL=${date.replaceAll("-", "")}`;
    else {
      // Include the whole last local day, even when its UTC offset differs from DTSTART.
      const [stamp] = calendarWallInstants(`${date}T23:59:59`, zone);
      if (stamp === undefined) throw new InvalidInput({ message: "Invalid calendar event time" });
      body += `;UNTIL=${new Date(stamp)
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}/, "")}`;
    }
  }
  const recurrence = `RRULE:${body}`;
  validateRecurrenceStart({ start, recurrence: [recurrence] });
  return recurrence;
}

/** Reuse the provider's lossless mapping during preview as well as before HTTP. */
export function validateEventRecurrenceForProvider(
  event: CalendarEvent,
  provider: string | undefined,
): void {
  validateRecurrenceStart(event);
  if (provider === "outlook" && event.recurrence.length) graphRecurrence(event);
}
export function recurrenceWeekdayName(day: RecurrenceWeekday, locale: string): string {
  const weekdays = RecurrenceWeekday.literals;
  return new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(
    Date.UTC(2026, 9, 5 + weekdays.indexOf(day)),
  );
}
export function recurrenceMonthName(month: number, locale: string): string {
  if (!Number.isInteger(month) || month < 1 || month > 12) return "";
  return new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" }).format(
    Date.UTC(2000, month - 1, 1),
  );
}
export function recurrenceMonthDate(month: number, day: number, locale: string): string {
  if (!validMonthDay(month, day)) return "";
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(Date.UTC(2000, month - 1, day));
}

export function validMonthDay(month: number, day: number): boolean {
  return (
    Number.isInteger(month) &&
    month >= 1 &&
    month <= 12 &&
    Number.isInteger(day) &&
    day >= 1 &&
    day <= new Date(Date.UTC(2000, month, 0)).getUTCDate()
  );
}

function recurrenceStartMismatch(): never {
  throw new InvalidInput({ message: "Repeat pattern must include the event start date" });
}

/** DTSTART participates in COUNT in Google. It must satisfy every supplied date constraint. */
export function validateRecurrenceStart(event: Pick<CalendarEvent, "start" | "recurrence">): void {
  if (!event.recurrence.some((rule) => rule.startsWith("RRULE:"))) return;
  const date = calendarTimeDate(event.start);
  const stamp = Date.parse(`${date}T00:00:00Z`);
  if (!calendarDateValid(date)) throw new InvalidInput({ message: "Invalid calendar event time" });
  const day = Number(date.slice(8)),
    month = Number(date.slice(5, 7)),
    year = Number(date.slice(0, 4));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const weekday = RecurrenceWeekday.literals[(new Date(stamp).getUTCDay() + 6) % 7];
  for (const rule of event.recurrence.filter((value) => value.startsWith("RRULE:"))) {
    const fields = new Map(
      rule
        .slice(6)
        .split(";")
        .map((field) => {
          const [key = "", value = ""] = field.split("=");
          return [key, value];
        }),
    );
    const months = fields.get("BYMONTH"),
      dates = fields.get("BYMONTHDAY"),
      weekdays = fields.get("BYDAY"),
      position = fields.get("BYSETPOS");
    if (months && !months.split(",").map(Number).includes(month)) recurrenceStartMismatch();
    if (
      dates &&
      !dates
        .split(",")
        .map(Number)
        .some((value) => (value > 0 ? value === day : daysInMonth + value + 1 === day))
    )
      recurrenceStartMismatch();
    if (
      weekdays &&
      !weekdays.split(",").some((value) => {
        const match = /^(-?\d+)?(MO|TU|WE|TH|FR|SA|SU)$/.exec(value);
        if (!match || match[2] !== weekday) return false;
        if (!match[1]) return true;
        const ordinal = Number(match[1]);
        // A yearly ordinal without BYMONTH counts in the year, per RFC 5545.
        if (fields.get("FREQ") === "YEARLY" && !months) {
          const ordinalDay = Math.round((stamp - Date.UTC(year, 0, 1)) / 86400000) + 1;
          const yearDays = Math.round((Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86400000);
          return ordinal > 0
            ? Math.ceil(ordinalDay / 7) === ordinal
            : -Math.ceil((yearDays - ordinalDay + 1) / 7) === ordinal;
        }
        return ordinal > 0
          ? Math.ceil(day / 7) === ordinal
          : -Math.ceil((daysInMonth - day + 1) / 7) === ordinal;
      })
    )
      recurrenceStartMismatch();
    if (position && weekdays) {
      const allowed = new Set(weekdays.split(","));
      const matchingDates: number[] = [];
      for (let candidate = 1; candidate <= daysInMonth; candidate++) {
        const token =
          RecurrenceWeekday.literals[
            (new Date(Date.UTC(year, month - 1, candidate)).getUTCDay() + 6) % 7
          ];
        if (token && allowed.has(token)) matchingDates.push(candidate);
      }
      if (
        !position
          .split(",")
          .map(Number)
          .some(
            (index) => matchingDates[index > 0 ? index - 1 : matchingDates.length + index] === day,
          )
      )
        recurrenceStartMismatch();
    }
  }
}

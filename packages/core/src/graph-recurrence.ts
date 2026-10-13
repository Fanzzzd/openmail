import type { CalendarEvent, CalendarTime } from "./calendar.js";
import { InvalidInput } from "./domain/errors.js";
import { WINDOWS_ZONES } from "./windows-zones.js";

const DAYS = {
  SU: "sunday",
  MO: "monday",
  TU: "tuesday",
  WE: "wednesday",
  TH: "thursday",
  FR: "friday",
  SA: "saturday",
} as const;
type Day = (typeof DAYS)[keyof typeof DAYS];
type Index = "first" | "second" | "third" | "fourth" | "last";
type Pattern =
  | { type: "daily"; interval: number }
  | { type: "weekly"; interval: number; daysOfWeek: Day[]; firstDayOfWeek: Day }
  | { type: "absoluteMonthly"; interval: number; dayOfMonth: number }
  | { type: "absoluteYearly"; interval: number; dayOfMonth: number; month: number }
  | { type: "relativeMonthly"; interval: number; daysOfWeek: Day[]; index: Index }
  | { type: "relativeYearly"; interval: number; daysOfWeek: Day[]; index: Index; month: number };
type Range = { startDate: string; recurrenceTimeZone: string } & (
  | { type: "noEnd" }
  | { type: "numbered"; numberOfOccurrences: number }
  | { type: "endDate"; endDate: string }
);

function unsupported(): never {
  throw new InvalidInput({ message: "This recurrence cannot be represented in Outlook" });
}
function positive(value: string, max = 2_147_483_647): number {
  if (!/^[1-9]\d*$/.test(value)) return unsupported();
  const result = Number(value);
  return Number.isSafeInteger(result) && result <= max ? result : unsupported();
}
function day(value: string): Day {
  switch (value) {
    case "SU":
      return DAYS.SU;
    case "MO":
      return DAYS.MO;
    case "TU":
      return DAYS.TU;
    case "WE":
      return DAYS.WE;
    case "TH":
      return DAYS.TH;
    case "FR":
      return DAYS.FR;
    case "SA":
      return DAYS.SA;
    default:
      return unsupported();
  }
}
function index(value: string): Index {
  switch (value) {
    case "1":
      return "first";
    case "2":
      return "second";
    case "3":
      return "third";
    case "4":
      return "fourth";
    case "-1":
      return "last";
    default:
      return unsupported();
  }
}
function zone(time: CalendarTime): string {
  const candidate =
    time.kind === "zoned" ? time.zone : Intl.DateTimeFormat().resolvedOptions().timeZone;
  const mapped = WINDOWS_ZONES[candidate] ?? candidate;
  try {
    return new Intl.DateTimeFormat("en", { timeZone: mapped }).resolvedOptions().timeZone;
  } catch {
    throw new InvalidInput({ message: "This recurring event has a time zone Outlook cannot use" });
  }
}

function wallTime(timestamp: number, timeZone: string): string {
  const parts = new Map(
    new Intl.DateTimeFormat("en", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(timestamp)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}T${parts.get("hour")}:${parts.get("minute")}:${parts.get("second")}`;
}

/** Keep the wall time and TZID so Graph can apply DST to future occurrences. */
function recurringTime(time: CalendarTime) {
  const timeZone = zone(time);
  const dateTime =
    time.kind === "date"
      ? `${time.value}T00:00:00`
      : time.kind === "floating"
        ? time.value
        : time.timestamp !== null
          ? wallTime(time.timestamp, timeZone)
          : unsupported();
  return { dateTime, timeZone };
}

/** Field names and range semantics:
 * https://learn.microsoft.com/en-us/graph/api/resources/recurrencepattern
 * https://learn.microsoft.com/en-us/graph/api/resources/recurrencerange
 * Only lossless RRULE mappings. Exceptions/multiple rules are rejected before any POST. */
export function graphRecurrence(event: CalendarEvent): {
  start: ReturnType<typeof recurringTime>;
  end: ReturnType<typeof recurringTime>;
  recurrence: { pattern: Pattern; range: Range };
} {
  const [rule] = event.recurrence;
  if (event.hasRecurrenceOverrides || event.recurrence.length !== 1 || !rule?.startsWith("RRULE:"))
    return unsupported();
  const fields = new Map<string, string>();
  for (const field of rule.slice(6).split(";")) {
    const pair = /^([A-Z]+)=([^;=]+)$/.exec(field);
    if (!pair?.[1] || !pair[2] || fields.has(pair[1])) return unsupported();
    fields.set(pair[1], pair[2]);
  }
  if (
    [...fields.keys()].some(
      (key) =>
        ![
          "FREQ",
          "INTERVAL",
          "COUNT",
          "UNTIL",
          "BYDAY",
          "BYMONTHDAY",
          "BYMONTH",
          "BYSETPOS",
          "WKST",
        ].includes(key),
    )
  )
    return unsupported();
  const start = recurringTime(event.start),
    end = recurringTime(event.end);
  const date = start.dateTime.slice(0, 10);
  const interval = positive(fields.get("INTERVAL") ?? "1");
  const weekday = [DAYS.SU, DAYS.MO, DAYS.TU, DAYS.WE, DAYS.TH, DAYS.FR, DAYS.SA][
    new Date(`${date}T00:00:00Z`).getUTCDay()
  ];
  if (!weekday) return unsupported();
  const byDay = fields.get("BYDAY"),
    byMonthDay = fields.get("BYMONTHDAY"),
    byMonth = fields.get("BYMONTH"),
    bySetPos = fields.get("BYSETPOS");
  const frequency = fields.get("FREQ");
  let pattern: Pattern;
  if (frequency === "DAILY") {
    if (byDay || byMonthDay || byMonth || bySetPos) return unsupported();
    pattern = { type: "daily", interval };
  } else if (frequency === "WEEKLY") {
    if (byMonthDay || byMonth || bySetPos) return unsupported();
    pattern = {
      type: "weekly",
      interval,
      daysOfWeek: byDay ? byDay.split(",").map(day) : [weekday],
      firstDayOfWeek: day(fields.get("WKST") ?? "MO"),
    };
  } else if (frequency === "MONTHLY" || frequency === "YEARLY") {
    if (frequency === "MONTHLY" && byMonth) return unsupported();
    const month = positive(byMonth ?? date.slice(5, 7).replace(/^0/, ""), 12);
    if (byDay) {
      if (byMonthDay || (frequency === "YEARLY" && !byMonth)) return unsupported();
      const match = /^(-?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(byDay);
      if (!match?.[2] || (!match[1] && !bySetPos) || (match[1] && bySetPos)) return unsupported();
      const relative = {
        interval,
        daysOfWeek: [day(match[2])],
        index: index(match[1] ?? bySetPos ?? ""),
      };
      pattern =
        frequency === "MONTHLY"
          ? { type: "relativeMonthly", ...relative }
          : { type: "relativeYearly", ...relative, month };
    } else {
      if (bySetPos) return unsupported();
      if (frequency === "YEARLY" && byMonthDay && !byMonth) return unsupported();
      const dayOfMonth = positive(byMonthDay ?? date.slice(8, 10).replace(/^0/, ""), 31);
      if (
        (frequency === "MONTHLY" && dayOfMonth > 28) ||
        (frequency === "YEARLY" && month === 2 && dayOfMonth === 29)
      )
        return unsupported();
      pattern =
        frequency === "MONTHLY"
          ? { type: "absoluteMonthly", interval, dayOfMonth }
          : { type: "absoluteYearly", interval, dayOfMonth, month };
    }
  } else return unsupported();
  const startDay = Number(date.slice(8, 10));
  const startMonth = Number(date.slice(5, 7));
  switch (pattern.type) {
    case "daily":
      break;
    case "weekly":
      if (!pattern.daysOfWeek.includes(weekday)) return unsupported();
      break;
    case "absoluteMonthly":
      if (startDay !== pattern.dayOfMonth || startDay > 28) return unsupported();
      break;
    case "absoluteYearly":
      if (startDay !== pattern.dayOfMonth || startMonth !== pattern.month) return unsupported();
      break;
    case "relativeMonthly":
    case "relativeYearly": {
      if (
        !pattern.daysOfWeek.includes(weekday) ||
        (pattern.type === "relativeYearly" && startMonth !== pattern.month)
      )
        return unsupported();
      const ordinal = Math.floor((startDay - 1) / 7) + 1;
      const last =
        startDay + 7 > new Date(Date.UTC(Number(date.slice(0, 4)), startMonth, 0)).getUTCDate();
      if (pattern.index === "last" ? !last : index(String(ordinal)) !== pattern.index)
        return unsupported();
      break;
    }
    default: {
      const exhaustive: never = pattern;
      return exhaustive;
    }
  }
  const base = { startDate: date, recurrenceTimeZone: start.timeZone };
  const count = fields.get("COUNT"),
    until = fields.get("UNTIL");
  if (count && until) return unsupported();
  let range: Range = { type: "noEnd", ...base };
  if (count) range = { type: "numbered", ...base, numberOfOccurrences: positive(count) };
  if (until) {
    const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z)?$/.exec(until);
    if (!match) return unsupported();
    let endDate = `${match[1]}-${match[2]}-${match[3]}`;
    if (match[4]) {
      const instant = `${endDate}T${match[4]}:${match[5]}:${match[6]}Z`;
      const stamp = Date.parse(instant);
      if (
        !Number.isFinite(stamp) ||
        new Date(stamp).toISOString().slice(0, 19) !== instant.slice(0, 19)
      )
        return unsupported();
      const wall = wallTime(stamp, start.timeZone);
      endDate = wall.slice(0, 10);
      if (wall.slice(11) < start.dateTime.slice(11))
        endDate = new Date(Date.parse(`${endDate}T00:00:00Z`) - 86_400_000)
          .toISOString()
          .slice(0, 10);
    } else if (
      event.start.kind !== "date" ||
      !Number.isFinite(Date.parse(endDate)) ||
      new Date(endDate).toISOString().slice(0, 10) !== endDate
    )
      return unsupported();
    if (endDate < date) return unsupported();
    range = { type: "endDate", ...base, endDate };
  }
  return { start, end, recurrence: { pattern, range } };
}

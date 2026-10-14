import type { CalendarTime } from "./calendar-time.js";
import { WINDOWS_ZONES } from "./windows-zones.js";

export type DateParseResult =
  | { kind: "parsed"; start: CalendarTime; end: CalendarTime; endEstimated: boolean }
  | { kind: "ambiguous"; reason: "date-order" | "year" | "weekday" | "clock" | "dst" }
  | { kind: "invalid" };
export type DateContext = { reference: number; timeZone: string };

function ianaZone(zone: string): string {
  return WINDOWS_ZONES[zone] ?? zone;
}
export function calendarZoneName(timeZone: string): string {
  return new Intl.DateTimeFormat("en", {
    timeZone: ianaZone(timeZone),
  }).resolvedOptions().timeZone;
}
export function calendarIanaZones(): string[] {
  return [
    ...new Set(["UTC", ...Intl.supportedValuesOf("timeZone").map(calendarZoneName)]),
  ].toSorted();
}
export function calendarTimeDate(
  time: CalendarTime,
  { unknownZone = "throw" }: { unknownZone?: "throw" | "wall" } = {},
): string {
  if (time.kind === "zoned" && time.timestamp !== null) {
    try {
      return calendarWallTime(time.timestamp, time.zone).slice(0, 10);
    } catch (error) {
      if (unknownZone === "throw") throw error;
    }
  }
  return time.value.slice(0, 10);
}
/** Building a DateTimeFormat costs far more than formatting, and callers reuse a few zones. */
const wallFormats = new Map<string, Intl.DateTimeFormat>();
function wallFormat(timeZone: string): Intl.DateTimeFormat {
  let format = wallFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en", {
      timeZone: ianaZone(timeZone),
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    if (wallFormats.size >= 64) wallFormats.clear();
    wallFormats.set(timeZone, format);
  }
  return format;
}
export function calendarWallTime(timestamp: number, timeZone: string): string {
  const parts = new Map(
    wallFormat(timeZone)
      .formatToParts(timestamp)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}T${parts.get("hour")}:${parts.get("minute")}:${parts.get("second")}`;
}

export function calendarDateValid(date: string): boolean {
  const stamp = Date.parse(`${date}T00:00:00Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(stamp) &&
    new Date(stamp).toISOString().slice(0, 10) === date
  );
}
export function calendarDateShift(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

/** Round-trip all nearby offsets: a DST gap has no instant, a fold has two. */
export function calendarWallInstants(wall: string, timeZone: string): number[] {
  const nominal = Date.parse(`${wall}Z`);
  if (!Number.isFinite(nominal) || new Date(nominal).toISOString().slice(0, 19) !== wall) return [];
  const offsets = new Set<number>();
  for (let hour = -36; hour <= 36; hour += 6) {
    const sample = nominal + hour * 3600000;
    offsets.add(Date.parse(`${calendarWallTime(sample, timeZone)}Z`) - sample);
  }
  return [...offsets]
    .map((offset) => nominal - offset)
    .filter((stamp) => calendarWallTime(stamp, timeZone) === wall)
    .toSorted((a, b) => a - b);
}

/**
 * Date-only and floating values belong to the user's local calendar day in `timeZone`, the
 * PlatformHost zone. Comparing two values of the same kind may pass "UTC": wall order is exact.
 */
export function calendarTimestamp(time: CalendarTime, timeZone: string): number {
  if (time.kind === "zoned") return time.timestamp ?? NaN;
  const value = time.kind === "date" ? `${time.value}T00:00:00` : time.value;
  const wall = (value.length === 16 ? `${value}:00` : value).slice(0, 19);
  const nominal = Date.parse(`${wall}Z`);
  if (!Number.isFinite(nominal) || new Date(nominal).toISOString().slice(0, 19) !== wall)
    return NaN;
  if (timeZone === "UTC") return nominal;
  const [first] = calendarWallInstants(wall, timeZone);
  if (first !== undefined) return first;
  // A wall time that daylight saving skips keeps the offset from before the gap, as Date does.
  const before = nominal - 12 * 3600000;
  return nominal - (Date.parse(`${calendarWallTime(before, timeZone)}Z`) - before);
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const NUMBER_ZH = String.raw`[零一二三四五六七八九十两\d]+`;
const MONTH_EN = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
const RANGE = String.raw`\s*(?:–|—|-|to|至|到)\s*`;
const ISO_DATE = String.raw`(\d{4}-\d{2}-\d{2})(?:${RANGE}(\d{4}-\d{2}-\d{2}))?`;
const EN_DATE = String.raw`(${MONTH_EN})\s+(\d{1,2})(?:${RANGE}(?:(${MONTH_EN})\s+)?(\d{1,2}))?(?:,?\s+(\d{4}))?`;
const ZH_DATE = String.raw`(?:(\d{4})年|(明年|今年))?(\d{1,2})月(\d{1,2})(?:日|号)?(?:${RANGE}(?:(\d{1,2})月)?(\d{1,2})(?:日|号)?)?`;
// Dots denote money/version syntax, not a supported calendar date format.
const NUMERIC_DATE = String.raw`(\d{1,2})/(\d{1,2})(?:/(\d{4}))?`;
const RELATIVE_DATE = String.raw`(today|tomorrow|今天|明天|后天|end of month|月底|月末|in (\d+) (days?|weeks?)|(${NUMBER_ZH})(天|周|星期)后)`;
const EN_WEEKDAY = String.raw`(?:(next|this) )?(${WEEKDAYS.join("|")})\b`;
const ZH_WEEKDAY = String.raw`(下周|本周|这周|下星期|星期|周)([一二三四五六日天])`;
const EN_CLOCK = String.raw`(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)?`;
const ZH_CLOCK = String.raw`(上午|早上|下午|晚上|中午|凌晨)?(${NUMBER_ZH})[点时](半|${NUMBER_ZH}分?)?`;
const CLOCK = String.raw`(?:${ZH_CLOCK}|${EN_CLOCK}|noon|midnight|中午|午夜|morning|afternoon|evening|上午|下午|晚上|凌晨)`;
const CLOCK_RANGE = String.raw`${CLOCK}(?:${RANGE}${CLOCK})?`;
// Day-first English dates, as in "15 November" or "21 Oct". "May" needs a year: "top 10 may" is prose.
const MONTH_EN_DAY_FIRST = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may(?=,?\s+\d{4})|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
const EN_DATE_DAY_FIRST = String.raw`(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(${MONTH_EN_DAY_FIRST})\b(?:,?\s+(\d{4}))?`;
// A day of the month alone, as in "on the 14th". The preposition keeps "the 21st century" out,
// and a following month or counted noun makes it something else.
const ORDINAL_NOUNS = String.raw`centur(?:y|ies)|place|floor|anniversary|time|times|edition|birthday|year|grade|round|row|step|street|avenue|amendment|percentile`;
const ORDINAL_DAY_TAIL = String.raw`(\d{1,2})(?:st|nd|rd|th)\b(?!\s+of\s+${MONTH_EN})(?!\s+(?:${ORDINAL_NOUNS})\b)`;
const ORDINAL_DAY = String.raw`(?:on|by|before|until)\s+the\s+${ORDINAL_DAY_TAIL}`;
const DATE = String.raw`(?:${ISO_DATE}|${EN_DATE_DAY_FIRST}|${ORDINAL_DAY}|${EN_DATE}|${ZH_DATE}|${NUMERIC_DATE}|${RELATIVE_DATE}|${EN_WEEKDAY}|${ZH_WEEKDAY})`;
const DATE_WITH_PREFIX = String.raw`(?:on\s+)?${DATE}`;
const REVERSED_TIME = new RegExp(
  String.raw`^(?:at\s+)?(?<time>${CLOCK_RANGE})\s+(?:on\s+)?(?<date>${DATE})$`,
  "i",
);
const DATE_CANDIDATE = new RegExp(
  String.raw`(?<![a-z0-9$./])(?:(?:at\s+)?${CLOCK_RANGE}\s+${DATE_WITH_PREFIX}|${DATE_WITH_PREFIX}(?:[ T]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?(?:${RANGE}${CLOCK})?|\s*(?:at )?${CLOCK_RANGE})?|${CLOCK_RANGE})(?![a-z0-9:/])`,
  "gi",
);
const RELATIVE_DAYS: Readonly<Record<string, number>> = {
  today: 0,
  今天: 0,
  tomorrow: 1,
  明天: 1,
  后天: 2,
};
const WEEKDAY_MODIFIERS: Readonly<Record<string, "bare" | "upcoming" | "next" | "next-week">> = {
  "": "bare",
  星期: "bare",
  周: "bare",
  this: "upcoming",
  本周: "upcoming",
  这周: "upcoming",
  next: "next",
  下周: "next-week",
  下星期: "next-week",
};
function chineseNumber(value: string): number {
  if (/^\d+$/.test(value)) return Number(value);
  const digits = "零一二三四五六七八九";
  if (value === "两") return 2;
  if (value.includes("十")) {
    const [tens, ones] = value.split("十");
    return (tens ? digits.indexOf(tens) : 1) * 10 + (ones ? digits.indexOf(ones) : 0);
  }
  return digits.indexOf(value);
}
type Clock = { hour: number; minute: number; second: number };
function clockSeconds(value: Clock): number {
  return value.hour * 3600 + value.minute * 60 + value.second;
}
function clock(value: string, explicit24: boolean): Clock | "ambiguous" | null {
  if (value === "noon" || value === "中午") return { hour: 12, minute: 0, second: 0 };
  if (value === "midnight" || value === "午夜") return { hour: 0, minute: 0, second: 0 };
  if (["morning", "afternoon", "evening", "上午", "下午", "晚上", "凌晨"].includes(value))
    return "ambiguous";
  const en = new RegExp(`^${EN_CLOCK}$`).exec(value);
  if (en) {
    let hour = Number(en[1]);
    const minute = Number(en[2] ?? 0),
      second = Number(en[3] ?? 0);
    if (minute > 59 || second > 59 || hour > (en[4] ? 12 : 23) || (en[4] && hour < 1)) return null;
    // A leading zero, as in 08:55, only appears on a 24-hour clock.
    if (!en[4] && !explicit24 && !/^0\d:\d{2}/.test(value) && hour <= 12) return "ambiguous";
    if (en[4]) hour = (hour % 12) + (en[4] === "pm" ? 12 : 0);
    return { hour, minute, second };
  }
  const zh = new RegExp(`^${ZH_CLOCK}$`).exec(value);
  if (!zh) return null;
  let hour = chineseNumber(zh[2] ?? "");
  const minute = zh[3] === "半" ? 30 : zh[3] ? chineseNumber(zh[3].replace(/分$/, "")) : 0;
  if (hour < 0 || hour > (zh[1] ? 12 : 23) || minute < 0 || minute > 59) return null;
  if (!zh[1] && hour <= 12) return "ambiguous";
  if (
    (["上午", "早上", "晚上"].includes(zh[1] ?? "") && hour === 12) ||
    (zh[1] === "中午" && hour >= 4 && hour <= 10)
  )
    return "ambiguous";
  if (zh[1] === "中午" && hour >= 11) return { hour, minute, second: 0 };
  if (zh[1]) hour = (hour % 12) + (["下午", "晚上", "中午"].includes(zh[1]) ? 12 : 0);
  return { hour, minute, second: 0 };
}
function calendarDateFromParts(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
function calendarDateYearRoll(date: string, today: string, explicitYear: boolean): string {
  if (!calendarDateValid(date) || explicitYear || date >= today) return date;
  const daysPast = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86400000;
  if (daysPast >= 1 && daysPast <= 14) return "ambiguous";
  return `${Number(date.slice(0, 4)) + 1}${date.slice(4)}`;
}

/** See docs/calendar-dates.md: next is ambiguous across weekdays; this never selects a past day. */
function calendarWeekdayDelta(
  current: number,
  target: number,
  modifier: string,
): number | "ambiguous" {
  const delta = (target - current + 7) % 7;
  const kind = WEEKDAY_MODIFIERS[modifier] ?? "bare";
  switch (kind) {
    case "bare":
      return delta === 0 ? "ambiguous" : delta;
    case "upcoming":
      return delta;
    case "next":
      return delta === 0 ? 7 : "ambiguous";
    case "next-week":
      return target - current + (current === 0 ? -7 : 0) + (target === 0 ? 7 : 0) + 7;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/** Shared grammar for detection and typing; the reference and named zone are explicit. */
export function calendarParseDates(input: string, context: DateContext): DateParseResult {
  if (input.length > 1000) return { kind: "invalid" };
  try {
    return calendarParseDateInput(input, context);
  } catch {
    return { kind: "invalid" };
  }
}
/**
 * Rewrites "15 november" as "november 15" and "the 14th" as the next 14th, with
 * its month, so the month-first parser reads them. Other text is unchanged.
 */
function monthFirst(text: string, today: string): string {
  const dayFirst = new RegExp(`^${EN_DATE_DAY_FIRST}`, "i").exec(text);
  if (dayFirst)
    return `${dayFirst[2]} ${dayFirst[1]}${dayFirst[3] ? `, ${dayFirst[3]}` : ""}${text.slice(dayFirst[0].length)}`;
  // "on" is already stripped; "by", "before" and "until" only introduce the day.
  const ordinal = new RegExp(`^(?:(?:by|before|until)\\s+)?the\\s+${ORDINAL_DAY_TAIL}`, "i").exec(
    text,
  );
  if (!ordinal) return text;
  const day = Number(ordinal[1]);
  // The next month that has this day: "the 31st" in November means December 31.
  let month = Number(today.slice(5, 7)) - 1 + (day < Number(today.slice(8, 10)) ? 1 : 0);
  const year = Number(today.slice(0, 4));
  for (let tries = 0; tries < 12; tries++, month++) {
    const date = calendarDateFromParts(year + Math.floor(month / 12), (month % 12) + 1, day);
    if (calendarDateValid(date))
      return `${MONTHS[month % 12]} ${day}, ${date.slice(0, 4)}${text.slice(ordinal[0].length)}`;
  }
  return text;
}

/**
 * The days an ambiguous candidate could mean, so callers can drop one that can
 * only lie in the past. Empty when the date part is unknown.
 */
export function calendarAmbiguousDays(input: string, context: DateContext): string[] {
  const text = input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^on\s+/, "");
  const today = calendarWallTime(context.reference, context.timeZone).slice(0, 10);
  const numeric = new RegExp(`^${NUMERIC_DATE}`).exec(text);
  if (numeric) {
    const first = Number(numeric[1]),
      second = Number(numeric[2]);
    const year = Number(numeric[3] ?? today.slice(0, 4));
    return [
      [first, second],
      [second, first],
    ]
      .map(([month = 0, day = 0]) => {
        const date = calendarDateFromParts(year, month, day);
        // In November and December, January and February read as next year.
        return !numeric[3] && date < today && Number(today.slice(5, 7)) >= 11 && month <= 2
          ? calendarDateFromParts(year + 1, month, day)
          : date;
      })
      .filter(calendarDateValid);
  }
  // The time made the rest ambiguous, so the date part alone tells the day.
  const date = new RegExp(`^${DATE}`, "i").exec(text)?.[0];
  if (!date) return [];
  const parsed = calendarParseDates(date, context);
  if (parsed.kind === "parsed") return [parsed.start.value.slice(0, 10)];
  // A month and day 1 to 14 days ago, without a year, most likely means that recent day.
  if (parsed.kind === "ambiguous" && parsed.reason === "year")
    return [calendarDateShift(today, -1)];
  return [];
}

function calendarParseDateInput(input: string, context: DateContext): DateParseResult {
  let text = input.trim().toLowerCase().replace(/\s+/g, " ");
  const reversed = REVERSED_TIME.exec(text);
  if (reversed?.groups?.date && reversed.groups.time)
    text = `${reversed.groups.date} ${reversed.groups.time}`;
  text = text.replace(/^on\s+/, "");
  const today = calendarWallTime(context.reference, context.timeZone).slice(0, 10);
  const year = Number(today.slice(0, 4));
  text = monthFirst(text, today);
  let date = today,
    lastDate: string | undefined,
    consumed = "";
  const iso = new RegExp(`^${ISO_DATE}`).exec(text);
  const named = new RegExp(`^${EN_DATE}`, "i").exec(text);
  const zh = new RegExp(`^${ZH_DATE}`).exec(text);
  const numeric = new RegExp(`^${NUMERIC_DATE}`).exec(text);
  const relative = new RegExp(`^${RELATIVE_DATE}`).exec(text);
  const enWeekday = new RegExp(`^${EN_WEEKDAY}`).exec(text);
  const zhWeekday = new RegExp(`^${ZH_WEEKDAY}`).exec(text);
  if (iso) {
    date = iso[1] ?? "";
    lastDate = iso[2];
    consumed = iso[0];
  } else if (named || zh) {
    const match = named ?? zh;
    if (!match) return { kind: "invalid" };
    const month = named ? MONTHS.indexOf((match[1] ?? "").slice(0, 3)) + 1 : Number(match[3]);
    const day = Number(named ? match[2] : match[4]);
    const explicit = named ? !!match[5] : !!(match[1] || match[2]);
    let selectedYear = named
      ? Number(match[5] ?? year)
      : Number(match[1] ?? year + (match[2] === "明年" ? 1 : 0));
    date = calendarDateYearRoll(calendarDateFromParts(selectedYear, month, day), today, explicit);
    if (date === "ambiguous") return { kind: "ambiguous", reason: "year" };
    selectedYear = Number(date.slice(0, 4));
    const endDay = named ? match[4] : match[6];
    const endMonth = named
      ? match[3]
        ? MONTHS.indexOf(match[3].slice(0, 3)) + 1
        : month
      : Number(match[5] ?? month);
    if (endDay)
      lastDate = calendarDateFromParts(
        selectedYear + (endMonth < month ? 1 : 0),
        endMonth,
        Number(endDay),
      );
    consumed = match[0];
  } else if (numeric) {
    const first = Number(numeric[1]),
      second = Number(numeric[2]);
    if (first < 1 || second < 1 || (first > 12 && second > 12)) return { kind: "invalid" };
    if (first <= 12 && second <= 12) return { kind: "ambiguous", reason: "date-order" };
    date = calendarDateYearRoll(
      calendarDateFromParts(
        Number(numeric[3] ?? year),
        first > 12 ? second : first,
        first > 12 ? first : second,
      ),
      today,
      !!numeric[3],
    );
    if (date === "ambiguous") return { kind: "ambiguous", reason: "year" };
    consumed = numeric[0];
  } else if (relative) {
    consumed = relative[0];
    if (["end of month", "月底", "月末"].includes(consumed))
      date = new Date(Date.UTC(year, Number(today.slice(5, 7)), 0)).toISOString().slice(0, 10);
    else {
      let days = RELATIVE_DAYS[consumed] ?? 0;
      if (relative[2]) days = Number(relative[2]) * (relative[3]?.startsWith("week") ? 7 : 1);
      else if (relative[4]) days = chineseNumber(relative[4]) * (relative[5] === "天" ? 1 : 7);
      if (days > 365000 || days < 0) return { kind: "invalid" };
      date = calendarDateShift(today, days);
    }
  } else if (enWeekday || zhWeekday) {
    const current = new Date(`${today}T00:00:00Z`).getUTCDay();
    const target = enWeekday
      ? WEEKDAYS.indexOf(enWeekday[2] ?? "")
      : "日一二三四五六".indexOf((zhWeekday?.[2] ?? "").replace("天", "日"));
    const delta = calendarWeekdayDelta(current, target, enWeekday?.[1] ?? zhWeekday?.[1] ?? "");
    if (delta === "ambiguous") return { kind: "ambiguous", reason: "weekday" };
    date = calendarDateShift(today, delta);
    consumed = enWeekday?.[0] ?? zhWeekday?.[0] ?? "";
  }
  if (/\d$/.test(consumed) && /^\d/.test(text.slice(consumed.length))) return { kind: "invalid" };
  if (!calendarDateValid(date) || (lastDate && (!calendarDateValid(lastDate) || lastDate < date)))
    return { kind: "invalid" };
  text = text
    .slice(consumed.length)
    .trim()
    .replace(/^(?:t|at )/, "")
    .trim();
  if (!text) {
    if (!consumed) return { kind: "invalid" };
    return {
      kind: "parsed",
      start: { kind: "date", value: date },
      end: { kind: "date", value: calendarDateShift(lastDate ?? date, 1) },
      endEstimated: false,
    };
  }
  if (lastDate) return { kind: "invalid" };
  const offset = /^(\d{2}:\d{2}(?::\d{2})?)(z|[+-]\d{2}:\d{2})$/.exec(text);
  if (offset && consumed) {
    const value = `${date}T${offset[1]}${offset[1]?.length === 5 ? ":00" : ""}${offset[2]?.toUpperCase()}`;
    const stamp = Date.parse(value);
    if (
      !Number.isFinite(stamp) ||
      Number(offset[1]?.slice(0, 2)) > 23 ||
      Number(offset[1]?.slice(3, 5)) > 59 ||
      Number(offset[1]?.slice(6) || 0) > 59
    )
      return { kind: "invalid" };
    return {
      kind: "parsed",
      start: { kind: "zoned", value, zone: context.timeZone, timestamp: stamp },
      end: {
        kind: "zoned",
        value: new Date(stamp + 3600000).toISOString(),
        zone: context.timeZone,
        timestamp: stamp + 3600000,
      },
      endEstimated: true,
    };
  }
  const range = new RegExp(`^(.*?)${RANGE}(.*?)$`).exec(text);
  let first = range?.[1] ?? text,
    second = range?.[2];
  const inferredMeridiem =
    !!second && /(?:am|pm)$/.test(second) && /^\d{1,2}(?::\d{2})?$/.test(first);
  if (inferredMeridiem && second) first += second.endsWith("pm") ? "pm" : "am";
  const zhPeriod = /^(上午|早上|下午|晚上|中午|凌晨)/.exec(first)?.[1];
  if (second && zhPeriod && new RegExp(`^${NUMBER_ZH}[点时]`).test(second))
    second = zhPeriod + second;
  const startClock = clock(first, !!iso);
  let endClock = second ? clock(second, !!iso) : null;
  // A bare English endpoint is only resolved by the bounded half-day rollover below.
  if (endClock === "ambiguous" && second && /(?:am|pm)$/.test(first)) {
    const bareEnd = clock(second, true);
    if (
      startClock &&
      startClock !== "ambiguous" &&
      bareEnd &&
      bareEnd !== "ambiguous" &&
      startClock.hour <= 12 &&
      bareEnd.hour <= 12 &&
      clockSeconds(bareEnd) < clockSeconds(startClock)
    )
      endClock = bareEnd;
  }
  if (startClock === "ambiguous" || endClock === "ambiguous")
    return { kind: "ambiguous", reason: "clock" };
  if (!startClock || (second && !endClock)) return { kind: "invalid" };
  let rolledEnd = false;
  if (endClock && clockSeconds(endClock) <= clockSeconds(startClock)) {
    if (
      clockSeconds(endClock) < clockSeconds(startClock) &&
      startClock.hour <= 12 &&
      endClock.hour <= 12
    ) {
      endClock = { ...endClock, hour: endClock.hour + 12 };
      rolledEnd = true;
    } else return { kind: "ambiguous", reason: "clock" };
  }
  if (!consumed && !rolledEnd) return { kind: "ambiguous", reason: "clock" };
  const wall = (c: Clock) =>
    `${date}T${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")}:${String(c.second).padStart(2, "0")}`;
  const starts = calendarWallInstants(wall(startClock), context.timeZone);
  const ends = endClock ? calendarWallInstants(wall(endClock), context.timeZone) : [];
  if (starts.length !== 1 || (endClock && ends.length !== 1))
    return { kind: "ambiguous", reason: "dst" };
  const start = starts[0],
    end = endClock ? ends[0] : start === undefined ? undefined : start + 3600000;
  if (start === undefined || end === undefined || end <= start) return { kind: "invalid" };
  return {
    kind: "parsed",
    start: { kind: "zoned", value: wall(startClock), zone: context.timeZone, timestamp: start },
    end: {
      kind: "zoned",
      value: calendarWallTime(end, context.timeZone),
      zone: context.timeZone,
      timestamp: end,
    },
    endEstimated: !endClock,
  };
}

/** Bounded complete candidates. Avoid decimal/currency/version substrings. */
export function calendarDateCandidates(text: string): { input: string; index: number }[] {
  const bounded = text.slice(0, 100000);
  return [...bounded.matchAll(DATE_CANDIDATE)]
    .filter(
      (match) =>
        !/^\d{1,2}$/.test(match[0]) &&
        !/^\s+(?:at\s+)?(?:\d|上午|早上|下午|晚上|中午|凌晨|noon|midnight)/i.test(
          bounded.slice(match.index + match[0].length),
        ) &&
        !/[a-z0-9:]/i.test(bounded[match.index + match[0].length] ?? "") &&
        !/\d/.test(bounded[match.index - 1] ?? "") &&
        !/^\.\d/.test(bounded.slice(match.index + match[0].length)),
    )
    .slice(0, 20)
    .map((match) => ({ input: match[0], index: match.index }));
}

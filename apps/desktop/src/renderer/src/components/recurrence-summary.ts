import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import {
  recurrenceWeekdayName,
  recurrenceMonthName,
  recurrenceMonthDate,
  calendarDateValid,
  type EventRecurrence,
  type Ordinal,
} from "@openmail/core/schema";

export const ORDINAL_LABELS = {
  1: msg`First`,
  2: msg`Second`,
  3: msg`Third`,
  4: msg`Fourth`,
  5: msg`Fifth`,
  "-1": msg({
    message: "Last",
    context: "recurrence position option",
    comment: "Last weekday occurrence in a month; a dropdown option.",
  }),
} satisfies Record<Ordinal, MessageDescriptor>;
const SUMMARY_LAST = msg({
  message: "Last",
  context: "recurrence summary ordinal",
  comment: "Ordinal inside a recurrence summary, before a weekday name.",
});

export function recurrenceSummary(rule: EventRecurrence, t: I18n["_"], locale: string): string {
  const pattern = rule.pattern,
    interval = pattern.interval;
  const ordinalName = (ordinal: Ordinal) =>
    t(ordinal === -1 ? SUMMARY_LAST : ORDINAL_LABELS[ordinal]);
  let summary: string;
  switch (pattern.kind) {
    case "daily":
      summary = t(msg`Every ${plural(interval, { one: "# day", other: "# days" })}`);
      break;
    case "weekly": {
      const days = new Intl.ListFormat(locale, { style: "short", type: "conjunction" }).format(
        pattern.weekdays.map((day) => recurrenceWeekdayName(day, locale)),
      );
      summary = t(msg`Every ${plural(interval, { one: "# week", other: "# weeks" })} on ${days}`);
      break;
    }
    case "monthly-date": {
      const date = pattern.day;
      summary = t(
        msg`Every ${plural(interval, { one: "# month", other: "# months" })} on day ${date}`,
      );
      break;
    }
    case "monthly-weekday": {
      const ordinal = ordinalName(pattern.ordinal),
        day = recurrenceWeekdayName(pattern.weekday, locale);
      summary = t(
        msg`Every ${plural(interval, { one: "# month", other: "# months" })} on the ${ordinal} ${day}`,
      );
      break;
    }
    case "yearly-date": {
      const date = recurrenceMonthDate(pattern.month, pattern.day, locale);
      summary = t(msg`Every ${plural(interval, { one: "# year", other: "# years" })} on ${date}`);
      break;
    }
    case "yearly-weekday": {
      const month = recurrenceMonthName(pattern.month, locale),
        ordinal = ordinalName(pattern.ordinal),
        day = recurrenceWeekdayName(pattern.weekday, locale);
      summary = t(
        msg`Every ${plural(interval, { one: "# year", other: "# years" })} in ${month} on the ${ordinal} ${day}`,
      );
      break;
    }
    default: {
      const exhaustive: never = pattern;
      return exhaustive;
    }
  }
  switch (rule.ending.kind) {
    case "never":
      return summary;
    case "count": {
      const count = rule.ending.count;
      return t(msg`${summary}, ${plural(count, { one: "# occurrence", other: "# occurrences" })}`);
    }
    case "until": {
      const date = calendarDateValid(rule.ending.date)
        ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(
            Date.parse(`${rule.ending.date}T00:00:00Z`),
          )
        : rule.ending.date;
      return t(msg`${summary} until ${date}`);
    }
    default: {
      const exhaustive: never = rule.ending;
      return exhaustive;
    }
  }
}

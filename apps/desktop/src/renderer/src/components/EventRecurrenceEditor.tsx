import { useLingui } from "@lingui/react/macro";
import { Schema } from "effect";
import {
  calendarTimeDate,
  calendarDateValid,
  Ordinal,
  RecurrenceWeekday,
  recurrenceWeekdayName,
  type CalendarTime,
  type EventRecurrence,
} from "@openmail/core/schema";
import { ORDINAL_LABELS, recurrenceSummary } from "./recurrence-summary";
import { formInput } from "./ui/form-styles";

type Pattern = EventRecurrence["pattern"];
type Ending = EventRecurrence["ending"];
const weekdays = RecurrenceWeekday.literals;
function defaultPattern(kind: string, start: CalendarTime): Pattern | undefined {
  const inputDate = calendarTimeDate(start, { unknownZone: "wall" });
  const date = calendarDateValid(inputDate) ? inputDate : "2000-01-03";
  const weekday = weekdays[(new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7] ?? "MO";
  const day = Number(date.slice(8)),
    month = Number(date.slice(5, 7));
  const occurrence = Math.ceil(day / 7),
    ordinal = Schema.is(Ordinal)(occurrence) ? occurrence : -1;
  const interval = 1;
  const patterns = {
    daily: { kind: "daily", interval },
    weekly: { kind: "weekly", interval, weekdays: [weekday] },
    "monthly-date": { kind: "monthly-date", interval, day },
    "monthly-weekday": { kind: "monthly-weekday", interval, weekday, ordinal },
    "yearly-date": { kind: "yearly-date", interval, month, day },
    "yearly-weekday": { kind: "yearly-weekday", interval, month, weekday, ordinal },
  } satisfies Record<Pattern["kind"], Pattern>;
  return new Map<string, Pattern>(Object.entries(patterns)).get(kind);
}

function PatternFields({
  pattern,
  updatePattern,
}: {
  pattern: Pattern;
  updatePattern: (pattern: Pattern) => void;
}) {
  const { t, i18n } = useLingui();
  const dayName = (value: typeof RecurrenceWeekday.Type) =>
    recurrenceWeekdayName(value, i18n.locale);
  const ordinalName = (ordinal: typeof Ordinal.Type) => i18n._(ORDINAL_LABELS[ordinal]);
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <label>
          {t`Interval`}
          <input
            className={formInput}
            type="number"
            min="1"
            max="2147483647"
            value={pattern.interval}
            onChange={(e) => updatePattern({ ...pattern, interval: Number(e.target.value) })}
          />
        </label>
        {(pattern.kind === "monthly-date" || pattern.kind === "yearly-date") && (
          <label>
            {t`Day of month`}
            <input
              className={formInput}
              type="number"
              min="1"
              max="31"
              value={pattern.day}
              onChange={(e) => updatePattern({ ...pattern, day: Number(e.target.value) })}
            />
          </label>
        )}
        {(pattern.kind === "yearly-date" || pattern.kind === "yearly-weekday") && (
          <label>
            {t`Month`}
            <input
              className={formInput}
              type="number"
              min="1"
              max="12"
              value={pattern.month}
              onChange={(e) => updatePattern({ ...pattern, month: Number(e.target.value) })}
            />
          </label>
        )}
        {(pattern.kind === "monthly-weekday" || pattern.kind === "yearly-weekday") && (
          <>
            <label>
              {t`Position`}
              <select
                className={formInput}
                value={pattern.ordinal}
                onChange={(e) => {
                  const ordinal = Number(e.target.value);
                  if (Schema.is(Ordinal)(ordinal)) updatePattern({ ...pattern, ordinal });
                }}
              >
                {Ordinal.literals.map((n) => (
                  <option key={n} value={n}>
                    {ordinalName(n)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t`Weekday`}
              <select
                className={formInput}
                value={pattern.weekday}
                onChange={(e) => {
                  const weekday = weekdays.find((d) => d === e.target.value);
                  if (weekday) updatePattern({ ...pattern, weekday });
                }}
              >
                {weekdays.map((d) => (
                  <option key={d} value={d}>
                    {dayName(d)}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </div>
      {pattern.kind === "weekly" && (
        <div className="flex flex-wrap gap-2">
          {weekdays.map((d) => (
            <label key={d} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={pattern.weekdays.includes(d)}
                onChange={(e) =>
                  updatePattern({
                    ...pattern,
                    weekdays: e.target.checked
                      ? weekdays.filter((day) => day === d || pattern.weekdays.includes(day))
                      : pattern.weekdays.filter((day) => day !== d),
                  })
                }
              />
              {dayName(d)}
            </label>
          ))}
        </div>
      )}
    </>
  );
}
function EndingFields({
  ending,
  date,
  onChange,
}: {
  ending: Ending;
  date: string;
  onChange: (ending: Ending) => void;
}) {
  const { t } = useLingui();
  return (
    <>
      <label className="block">
        {t`Ends`}
        <select
          className={formInput}
          value={ending.kind}
          onChange={(e) => {
            switch (e.target.value) {
              case "count":
                onChange({ kind: "count", count: 10 });
                break;
              case "until":
                onChange({ kind: "until", date });
                break;
              case "never":
                onChange({ kind: "never" });
                break;
            }
          }}
        >
          <option value="never">{t`Never`}</option>
          <option value="count">{t`After a number of occurrences`}</option>
          <option value="until">{t`On a date`}</option>
        </select>
      </label>
      {ending.kind === "count" && (
        <label className="block">
          {t`Occurrences`}
          <input
            className={formInput}
            type="number"
            min="1"
            max="2147483647"
            value={ending.count}
            onChange={(e) => onChange({ kind: "count", count: Number(e.target.value) })}
          />
        </label>
      )}
      {ending.kind === "until" && (
        <label className="block">
          {t`Repeat end date`}
          <input
            className={formInput}
            type="date"
            min={date}
            value={ending.date}
            onChange={(e) => onChange({ kind: "until", date: e.target.value })}
          />
        </label>
      )}
    </>
  );
}
export function EventRecurrenceEditor({
  rule,
  start,
  onChange,
  disabled,
}: {
  rule: EventRecurrence | null | undefined;
  start: CalendarTime;
  onChange: (rule: EventRecurrence | null | undefined) => void;
  disabled: boolean;
}) {
  const { t, i18n } = useLingui();
  const pattern = rule?.pattern;
  const date = calendarTimeDate(start, { unknownZone: "wall" });
  return (
    <fieldset
      disabled={disabled}
      className="space-y-2 border-t border-black/10 pt-2 dark:border-white/10"
    >
      {/* Floated, the legend leaves the border and sits above the field like the other labels. */}
      <legend className="float-left mb-0 w-full font-medium">{t`Repeat`}</legend>
      <select
        aria-label={t`Repeat pattern`}
        className={`${formInput} clear-left`}
        value={rule === undefined ? "keep" : (pattern?.kind ?? "none")}
        onChange={(e) => {
          if (e.target.value === "keep") {
            onChange(undefined);
            return;
          }
          if (e.target.value === "none") {
            onChange(null);
            return;
          }
          const selected = defaultPattern(e.target.value, start);
          if (selected) onChange({ pattern: selected, ending: rule?.ending ?? { kind: "never" } });
        }}
      >
        <option value="keep">{t`Keep existing rule`}</option>
        <option value="none">{t`Does not repeat`}</option>
        <option value="daily">{t`Daily`}</option>
        <option value="weekly">{t`Weekly`}</option>
        <option value="monthly-date">{t`Monthly by date`}</option>
        <option value="monthly-weekday">{t`Monthly by weekday`}</option>
        <option value="yearly-date">{t`Yearly by date`}</option>
        <option value="yearly-weekday">{t`Yearly by weekday`}</option>
      </select>
      {rule && (
        <>
          <PatternFields
            pattern={rule.pattern}
            updatePattern={(next) => onChange({ ...rule, pattern: next })}
          />
          <EndingFields
            ending={rule.ending}
            date={date}
            onChange={(ending) => onChange({ ...rule, ending })}
          />
          <p aria-live="polite" className="text-sm">
            {recurrenceSummary(rule, i18n._.bind(i18n), i18n.locale)}
          </p>
        </>
      )}
    </fieldset>
  );
}

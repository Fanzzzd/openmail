import { useLingui } from "@lingui/react/macro";
import { useId } from "react";
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
import { Select } from "./ui/Select";

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
  disabled,
}: {
  pattern: Pattern;
  updatePattern: (pattern: Pattern) => void;
  disabled: boolean;
}) {
  const { t, i18n } = useLingui();
  const dayName = (value: typeof RecurrenceWeekday.Type) =>
    recurrenceWeekdayName(value, i18n.locale);
  const ordinalName = (ordinal: typeof Ordinal.Type) => i18n._(ORDINAL_LABELS[ordinal]);
  const ids = { position: useId(), weekday: useId() };
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
            <div className="space-y-1">
              <label htmlFor={ids.position} className="block">
                {t`Position`}
              </label>
              <Select
                id={ids.position}
                variant="field"
                aria-label={t`Position`}
                disabled={disabled}
                value={String(pattern.ordinal)}
                options={Ordinal.literals.map((n) => ({ value: String(n), label: ordinalName(n) }))}
                onValueChange={(value) => {
                  const ordinal = Number(value);
                  if (Schema.is(Ordinal)(ordinal)) updatePattern({ ...pattern, ordinal });
                }}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor={ids.weekday} className="block">
                {t`Weekday`}
              </label>
              <Select
                id={ids.weekday}
                variant="field"
                aria-label={t`Weekday`}
                disabled={disabled}
                value={pattern.weekday}
                options={weekdays.map((d) => ({ value: d, label: dayName(d) }))}
                onValueChange={(weekday) => updatePattern({ ...pattern, weekday })}
              />
            </div>
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
  disabled,
}: {
  ending: Ending;
  date: string;
  onChange: (ending: Ending) => void;
  disabled: boolean;
}) {
  const { t } = useLingui();
  const ids = { ends: useId() };
  return (
    <>
      <div className="space-y-1">
        <label htmlFor={ids.ends} className="block">
          {t`Ends`}
        </label>
        <Select
          id={ids.ends}
          variant="field"
          aria-label={t`Ends`}
          disabled={disabled}
          value={ending.kind}
          options={[
            { value: "never" as const, label: t`Never` },
            { value: "count" as const, label: t`After a number of occurrences` },
            { value: "until" as const, label: t`On a date` },
          ]}
          onValueChange={(kind) => {
            switch (kind) {
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
        />
      </div>
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
      <Select
        variant="field"
        aria-label={t`Repeat pattern`}
        className="clear-left"
        disabled={disabled}
        value={rule === undefined ? "keep" : (pattern?.kind ?? "none")}
        options={[
          { value: "keep", label: t`Keep existing rule` },
          { value: "none", label: t`Does not repeat` },
          { value: "daily", label: t`Daily` },
          { value: "weekly", label: t`Weekly` },
          { value: "monthly-date", label: t`Monthly by date` },
          { value: "monthly-weekday", label: t`Monthly by weekday` },
          { value: "yearly-date", label: t`Yearly by date` },
          { value: "yearly-weekday", label: t`Yearly by weekday` },
        ]}
        onValueChange={(value) => {
          if (value === "keep") {
            onChange(undefined);
            return;
          }
          if (value === "none") {
            onChange(null);
            return;
          }
          const selected = defaultPattern(value, start);
          if (selected) onChange({ pattern: selected, ending: rule?.ending ?? { kind: "never" } });
        }}
      />
      {rule && (
        <>
          <PatternFields
            pattern={rule.pattern}
            updatePattern={(next) => onChange({ ...rule, pattern: next })}
            disabled={disabled}
          />
          <EndingFields
            ending={rule.ending}
            date={date}
            onChange={(ending) => onChange({ ...rule, ending })}
            disabled={disabled}
          />
          <p aria-live="polite" className="text-sm">
            {recurrenceSummary(rule, i18n._.bind(i18n), i18n.locale)}
          </p>
        </>
      )}
    </fieldset>
  );
}

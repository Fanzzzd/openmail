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
import { DateInput } from "../../ui/DateInput";
import { NumberField } from "../../ui/NumberField";
import { Select } from "../../ui/Select";
import { ToggleButtons } from "../../ui/ToggleButtons";

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
  const ids = {
    interval: useId(),
    day: useId(),
    month: useId(),
    position: useId(),
    weekday: useId(),
  };
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label htmlFor={ids.interval} className="block">
            {t`Interval`}
          </label>
          <NumberField
            id={ids.interval}
            min={1}
            max={2147483647}
            disabled={disabled}
            value={pattern.interval}
            onValueChange={(interval) => updatePattern({ ...pattern, interval: interval ?? 0 })}
          />
        </div>
        {(pattern.kind === "monthly-date" || pattern.kind === "yearly-date") && (
          <div className="space-y-1">
            <label htmlFor={ids.day} className="block">
              {t`Day of month`}
            </label>
            <NumberField
              id={ids.day}
              min={1}
              max={31}
              disabled={disabled}
              value={pattern.day}
              onValueChange={(day) => updatePattern({ ...pattern, day: day ?? 0 })}
            />
          </div>
        )}
        {(pattern.kind === "yearly-date" || pattern.kind === "yearly-weekday") && (
          <div className="space-y-1">
            <label htmlFor={ids.month} className="block">
              {t`Month`}
            </label>
            <NumberField
              id={ids.month}
              min={1}
              max={12}
              disabled={disabled}
              value={pattern.month}
              onValueChange={(month) => updatePattern({ ...pattern, month: month ?? 0 })}
            />
          </div>
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
        <ToggleButtons
          aria-label={t`Repeat on`}
          disabled={disabled}
          options={weekdays.map((d) => ({ value: d, label: dayName(d) }))}
          value={pattern.weekdays}
          onValueChange={(next) => updatePattern({ ...pattern, weekdays: next })}
        />
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
  const ids = { ends: useId(), count: useId(), until: useId() };
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
        <div className="space-y-1">
          <label htmlFor={ids.count} className="block">
            {t`Occurrences`}
          </label>
          <NumberField
            id={ids.count}
            min={1}
            max={2147483647}
            disabled={disabled}
            value={ending.count}
            onValueChange={(count) => onChange({ kind: "count", count: count ?? 0 })}
          />
        </div>
      )}
      {ending.kind === "until" && (
        <div className="space-y-1">
          <label htmlFor={ids.until} className="block">
            {t`Repeat end date`}
          </label>
          <DateInput
            id={ids.until}
            type="date"
            min={date}
            disabled={disabled}
            value={ending.date}
            onValueChange={(value) => onChange({ kind: "until", date: value })}
          />
        </div>
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
    <fieldset disabled={disabled} className="space-y-2 border-t border-edge pt-2">
      {/* Floated, the legend leaves the border and sits above the field like the other labels. */}
      <legend className="float-left mb-0 w-full font-medium">{t`Repeat`}</legend>
      <Select
        variant="field"
        aria-label={t`Repeat pattern`}
        className="clear-left"
        disabled={disabled}
        value={rule === undefined ? "keep" : (pattern?.kind ?? "none")}
        options={[
          { value: "keep", label: t`Keep the current repeat pattern` },
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
          <p aria-live="polite" className="text-callout">
            {recurrenceSummary(rule, i18n._.bind(i18n), i18n.locale)}
          </p>
        </>
      )}
    </fieldset>
  );
}

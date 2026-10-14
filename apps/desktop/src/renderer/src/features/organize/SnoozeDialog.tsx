import { useAtom } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { parseSnoozeTime, snoozeTimes, type BatchResult } from "@openmail/core/schema";
import { useId, useState } from "react";
import { resultError } from "../../lib/errors";
import { MAIL_KEYS } from "../../state/keys";
import { snoozeAtom } from "../../state/mutations";
import { Dialog } from "../../ui/Dialog";
import { formButton, formInput } from "../../ui/form-styles";
import { dateFormat } from "../../lib/format";

const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;

export function SnoozeDialog({
  threads,
  onClose,
  onStart,
}: {
  threads: readonly string[];
  onClose: () => void;
  onStart: () => (result: BatchResult | null) => void;
}) {
  const { t, i18n } = useLingui();
  const timeDescription = useId();
  const [custom, setCustom] = useState("");
  const [phrase, setPhrase] = useState("");
  const [now] = useState(() => Date.now());
  const due = parseSnoozeTime(phrase || custom, now);
  const [result, run] = useAtom(snoozeAtom, { mode: "promiseExit" });
  const [times] = useState(() => snoozeTimes(now));
  const choose = async (reminderAt: number) => {
    const finished = onStart();
    const exit = await run({ payload: { threads, due: reminderAt }, reactivityKeys: MAIL_KEYS });
    finished(exit._tag === "Success" ? exit.value : null);
  };
  return (
    <Dialog aria-label={t`Snooze`} onClose={onClose} className="w-80 space-y-3 p-5">
      <h2 className="font-semibold">
        <Trans>Remind me</Trans>
      </h2>
      {[
        { name: t`In 3 hours`, due: times.later },
        { name: t`Tomorrow morning`, due: times.tomorrow },
        { name: t`Next week`, due: times.nextWeek },
      ].map((preset) => (
        <button
          key={preset.name}
          type="button"
          disabled={result.waiting}
          onClick={() => {
            void choose(preset.due);
          }}
          className="flex w-full items-baseline justify-between gap-3 rounded p-2 text-left hover:bg-blue-500/10"
        >
          <span>{preset.name}</span>{" "}
          {/* The time each preset resolves to, so "Next week" says which day. A weekday alone
              reads as this week, so a time more than two days out adds the date. The space keeps
              the two apart in the button's accessible name. */}
          <span className="shrink-0 text-a11y-muted tabular-nums">
            {new Date(preset.due).toLocaleString(dateFormat(i18n).locale, {
              weekday: "short",
              ...(preset.due - now > TWO_DAYS ? { day: "numeric", month: "short" } : {}),
              hour: "numeric",
              minute: "2-digit",
              ...dateFormat(i18n).clock,
            })}
          </span>
        </button>
      ))}
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (due !== null) void choose(due);
        }}
      >
        <label className="block space-y-1">
          <span>{t`Reminder time`}</span>
          <input
            type="text"
            aria-invalid={Boolean(phrase && due === null)}
            aria-describedby={phrase ? timeDescription : undefined}
            className={formInput}
            value={phrase}
            onChange={(e) => {
              setPhrase(e.target.value);
              setCustom("");
            }}
            placeholder={t`1 week, tomorrow 9am, next monday`}
          />
        </label>
        {phrase && (
          <p id={timeDescription} aria-live="polite">
            {due === null
              ? t`Enter a future reminder time`
              : new Date(due).toLocaleString(dateFormat(i18n).locale, {
                  dateStyle: "medium",
                  timeStyle: "short",
                  ...dateFormat(i18n).clock,
                })}
          </p>
        )}
        <label className="block space-y-1">
          <span>{t`Custom time`}</span>
          <input
            type="datetime-local"
            className={formInput}
            value={custom}
            onChange={(e) => {
              setCustom(e.target.value);
              setPhrase("");
            }}
          />
        </label>
        <button type="submit" disabled={result.waiting || due === null} className={formButton}>
          <Trans>Snooze</Trans>
        </button>
      </form>
      {resultError(i18n, result) && (
        <p role="alert" className="text-a11y-danger">
          {resultError(i18n, result)}
        </p>
      )}
    </Dialog>
  );
}

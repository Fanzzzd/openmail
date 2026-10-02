import { useAtom } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { parseSnoozeTime, snoozeTimes, type BatchResult } from "@openmail/core/schema";
import { useState } from "react";
import { resultError } from "../errors";
import { MAIL_KEYS } from "../state/keys";
import { snoozeAtom } from "../state/mutations";
import { Dialog } from "./ui/Dialog";
import { formButton, formInput } from "./OrganizationSettings";

export function SnoozeDialog({
  threads,
  onClose,
  onSnoozed,
}: {
  threads: readonly string[];
  onClose: () => void;
  onSnoozed: (result: BatchResult) => void;
}) {
  const { t, i18n } = useLingui();
  const [custom, setCustom] = useState("");
  const [phrase, setPhrase] = useState("");
  const [now] = useState(() => Date.now());
  const due = parseSnoozeTime(phrase || custom, now);
  const [result, run] = useAtom(snoozeAtom, { mode: "promiseExit" });
  const [times] = useState(() => snoozeTimes(Date.now()));
  const choose = async (reminderAt: number) => {
    const exit = await run({ payload: { threads, due: reminderAt }, reactivityKeys: MAIL_KEYS });
    if (exit._tag === "Success") onSnoozed(exit.value);
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
          className="block w-full rounded p-2 text-left hover:bg-blue-500/10"
        >
          {preset.name}
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
          <p aria-live="polite">
            {due === null
              ? t`Enter a future reminder time`
              : new Date(due).toLocaleString(i18n.locale)}
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
        <p role="alert" className="text-red-500">
          {resultError(i18n, result)}
        </p>
      )}
    </Dialog>
  );
}

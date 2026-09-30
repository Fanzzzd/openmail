import { useAtom } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { snoozeTimes } from "@openmail/core/schema";
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
  onSnoozed: () => void;
}) {
  const { t, i18n } = useLingui();
  const [custom, setCustom] = useState("");
  const [result, run] = useAtom(snoozeAtom, { mode: "promiseExit" });
  const [times] = useState(() => snoozeTimes(Date.now()));
  const choose = async (due: number) => {
    const exit = await run({ payload: { threads, due }, reactivityKeys: MAIL_KEYS });
    if (exit._tag === "Success") onSnoozed();
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
          void choose(new Date(custom).getTime());
        }}
      >
        <label className="block space-y-1">
          <span>{t`Custom time`}</span>
          <input
            required
            type="datetime-local"
            className={formInput}
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
          />
        </label>
        <button type="submit" disabled={result.waiting || !custom} className={formButton}>
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

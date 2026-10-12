import { useAtom, useAtomValue } from "@effect/atom-react";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { isTriageInbox } from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { MailClient } from "../../state/rpc";
import { Keys } from "../../state/keys";
import { labelsAtom } from "../../state/queries";
import { aiSettingsAtom } from "./ai-settings";
import { Dialog } from "../../ui/Dialog";

const mutation = MailClient.mutation("DecideAiTriage");
export function TriageChip({
  id,
  accountId,
  labels,
  compact = false,
}: {
  id: string;
  accountId: string;
  labels: readonly string[];
  compact?: boolean;
}) {
  const settings = AsyncResult.getOrElse(useAtomValue(aiSettingsAtom), () => null);
  if (
    !isTriageInbox(labels) ||
    !settings?.accounts.some((a) => a.accountId === accountId && a.allowed && a.autoTriage)
  )
    return null;
  return <Suggestion id={id} accountId={accountId} compact={compact} />;
}
function Suggestion({
  id,
  accountId,
  compact,
}: {
  id: string;
  accountId: string;
  compact: boolean;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const row = AsyncResult.getOrElse(
    useAtomValue(MailClient.query("AiTriage", { id }, { reactivityKeys: [Keys.ai, Keys.thread] })),
    () => null,
  );
  const labels = AsyncResult.getOrElse(useAtomValue(labelsAtom([accountId])), () => []);
  const [result, decide] = useAtom(mutation);
  if (
    !row ||
    row.status === "dismissed" ||
    (row.status === "accepted" && row.action.kind !== "replyNeeded")
  )
    return null;
  const action = row.action;
  const label =
    action.kind === "label"
      ? (labels.find((l) => l.accountId === accountId && l.id === action.labelId)?.name ??
        action.labelId)
      : "";
  const hours = action.kind === "snooze" ? action.hours : 0;
  const title =
    action.kind === "archive"
      ? t`Archive`
      : action.kind === "label"
        ? t`Label: ${label}`
        : action.kind === "snooze"
          ? t`${plural(hours, { one: "Snooze for # hour", other: "Snooze for # hours" })}`
          : t`Reply needed: add star`;
  return (
    <>
      <button
        type="button"
        className={`${compact ? "absolute right-3 bottom-1 z-10 max-w-[55%] truncate" : "mb-2"} rounded bg-violet-100 px-2 py-0.5 text-caption text-violet-800 dark:bg-violet-950 dark:text-violet-200`}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
      >
        {title}
      </button>
      {open && (
        <Dialog
          aria-label={t`AI suggestion`}
          onClose={() => setOpen(false)}
          className="w-[400px] space-y-3 p-5"
        >
          <h2 className="font-semibold">{title}</h2>
          <p className="whitespace-pre-wrap break-words">{row.reason}</p>
          <p className="text-footnote text-a11y-muted">{row.model}</p>
          {row.status === "pending" && (
            <div className="flex gap-3">
              <button
                type="button"
                disabled={result.waiting}
                onClick={() =>
                  decide({
                    payload: { id, accept: true },
                    reactivityKeys: [Keys.ai, Keys.thread, Keys.threads],
                  })
                }
              >
                <Trans>Accept</Trans>
              </button>
              <button
                type="button"
                disabled={result.waiting}
                onClick={() =>
                  decide({ payload: { id, accept: false }, reactivityKeys: [Keys.ai, Keys.thread] })
                }
              >
                <Trans>Dismiss</Trans>
              </button>
            </div>
          )}
          {result._tag === "Failure" && (
            <p role="alert">
              <Trans>Something went wrong. Please try again.</Trans>
            </p>
          )}
          <button type="button" onClick={() => setOpen(false)}>
            <Trans>Close</Trans>
          </button>
        </Dialog>
      )}
    </>
  );
}

import { useAtom, useAtomValue } from "@effect/atom-react";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { aiModelName, isTriageInbox } from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import { Sparkles } from "lucide-react";
import { useState } from "react";
import { SOMETHING_WENT_WRONG } from "../../lib/errors";
import { MailClient } from "../../state/rpc";
import { Keys } from "../../state/keys";
import { labelsAtom } from "../../state/queries";
import { aiSettingsAtom } from "./ai-settings";
import { Dialog } from "../../ui/Dialog";
import { MenuItem, MenuSeparator } from "../../ui/Menu";

const mutation = MailClient.mutation("DecideAiTriage");

interface Gate {
  id: string;
  accountId: string;
  labels: readonly string[];
}

/** Triage runs for Inbox mail of accounts that allow AI and turned triage on. */
function useTriageOn({ accountId, labels }: Gate) {
  const settings = AsyncResult.getOrElse(useAtomValue(aiSettingsAtom), () => null);
  return (
    isTriageInbox(labels) &&
    (settings?.accounts.some((a) => a.accountId === accountId && a.allowed && a.autoTriage) ??
      false)
  );
}

/** The open suggestion for a message, its one-line title, and accept or dismiss. */
function useSuggestion(id: string, accountId: string) {
  const { t } = useLingui();
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
  const decideNow = (accept: boolean) =>
    decide({
      payload: { id, accept },
      reactivityKeys: accept ? [Keys.ai, Keys.thread, Keys.threads] : [Keys.ai, Keys.thread],
    });
  return { row, title, result, decide: decideNow };
}

/**
 * The suggestion chip on a row. It stays out of the tab order so arrow keys move through the
 * list; the row's name includes the suggestion and its context menu accepts or dismisses it.
 */
export function TriageChip({ compact = false, ...gate }: Gate & { compact?: boolean }) {
  return useTriageOn(gate) ? (
    <Suggestion id={gate.id} accountId={gate.accountId} compact={compact} />
  ) : null;
}

/** The suggestion as words for a row's accessible name. */
export function TriageSummary(gate: Gate) {
  return useTriageOn(gate) ? <SuggestionSummary id={gate.id} accountId={gate.accountId} /> : null;
}
function SuggestionSummary({ id, accountId }: { id: string; accountId: string }) {
  const { t } = useLingui();
  const suggestion = useSuggestion(id, accountId);
  if (!suggestion) return null;
  const { title } = suggestion;
  return <>{`, ${t`AI suggestion: ${title}`}`}</>;
}

/** Accept and Dismiss for a row's context menu. */
export function TriageMenuItems(gate: Gate) {
  return useTriageOn(gate) ? <SuggestionMenuItems id={gate.id} accountId={gate.accountId} /> : null;
}
function SuggestionMenuItems({ id, accountId }: { id: string; accountId: string }) {
  const { t } = useLingui();
  const suggestion = useSuggestion(id, accountId);
  if (suggestion?.row.status !== "pending") return null;
  const { title, result, decide } = suggestion;
  return (
    <>
      <MenuSeparator />
      <MenuItem icon={Sparkles} disabled={result.waiting} onClick={() => decide(true)}>
        {t`Accept AI suggestion: ${title}`}
      </MenuItem>
      <MenuItem disabled={result.waiting} onClick={() => decide(false)}>
        {t`Dismiss AI suggestion`}
      </MenuItem>
    </>
  );
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
  const { t, i18n } = useLingui();
  const [open, setOpen] = useState(false);
  const suggestion = useSuggestion(id, accountId);
  if (!suggestion) return null;
  const { row, title, result, decide } = suggestion;
  return (
    <>
      <button
        type="button"
        tabIndex={compact ? -1 : undefined}
        aria-hidden={compact || undefined}
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
          <p className="text-footnote text-a11y-muted">{aiModelName(row.model)}</p>
          {row.status === "pending" && (
            <div className="flex gap-3">
              <button type="button" disabled={result.waiting} onClick={() => decide(true)}>
                <Trans>Accept</Trans>
              </button>
              <button type="button" disabled={result.waiting} onClick={() => decide(false)}>
                <Trans>Dismiss</Trans>
              </button>
            </div>
          )}
          {result._tag === "Failure" && <p role="alert">{i18n._(SOMETHING_WENT_WRONG)}</p>}
          <button type="button" onClick={() => setOpen(false)}>
            <Trans>Close</Trans>
          </button>
        </Dialog>
      )}
    </>
  );
}

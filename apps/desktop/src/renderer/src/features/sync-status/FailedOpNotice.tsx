import { useAtomValue } from "@effect/atom-react";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Effect } from "effect";
import { AsyncResult, Reactivity } from "effect/reactivity";
import { useState } from "react";
import type { FailedOp } from "../../../../shared/api";
import { Keys } from "../../state/keys";
import { useRunMail, withMail } from "../../state/mail";
import { accountsAtom, failedOpsAtom } from "../../state/queries";
import { buttonSecondary } from "../../ui/styles";

const OPERATION_LABELS: Readonly<Record<string, MessageDescriptor>> = {
  read: msg`Read status`,
  star: msg`Star`,
  important: msg`Important`,
  archive: msg`Archive`,
  inbox: msg`Move to Inbox`,
  trash: msg`Move to Trash`,
  spam: msg`Report spam`,
  move: msg`Move to folder`,
  copy: msg`Copy`,
  label: msg`Label`,
  categories: msg`Categories`,
  classification: msg`Focused/Other`,
  saveDraft: msg`Save draft`,
  deleteDraft: msg`Delete draft`,
  delete: msg`Delete permanently`,
  reconcile: msg`Restore message state`,
  send: msg`Send`,
  sendPartial: msg`Partial delivery`,
  sentCopyMissing: msg`Save sent copy`,
};

export function FailedOpNoticeContent({
  failures,
  accountName,
  dismiss,
  resend,
  busy = false,
  error = false,
  resendError = false,
}: {
  failures: readonly FailedOp[];
  accountName: (id: string) => string;
  dismiss: (ids: readonly number[]) => void;
  resend?: (noticeId: number) => void;
  busy?: boolean;
  error?: boolean;
  resendError?: boolean;
}) {
  const { t, i18n } = useLingui();
  const [expanded, setExpanded] = useState(false);
  if (!failures.length) return null;
  const changeCount = failures.filter(
    (entry) => entry.kind !== "sendPartial" && entry.kind !== "sentCopyMissing",
  ).length;
  const partialCount = failures.filter((entry) => entry.kind === "sendPartial").length;
  const sentCopyCount = failures.filter((entry) => entry.kind === "sentCopyMissing").length;
  const changeTitle = (count: number) =>
    t`${plural(count, { one: "# change couldn't be saved", other: "# changes couldn't be saved" })}`;
  const partialTitle = (count: number) =>
    t`${plural(count, { one: "# message had rejected recipients", other: "# messages had rejected recipients" })}`;
  const sentCopyTitle = (count: number) =>
    t`${plural(count, { one: "# sent message is missing from Sent", other: "# sent messages are missing from Sent" })}`;
  return (
    <section className="shrink-0 border-b bg-amber-50 px-4 py-2 dark:bg-amber-950 border-separator">
      <div className="flex items-center gap-3">
        <output role="alert" className="flex-1">
          {changeCount > 0 && <span className="block">{changeTitle(changeCount)}</span>}
          {partialCount > 0 && <span className="block">{partialTitle(partialCount)}</span>}
          {sentCopyCount > 0 && <span className="block">{sentCopyTitle(sentCopyCount)}</span>}
        </output>
        <button
          type="button"
          className={buttonSecondary}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? t`Hide details` : t`Details`}
        </button>
        <button
          type="button"
          disabled={busy}
          className={buttonSecondary}
          onClick={() => dismiss(failures.map((entry) => entry.id))}
        >
          {t`Dismiss`}
        </button>
      </div>
      {error && <p role="alert">{t`Couldn't dismiss this notice. Try again.`}</p>}
      {resendError && <p role="alert">{t`Couldn't prepare the resend draft. Try again.`}</p>}
      {expanded && (
        <ul className="mt-2 max-h-48 space-y-2 overflow-auto">
          {failures.map((entry) => (
            <li key={entry.id}>
              <p className="font-medium">
                {accountName(entry.accountId)} ·{" "}
                {i18n.date(entry.at, { dateStyle: "short", timeStyle: "short" })}
              </p>
              <p>{i18n._(OPERATION_LABELS[entry.kind] ?? msg`Change`)}</p>
              <p className="font-medium">{entry.subject || t`(No subject)`}</p>
              {entry.sender && <p>{entry.sender}</p>}
              {entry.kind === "sendPartial" && (
                <div>
                  <p>{t`Some recipients did not receive this message.`}</p>
                  <p>{t`Your draft was kept. Check Sent before sending again.`}</p>
                </div>
              )}
              {entry.kind === "sentCopyMissing" && (
                <p>{t`The message was sent, but its copy is missing from Sent.`}</p>
              )}
              <p className="break-words">{entry.reason}</p>
              {entry.kind === "sendPartial" && entry.providerId && resend && (
                <button
                  type="button"
                  disabled={busy}
                  className={`mt-1 ${buttonSecondary}`}
                  onClick={() => resend(entry.id)}
                >{t`Resend to rejected recipients`}</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Persist until acknowledged; refresh for changes made by the CLI or another process too. */
export function FailedOpNotice({ onOpenDraft }: { onOpenDraft: (id: string) => void }) {
  const failures = AsyncResult.getOrElse(useAtomValue(failedOpsAtom), () => []);
  const accounts = AsyncResult.getOrElse(useAtomValue(accountsAtom), () => []);
  const run = useRunMail();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [resendError, setResendError] = useState(false);
  const dismiss = (ids: readonly number[]) => {
    setBusy(true);
    setError(false);
    run(
      withMail((call) => call("AcknowledgeFailedOps", { ids })).pipe(
        Reactivity.mutation([Keys.failedOps]),
        Effect.catch(() => Effect.sync(() => setError(true))),
        Effect.ensuring(Effect.sync(() => setBusy(false))),
      ),
    );
  };
  const resend = (noticeId: number) => {
    setBusy(true);
    setResendError(false);
    run(
      withMail((call) => call("PrepareRejectedResend", { noticeId })).pipe(
        Reactivity.mutation([Keys.threads]),
        Effect.map((draft) => onOpenDraft(draft.id)),
        Effect.catch(() => Effect.sync(() => setResendError(true))),
        Effect.ensuring(Effect.sync(() => setBusy(false))),
      ),
    );
  };
  return (
    <FailedOpNoticeContent
      failures={failures}
      accountName={(id) => accounts.find((entry) => entry.id === id)?.email ?? id}
      dismiss={dismiss}
      resend={resend}
      resendError={resendError}
      busy={busy}
      error={error}
    />
  );
}

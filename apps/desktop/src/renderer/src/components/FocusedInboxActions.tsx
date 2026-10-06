import { FOCUSED_PERMISSION_EVENT, requestFocusedPermission } from "../focused-inbox";
import { Toolbar } from "@base-ui/react/toolbar";
import { useAtom } from "@effect/atom-react";
import { useLingui } from "@lingui/react/macro";
import type { InferenceClassification, MailOp } from "@openmail/core/schema";
import { Effect } from "effect";
import { Inbox } from "lucide-react";
import { useEffect, useState } from "react";
import { causeText, resultError } from "../errors";
import { useRunMail, withMail } from "../state/mail";
import { reauthAtom } from "../state/mutations";
import type { ThreadState } from "./ThreadActions";
import { Alert, AlertCancel, alertPrimary } from "./ui/Dialog";
import { DropdownMenu, MenuItem, MenuSeparator } from "./ui/Menu";

/** Sender overrides affect future arrivals only and require a separate explicit action. */
export function FocusedInboxActions({
  state,
  onOp,
}: {
  state: ThreadState;
  onOp: (op: MailOp) => void;
}) {
  const { t, i18n } = useLingui();
  const run = useRunMail();
  const sender = state.focusedSender;
  const [override, setOverride] = useState<{
    classifyAs: InferenceClassification;
    messageId: string;
    address: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = () => {
    if (!override) return;
    const { messageId, classifyAs } = override;
    setBusy(true);
    setError(null);
    run(
      withMail((call) => call("SetClassificationOverride", { messageId, classifyAs })).pipe(
        Effect.matchCause({
          onSuccess: () => setOverride(null),
          onFailure: (cause) => {
            if (requestFocusedPermission(cause)) {
              setOverride(null);
            } else setError(causeText(i18n, cause));
          },
        }),
        Effect.ensuring(Effect.sync(() => setBusy(false))),
      ),
    );
  };
  return (
    <>
      <DropdownMenu
        trigger={
          <Toolbar.Button
            aria-label={t`Focused/Other`}
            className="rounded-md p-1.5 text-a11y-muted hover:bg-black/5 dark:hover:bg-white/10"
          >
            <Inbox className="size-4" />
          </Toolbar.Button>
        }
      >
        <MenuItem
          onClick={() => onOp({ kind: "classification", value: "focused" })}
        >{t`Move to Focused`}</MenuItem>
        <MenuItem
          onClick={() => onOp({ kind: "classification", value: "other" })}
        >{t`Move to Other`}</MenuItem>
        {sender && (
          <>
            <MenuSeparator />
            <MenuItem
              onClick={() => {
                setError(null);
                setOverride({ ...sender, classifyAs: "focused" });
              }}
            >{t`Always move messages from this sender to Focused`}</MenuItem>
            <MenuItem
              onClick={() => {
                setError(null);
                setOverride({ ...sender, classifyAs: "other" });
              }}
            >{t`Always move messages from this sender to Other`}</MenuItem>
          </>
        )}
      </DropdownMenu>
      <Alert
        open={override !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setOverride(null);
        }}
        title={t`Always move messages from this sender?`}
        description={
          <>
            <span className="block font-medium">{override?.address}</span>
            {override?.classifyAs === "focused"
              ? t`Future messages from this sender will appear in Focused. Existing messages keep their classification.`
              : t`Future messages from this sender will appear in Other. Existing messages keep their classification.`}
            {error && (
              <span role="alert" className="mt-2 block text-a11y-danger">
                {error}
              </span>
            )}
          </>
        }
      >
        <AlertCancel disabled={busy}>{t`Cancel`}</AlertCancel>
        <button
          type="button"
          className={alertPrimary}
          disabled={busy}
          onClick={confirm}
        >{t`Save`}</button>
      </Alert>
    </>
  );
}

/** Uses the existing account reauthorization flow; consent never retries a mail write. */
export function FocusedInboxPermission() {
  const [accountId, setAccountId] = useState<string | null>(null);
  useEffect(() => {
    const listener = (event: Event) => {
      if (event instanceof CustomEvent && typeof event.detail === "string")
        setAccountId(event.detail);
    };
    window.addEventListener(FOCUSED_PERMISSION_EVENT, listener);
    return () => window.removeEventListener(FOCUSED_PERMISSION_EVENT, listener);
  }, []);
  return accountId ? (
    <Permission key={accountId} accountId={accountId} onClose={() => setAccountId(null)} />
  ) : null;
}
function Permission({ accountId, onClose }: { accountId: string; onClose: () => void }) {
  const { t, i18n } = useLingui();
  const [result, reauth] = useAtom(reauthAtom(accountId), { mode: "promiseExit" });
  const error = resultError(i18n, result);
  return (
    <Alert
      open
      onOpenChange={(open) => {
        if (!open && !result.waiting) onClose();
      }}
      title={t`Sign in again to change Focused/Other.`}
      description={
        <>
          {t`Microsoft will ask for permission to update mail. After signing in, choose the action again.`}
          {error && (
            <span role="alert" className="mt-2 block text-a11y-danger">
              {error}
            </span>
          )}
        </>
      }
    >
      <AlertCancel disabled={result.waiting}>{t`Cancel`}</AlertCancel>
      <button
        type="button"
        className={alertPrimary}
        disabled={result.waiting}
        onClick={async () => {
          const exit = await reauth("focusedInbox");
          if (exit._tag === "Success") onClose();
        }}
      >{t`Sign in again`}</button>
    </Alert>
  );
}

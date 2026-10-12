import { useLingui } from "@lingui/react/macro";
import type { FolderScope } from "@openmail/core/schema";
import { Cause, Effect, Option } from "effect";
import { PermanentDeletePermission } from "./PermanentDeletePermission";
import { Reactivity } from "effect/reactivity";
import { MailOpen, MoreHorizontal, Trash2 } from "lucide-react";
import { useState } from "react";
import { causeText } from "../../lib/errors";
import { MAIL_KEYS } from "../../state/keys";
import { useRunMail, withMail } from "../../state/mail";
import { Alert, AlertCancel, alertDanger } from "../../ui/Dialog";
import { DropdownMenu, MenuItem } from "../../ui/Menu";

export function FolderActions({
  folder,
  notify,
}: {
  folder: FolderScope;
  notify: (text: string, error?: boolean) => void;
}) {
  const { t, i18n } = useLingui();
  const run = useRunMail();
  const [request, setRequest] = useState<FolderScope | null>(null);
  const [busy, setBusy] = useState(false);
  const [permissionAccount, setPermissionAccount] = useState<string | null>(null);
  const act = (target: FolderScope, empty: boolean) => {
    setBusy(true);
    run(
      withMail((call) =>
        empty
          ? call("EmptyFolder", { folder: target, confirmed: true })
          : call("MarkFolderRead", { folder: target }),
      ).pipe(
        Reactivity.mutation(MAIL_KEYS),
        Effect.matchCause({
          onSuccess: (count) =>
            notify(
              empty
                ? t`Permanently deleted ${count} messages`
                : t`Marked ${count} messages as read`,
            ),
          onFailure: (cause) => {
            const error = Cause.findErrorOption(cause);
            if (
              Option.isSome(error) &&
              error.value._tag === "FeatureScopeMissing" &&
              error.value.feature === "permanentDelete"
            ) {
              setPermissionAccount(error.value.accountId);
              return;
            }
            const reason = causeText(i18n, cause);
            notify(t`Folder action failed: ${reason}`, true);
          },
        }),
        Effect.ensuring(Effect.sync(() => setBusy(false))),
      ),
    );
  };
  return (
    <>
      {permissionAccount && (
        <PermanentDeletePermission
          key={permissionAccount}
          accountId={permissionAccount}
          onClose={() => setPermissionAccount(null)}
        />
      )}
      <DropdownMenu
        trigger={
          <button
            type="button"
            disabled={busy}
            aria-label={t`Folder actions`}
            className="rounded-md p-1 text-a11y-muted hover:bg-black/5"
          >
            <MoreHorizontal className="size-4" />
          </button>
        }
      >
        <MenuItem
          icon={MailOpen}
          disabled={folder.mailbox === "snoozed"}
          onClick={() => act(folder, false)}
        >{t`Mark all as read`}</MenuItem>
        {!folder.label && (folder.mailbox === "trash" || folder.mailbox === "spam") && (
          <MenuItem icon={Trash2} onClick={() => setRequest(folder)}>
            {folder.mailbox === "trash" ? t`Empty Trash` : t`Empty Spam`}
          </MenuItem>
        )}
      </DropdownMenu>
      <Alert
        open={request !== null}
        onOpenChange={(open) => {
          if (!open) setRequest(null);
        }}
        title={request?.mailbox === "trash" ? t`Empty Trash?` : t`Empty Spam?`}
        description={t`All messages currently in this folder, including messages not loaded and Outlook child folders, will be permanently deleted. Messages restored during the operation will be excluded from later batches. This cannot be undone.`}
      >
        <AlertCancel>{t`Cancel`}</AlertCancel>
        <button
          type="button"
          className={alertDanger}
          onClick={() => {
            if (request) {
              act(request, true);
              setRequest(null);
            }
          }}
        >{t`Permanently delete`}</button>
      </Alert>
    </>
  );
}

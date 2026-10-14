import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { PermanentDeletePermission } from "../features/organize/PermanentDeletePermission";
import { Alert, AlertCancel, alertButton, alertDanger, alertPrimary } from "../ui/Dialog";
import type { useMailActions } from "./use-mail-actions";
import type { useMailCompose } from "./use-mail-compose";
import type { useMailSelection } from "./use-mail-selection";

/** The main window's confirmations: Delete key action, quoting, batch and permanent delete. */
export function MailAlerts({
  mailActions,
  composition,
  navigation,
}: {
  mailActions: ReturnType<typeof useMailActions>;
  composition: ReturnType<typeof useMailCompose>;
  navigation: ReturnType<typeof useMailSelection>;
}) {
  const { t } = useLingui();
  const {
    deleteKeyPrompt,
    setDeleteKeyPrompt,
    applyDeleteKey,
    act,
    permanentRequest,
    setPermanentRequest,
    permissionAccount,
    setPermissionAccount,
  } = mailActions;
  const { quotePrompt, setQuotePrompt } = composition;
  const { deleteRequest, setDeleteRequest, scopeKey } = navigation;
  return (
    <>
      <Alert
        open={deleteKeyPrompt}
        onOpenChange={setDeleteKeyPrompt}
        title={t`Choose Delete key action`}
      >
        <AlertCancel>{t`Cancel`}</AlertCancel>
        {(["trash", "archive", "removeLabel"] as const).map((action) => (
          <button
            type="button"
            key={action}
            className={alertButton}
            onClick={() => {
              setDeleteKeyPrompt(false);
              applyDeleteKey(action);
            }}
          >
            {action === "trash"
              ? t`Move to Trash`
              : action === "archive"
                ? t`Archive`
                : t`Remove current label`}
          </button>
        ))}
      </Alert>
      <Alert
        open={quotePrompt !== null}
        onOpenChange={(open) => {
          if (!open) setQuotePrompt(null);
        }}
        title={t`Quote only the selected text?`}
      >
        <AlertCancel>{t`Cancel`}</AlertCancel>
        <button
          type="button"
          className={alertButton}
          onClick={() => {
            quotePrompt?.(false);
            setQuotePrompt(null);
          }}
        >{t`Whole message`}</button>
        <button
          type="button"
          className={alertPrimary}
          onClick={() => {
            quotePrompt?.(true);
            setQuotePrompt(null);
          }}
        >{t`Selected text`}</button>
      </Alert>
      <Alert
        open={deleteRequest !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteRequest(null);
        }}
        title={t`${plural(deleteRequest?.ids.size ?? 0, { one: "Delete # conversation?", other: "Delete # conversations?" })}`}
        description={t`These loaded conversations will be moved to Trash. You can undo this batch.`}
      >
        <AlertCancel>{t`Cancel`}</AlertCancel>
        <button
          type="button"
          className={alertDanger}
          onClick={() => {
            const request = deleteRequest;
            setDeleteRequest(null);
            if (request && request.scopeKey === scopeKey)
              act({ kind: "trash" }, { confirmedIds: request.ids });
          }}
        >{t`Delete`}</button>
      </Alert>
      <Alert
        open={permanentRequest !== null}
        onOpenChange={(open) => {
          if (!open) setPermanentRequest(null);
        }}
        title={t`Permanently delete selected mail?`}
        description={
          permanentRequest?.flat
            ? t`Only the selected messages in this Trash or Spam folder will be permanently deleted. This cannot be undone.`
            : t`Only messages in this Trash or Spam folder from the selected conversations will be permanently deleted. Inbox and Sent copies will remain. This cannot be undone.`
        }
      >
        <AlertCancel>{t`Cancel`}</AlertCancel>
        <button
          type="button"
          className={alertDanger}
          onClick={() => {
            mailActions.confirmPermanentDelete();
          }}
        >{t`Permanently delete`}</button>
      </Alert>
      {permissionAccount && (
        <PermanentDeletePermission
          key={permissionAccount}
          accountId={permissionAccount}
          onClose={() => setPermissionAccount(null)}
        />
      )}
    </>
  );
}

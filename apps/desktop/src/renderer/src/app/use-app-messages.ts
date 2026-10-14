import type { MailOp } from "../../../shared/api";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";

const OP_DONE: Record<MailOp["kind"], (op: MailOp) => MessageDescriptor> = {
  read: (op) => (op.kind === "read" && op.value ? msg`Marked as read` : msg`Marked as unread`),
  star: (op) => (op.kind === "star" && op.value ? msg`Added star` : msg`Removed star`),
  important: (op) =>
    op.kind === "important" && op.value ? msg`Marked as important` : msg`Marked as not important`,
  archive: () => msg`Archived`,
  inbox: () => msg`Moved to Inbox`,
  trash: () => msg`Deleted`,
  spam: () => msg`Reported as spam`,
  move: () => msg`Moved`,
  categories: () => msg`Categories updated`,
  classification: (op) =>
    op.kind === "classification" && op.value === "focused"
      ? msg`Moved to Focused`
      : msg`Moved to Other`,
  copy: () => msg`Copied to folders`,
  label: (op) => (op.kind === "label" && op.value ? msg`Label added` : msg`Label removed`),
};

/** Keep catalog origins here; behaviour modules receive this text adapter. */
export function useAppMessages() {
  const { t, i18n } = useLingui();
  return {
    cantOpenTheMessage: (reason: string) => t`Can't open the message: ${reason}`,
    opDone: (op: MailOp) => i18n._(OP_DONE[op.kind](op)),
    couldNotLoadTheNextMessage: t`Couldn't load the next message`,
    actionFailed: (reason: string) => t`Action failed: ${reason}`,
    noCurrentLabelAppliesMovingToTrash: t`No current label applies. Moving to Trash.`,
    finishSigningInInYourBrowser: t`Finish signing in in your browser`,
    isSignedInAgain: (email: string) => t`${email} is signed in again`,
    signInFailed: (reason: string) => t`Sign-in failed: ${reason}`,
    snoozed: t`Snoozed`,
    permanentlyDeletedMessages: (count: number) =>
      t`${plural(count, { one: "Permanently deleted # message", other: "Permanently deleted # messages" })}`,
    couldntDelete: (reason: string) => t`Couldn't delete: ${reason}`,
    cantOpenTheDraft: (reason: string) => t`Can't open the draft: ${reason}`,
    couldNotOpenTheComposeWindow: t`Couldn't open the compose window`,
    connectAnAccountToSendFeedback: t`Connect an account to send feedback`,
    couldNotOpenTheFeedbackDraft: t`Couldn't open the feedback draft`,
    couldNotOpenTheDraft: t`Couldn't open the draft`,
    couldntSaveTheDraft: (reason: string) => t`Couldn't save the draft: ${reason}`,
    draftDiscarded: t`Draft discarded`,
    couldntDiscard: (reason: string) => t`Couldn't discard: ${reason}`,
    sentAndArchived: t`Sent and archived`,
    sent: t`Sent`,
    couldntSend: (reason: string) => t`Couldn't send: ${reason}`,
    couldntSendSubject: (subject: string, reason: string) => t`Couldn't send ${subject}: ${reason}`,
    openDraft: t`Open draft`,
    couldntRestoreTheDraft: (reason: string) => t`Couldn't restore the draft: ${reason}`,
    sending: t`Sending…`,
    undo: t`Undo`,
    gmailSize: t`Gmail attachments exceed 25 MB in total. Remove attachments before sending.`,
    gmailBlocked: (filename: string) =>
      t`Gmail blocks ${filename}. Remove this attachment before sending.`,
    outlookSize: t`Outlook.com messages are limited to 25 MB, including message text and attachments. Remove attachments before sending.`,
    outlookItemSize: t`Outlook cannot upload attached messages of 3 MB or more. Remove this attachment before sending.`,
  };
}
export type AppMessages = ReturnType<typeof useAppMessages>;

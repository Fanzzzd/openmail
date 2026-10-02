import type { MailOp } from "../../../shared/api";
import type { AppMessages } from "../App";
export const testMessages = {
  cantOpenTheMessage: (reason: string) => `Can't open the message: ${reason}`,
  opDone: (op: MailOp) =>
    op.kind === "label" ? (op.value ? "Label added" : "Label removed") : "Done",
  couldNotLoadTheNextMessage: `Could not load the next message`,
  actionFailed: (reason: string) => `Action failed: ${reason}`,
  noCurrentLabelAppliesMovingToTrash: `No current label applies. Moving to Trash.`,
  finishSigningInInYourBrowser: `Finish signing in in your browser`,
  isSignedInAgain: (email: string) => `${email} is signed in again`,
  signInFailed: (reason: string) => `Sign-in failed: ${reason}`,
  snoozed: `Snoozed`,
  permanentlyDeletedMessages: (count: number) => `Permanently deleted ${count} messages`,
  couldntDelete: (reason: string) => `Couldn't delete: ${reason}`,
  cantOpenTheDraft: (reason: string) => `Can't open the draft: ${reason}`,
  couldNotOpenTheComposeWindow: `Could not open the compose window`,
  connectAnAccountToSendFeedback: `Connect an account to send feedback`,
  couldNotOpenTheFeedbackDraft: `Could not open the feedback draft`,
  couldNotOpenTheDraft: `Could not open the draft`,
  couldntSaveTheDraft: (reason: string) => `Couldn't save the draft: ${reason}`,
  draftDiscarded: `Draft discarded`,
  couldntDiscard: (reason: string) => `Couldn't discard: ${reason}`,
  sentAndArchived: `Sent and archived`,
  sent: `Sent`,
  couldntSend: (reason: string) => `Couldn't send: ${reason}`,
  sending: `Sending…`,
  undo: `Undo`,
  gmailSize: `Gmail attachments exceed 25 MB in total. Remove attachments before sending.`,
  gmailBlocked: (filename: string) =>
    `Gmail blocks ${filename}. Remove this attachment before sending.`,
  outlookSize: `This app supports Outlook attachments up to 3 MB in total. Large attachment uploads are not supported yet. Remove attachments before sending.`,
} satisfies AppMessages;

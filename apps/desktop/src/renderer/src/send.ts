import { composeEditorText, mentionsAttachment, type ComposeBody } from "@openmail/core/schema";

import type { OutgoingMessage } from "../../shared/api";
import { type Draft, toMessage } from "./draft";

export type SendWarning = "subject" | "attachment" | "recipients";
export type SendCheck =
  | { kind: "invalid"; addresses: string[] }
  | { kind: "noRecipients" }
  | { kind: "confirm"; warning: SendWarning }
  | { kind: "sent" };

/** Only a valid, fully confirmed draft reaches the caller's undo/send queue. */
export function submitDraft(
  draft: Draft,
  archive: boolean,
  confirmed: readonly SendWarning[],
  send: (draft: Draft, message: OutgoingMessage, options: { archive: boolean }) => void,
  ownBody: ComposeBody = draft.body,
): SendCheck {
  const { message, invalid } = toMessage(draft);
  if (invalid.length) return { kind: "invalid", addresses: invalid };
  if (message.to.length + message.cc.length + message.bcc.length === 0)
    return { kind: "noRecipients" };
  if (!message.subject.trim() && !confirmed.includes("subject"))
    return { kind: "confirm", warning: "subject" };
  if (
    !confirmed.includes("attachment") &&
    !message.attachments.length &&
    !draft.forwardAsAttachment &&
    mentionsAttachment(composeEditorText(ownBody))
  )
    return { kind: "confirm", warning: "attachment" };
  send(draft, message, {
    archive: archive && (draft.mode === "reply" || draft.mode === "replyAll"),
  });
  return { kind: "sent" };
}

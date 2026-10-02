import {
  applyComposeSignature,
  attachmentProblem,
  type AttachmentProblem,
  type Prefs,
} from "@openmail/core/schema";
import { useState } from "react";
import type { Account, OutgoingMessage } from "../../../shared/api";
import { attachmentProblemMessage } from "../attachment-problem-message";
import type { ComposeMessages } from "../components/Composer";
import { toDraftInput, type Draft } from "../draft";
import { submitDraft, type SendWarning } from "../send";

export function useComposeSend({
  adding,
  account,
  draft,
  onSend,
  currentSignature,
  prefs,
  messages,
}: {
  messages: ComposeMessages;
  adding: boolean;
  account: Account | undefined;
  draft: Draft;
  onSend: (draft: Draft, message: OutgoingMessage, options: { archive: boolean }) => void;
  currentSignature: Parameters<typeof applyComposeSignature>[1];
  prefs: Prefs;
}) {
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<{
    warning: SendWarning;
    archive: boolean;
    confirmed: readonly SendWarning[];
  } | null>(null);

  const showAttachmentProblem = (problem: AttachmentProblem) =>
    setError(attachmentProblemMessage(problem, messages));
  const submit = (archive: boolean, confirmed: readonly SendWarning[] = []) => {
    if (adding) {
      setError(messages.waitForAttachmentsToFinishLoading);
      return;
    }
    const problem = account
      ? attachmentProblem(account.provider, toDraftInput(draft).message.attachments)
      : undefined;
    if (problem) {
      showAttachmentProblem(problem);
      return;
    }
    const result = submitDraft(
      draft,
      archive,
      confirmed,
      onSend,
      applyComposeSignature(draft.body, currentSignature, undefined, prefs),
    );
    switch (result.kind) {
      case "invalid": {
        const list = result.addresses.join(messages.listSeparator);
        setError(messages.theseAreNotEmailAddresses(list));
        break;
      }
      case "noRecipients":
        setError(messages.addAtLeastOneRecipient);
        break;
      case "confirm":
        setError(null);
        setAsking({ warning: result.warning, archive, confirmed });
        break;
      case "sent":
        setAsking(null);
        break;
    }
  };

  return { error, setError, asking, setAsking, showAttachmentProblem, submit };
}

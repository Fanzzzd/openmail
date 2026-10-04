import {
  applyComposeSignature,
  agentRecipientWarnings,
  hasRecipientWarnings,
  attachmentProblem,
  type AttachmentProblem,
  type Prefs,
} from "@openmail/core/schema";
import { useEffect, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { Effect } from "effect";
import { useRunMail, withMail } from "../state/mail";
import type { Account, OutgoingMessage } from "../../../shared/api";
import { attachmentProblemMessage } from "../attachment-problem-message";
import type { ComposeMessages } from "../components/Composer";
import { toDraftInput, toMessage, type Draft } from "../draft";
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
  const run = useRunMail();
  const { t } = useLingui();
  const checking = useRef(false);
  const latestDraft = useRef(draft);
  useEffect(() => {
    latestDraft.current = draft;
  }, [draft]);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<{
    warning: SendWarning;
    archive: boolean;
    confirmed: readonly SendWarning[];
    recipients?: ReturnType<typeof agentRecipientWarnings>;
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
    const message = toMessage(draft).message;
    if (draft.agentOrigin && !confirmed.includes("recipients")) {
      if (checking.current) return;
      checking.current = true;
      run(
        withMail((call) =>
          Effect.gen(function* () {
            const known = yield* call("KnownSenders", {
              accountId: draft.accountId,
              addresses: [...message.to, ...message.cc, ...message.bcc].map((a) => a.address),
            });
            const thread = draft.agentOrigin?.replyTo
              ? yield* call("Thread", { id: draft.agentOrigin.replyTo }).pipe(
                  Effect.catchTag("NotFound", () => Effect.succeed([])),
                )
              : [];
            return agentRecipientWarnings(message, known, thread);
          }),
        ).pipe(
          Effect.match({
            onFailure: () => setError(t`Could not check recipients.`),
            onSuccess: (recipients) => {
              if (
                JSON.stringify(toDraftInput(latestDraft.current)) !==
                JSON.stringify(toDraftInput(draft))
              )
                return;
              if (hasRecipientWarnings(recipients)) {
                setError(null);
                setAsking({ warning: "recipients", archive, confirmed, recipients });
              } else submit(archive, [...confirmed, "recipients"]);
            },
          }),
          Effect.ensuring(
            Effect.sync(() => {
              checking.current = false;
            }),
          ),
        ),
      );
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

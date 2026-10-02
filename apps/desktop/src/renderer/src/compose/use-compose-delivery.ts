import { useLingui } from "@lingui/react/macro";
import { holdSend } from "@openmail/core/schema";
import { Effect, Fiber } from "effect";
import { useRef, type Dispatch, type SetStateAction } from "react";
import type { OutgoingMessage } from "../../../shared/api";
import type { AppMessages } from "../App";
import type { useMailSelection } from "../app/use-mail-selection";
import { type ToastState } from "../components/Toast";
import { toDraftInput, type Draft } from "../draft";
import { causeText } from "../errors";
import { saveDraft, sendMessage, useRunMail, withMail } from "../state/mail";
import { useBatchUndo } from "../state/undo";
export function useComposeDelivery({
  run,
  setCompose,
  say,
  composeId,
  finishCompose,
  navigation,
  undoRef,
  setToast,
  messages,
}: {
  messages: AppMessages;
  run: ReturnType<typeof useRunMail>;
  setCompose: (draft: Draft | null) => void;
  say: (next: Omit<ToastState, "id">) => void;
  composeId: string | undefined;
  finishCompose: () => void;
  navigation: ReturnType<typeof useMailSelection>;
  undoRef: ReturnType<typeof useBatchUndo>["undoRef"];
  setToast: Dispatch<SetStateAction<ToastState | null>>;
}) {
  const { prefs } = navigation;
  const { i18n } = useLingui();
  const pendingSends = useRef(new Map<string, (() => void) | null>());
  const reportSendState = () =>
    run(
      withMail((call) =>
        call("SetSendState", {
          pending: pendingSends.current.size,
          undoAvailable: [...pendingSends.current.values()].some((undo) => undo !== null),
        }),
      ),
    );
  const undoSend = () =>
    [...pendingSends.current.values()].filter((undo) => undo !== null).at(-1)?.();

  /**
   * Saves the draft (so quitting during the wait loses nothing), holds the
   * message for the undo window from preferences, then sends it. The window
   * is a timer (`holdSend`) that undo clears, so a message taken back never
   * reaches the main process. Undo, from the toast or ⌘Z, reopens the draft.
   */
  const send = (draft: Draft, message: OutgoingMessage, options: { archive: boolean }) => {
    setCompose(null);
    const reopen = () => setCompose(draft);
    pendingSends.current.set(draft.id, null);
    reportSendState();
    const saved = run(saveDraft(toDraftInput(draft)));
    const deliver = () =>
      run(
        Fiber.join(saved).pipe(
          Effect.andThen(
            sendMessage(draft.accountId, message, {
              draftId: draft.id,
              ...(options.archive ? { archive: true } : {}),
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              pendingSends.current.delete(draft.id);
              reportSendState();
            }),
          ),
          Effect.matchCause({
            onSuccess: () => {
              say({ text: options.archive ? messages.sentAndArchived : messages.sent });
              if (composeId) finishCompose();
              // The archived thread leaves the list; move on as E does.
              if (options.archive) navigation.archiveSentReply(draft.inReplyTo);
            },
            onFailure: (cause) => {
              const reason = causeText(i18n, cause);
              say({ text: messages.couldntSend(reason), tone: "error" });
              reopen();
            },
          }),
        ),
      );
    const delay = prefs.undoSendSeconds * 1000;
    if (delay === 0) {
      say({ text: messages.sending });
      deliver();
      return;
    }
    const held = holdSend(delay, () => {
      pendingSends.current.set(draft.id, null);
      reportSendState();
      if (undoRef.current === undo) undoRef.current = null;
      deliver();
    });
    const undo = () => {
      if (held.undo()) {
        pendingSends.current.delete(draft.id);
        reportSendState();
        if (undoRef.current === undo) undoRef.current = null;
        setToast(null);
        reopen();
      }
    };
    undoRef.current = undo;
    pendingSends.current.set(draft.id, undo);
    reportSendState();
    say({ text: messages.sending, duration: delay, action: { label: messages.undo, run: undo } });
  };

  return { send, hasPendingSends: () => pendingSends.current.size > 0, reportSendState, undoSend };
}

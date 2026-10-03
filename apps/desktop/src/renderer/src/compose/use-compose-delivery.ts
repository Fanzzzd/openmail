import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { holdSend } from "@openmail/core/schema";
import { Cause, Deferred, Effect, Fiber } from "effect";
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
  const uncertain = useRef(new Set<string>());
  const pendingSends = useRef(new Map<string, { token: symbol; undo: (() => void) | null }>());
  const reportSendState = () =>
    run(
      withMail((call) =>
        call("SetSendState", {
          pending: pendingSends.current.size,
          undoAvailable: [...pendingSends.current.values()].some(
            (pending) => pending.undo !== null,
          ),
        }),
      ),
    );
  const undoSend = () =>
    [...pendingSends.current.values()]
      .filter((pending) => pending.undo !== null)
      .at(-1)
      ?.undo?.();

  /** Core persists the undo deadline and owns delivery across renderer restarts. */
  const send = (draft: Draft, message: OutgoingMessage, options: { archive: boolean }) => {
    const confirmResend = uncertain.current.has(draft.id);
    if (
      confirmResend &&
      !window.confirm(
        i18n._(
          msg({
            message: "Have you checked Sent and confirmed that this message was not sent?",
            comment: "Sent means the Sent mailbox.",
          }),
        ),
      )
    )
      return;
    setCompose(null);
    const reopen = () => setCompose(draft);
    const token = Symbol();
    const clearPending = () => {
      if (pendingSends.current.get(draft.id)?.token === token)
        pendingSends.current.delete(draft.id);
      reportSendState();
    };
    pendingSends.current.set(draft.id, { token, undo: null });
    reportSendState();
    const delay = prefs.undoSendSeconds * 1000;
    const due = Date.now() + delay;
    let undone = false;
    let undoInProgress = false;
    const undoFinished = Deferred.makeUnsafe<void>();
    const saved = run(
      delay === 0
        ? saveDraft(toDraftInput(draft)).pipe(Effect.asVoid)
        : withMail((call) =>
            call("QueueUndoSend", {
              draft: { ...toDraftInput(draft), message },
              due,
              archive: options.archive,
              confirmResend,
            }),
          ),
    );
    const deliver = () =>
      run(
        Fiber.join(saved).pipe(
          Effect.andThen(
            delay > 0
              ? withMail((call) => call("AwaitUndoSend", { id: draft.id }))
              : sendMessage(draft.accountId, message, {
                  draftId: draft.id,
                  ...(confirmResend ? { confirmResend: true } : {}),
                  ...(options.archive ? { archive: true } : {}),
                }),
          ),
          Effect.onExit(() =>
            Effect.suspend(() => (undoInProgress ? Deferred.await(undoFinished) : Effect.void)),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              clearPending();
            }),
          ),
          Effect.matchCause({
            onSuccess: () => {
              if (undone) return;
              uncertain.current.delete(draft.id);
              say({ text: options.archive ? messages.sentAndArchived : messages.sent });
              if (composeId) finishCompose();
              // The archived thread leaves the list; move on as E does.
              if (options.archive) navigation.archiveSentReply(draft.inReplyTo);
            },
            onFailure: (cause) => {
              if (undone) return;
              const error = Cause.findErrorOption(cause);
              if (error._tag === "Some" && error.value._tag === "SendUncertain")
                uncertain.current.add(draft.id);
              const reason = causeText(i18n, cause);
              say({ text: messages.couldntSend(reason), tone: "error" });
              reopen();
            },
          }),
        ),
      );
    if (delay === 0) {
      say({ text: messages.sending });
      deliver();
      return;
    }
    const held = holdSend(delay, () => {
      if (pendingSends.current.get(draft.id)?.token === token)
        pendingSends.current.set(draft.id, { token, undo: null });
      reportSendState();
      if (undoRef.current === undo) undoRef.current = null;
    });
    const undo = () => {
      if (held.undo()) {
        undoInProgress = true;
        run(
          Fiber.join(saved).pipe(
            Effect.andThen(withMail((call) => call("CancelWaitingSend", { id: draft.id }))),
            Effect.matchCause({
              onSuccess: (cancelled) => {
                undone = cancelled;
                if (undoRef.current === undo) undoRef.current = null;
                setToast(null);
                if (!cancelled) {
                  if (pendingSends.current.get(draft.id)?.token === token)
                    pendingSends.current.set(draft.id, { token, undo: null });
                  reportSendState();
                  return;
                }
                clearPending();
                reopen();
              },
              onFailure: (cause) => {
                undone = false;
                say({ text: messages.couldntSend(causeText(i18n, cause)), tone: "error" });
              },
            }),
            Effect.ensuring(
              Effect.sync(() => {
                undoInProgress = false;
              }).pipe(Effect.andThen(Deferred.succeed(undoFinished, undefined))),
            ),
          ),
        );
      }
    };
    deliver();
    undoRef.current = undo;
    pendingSends.current.set(draft.id, { token, undo });
    reportSendState();
    say({ text: messages.sending, duration: delay, action: { label: messages.undo, run: undo } });
  };

  return { send, hasPendingSends: () => pendingSends.current.size > 0, reportSendState, undoSend };
}

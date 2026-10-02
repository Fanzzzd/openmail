import { useLingui } from "@lingui/react/macro";
import type { Signature } from "@openmail/core/schema";
import {
  applyComposeSignature,
  FEEDBACK_DRAFT_PREFIX,
  richComposeBody,
  textComposeHtml,
} from "@openmail/core/schema";
import { Effect } from "effect";
import { Atom } from "effect/reactivity";
import type { Dispatch, SetStateAction } from "react";
import { useEffect, useEffectEvent, useState } from "react";
import type { Account, Proposal } from "../../../shared/api";
import { type DesktopEvent } from "../../../shared/desktop";
import type { AppMessages } from "../App";
import { type FeedbackInput } from "../components/Feedback";
import { type ToastState } from "../components/Toast";
import { resolveComposeSender } from "../compose-sender";
import { useComposeDelivery } from "../compose/use-compose-delivery";
import {
  draftFor,
  emptyDraft,
  fromStored,
  toDraftInput,
  type ComposeMode,
  type Draft,
} from "../draft";
import { causeText } from "../errors";
import { quoteChoice, readerSelectedText } from "../quote-selection";
import { replySource, replyTarget, type ReaderSelection } from "../reader-selection";
import { discardDraft, openDraft, saveDraft, useRunMail, withMail } from "../state/mail";
import { accountsAtom, prefsAtom, sendAsAtom, threadAtom } from "../state/queries";
import { useBatchUndo } from "../state/undo";
import { scopeAccountIds } from "../view";
import type { useAppPanels } from "./use-app-panels";
import type { useMailSelection } from "./use-mail-selection";
export function useMailCompose({
  panels,
  navigation,
  composeId,
  run,
  accountList,
  signatures,
  say,
  readerSelection,
  currentReaderThreadKey,
  undoRef,
  setToast,
  messages,
}: {
  messages: AppMessages;
  panels: ReturnType<typeof useAppPanels>;
  navigation: ReturnType<typeof useMailSelection>;
  composeId: string | undefined;
  run: ReturnType<typeof useRunMail>;
  accountList: readonly Account[];
  signatures: readonly Signature[];
  say: (next: Omit<ToastState, "id">) => void;
  readerSelection: ReaderSelection | null;
  currentReaderThreadKey: string | null;
  undoRef: ReturnType<typeof useBatchUndo>["undoRef"];
  setToast: Dispatch<SetStateAction<ToastState | null>>;
}) {
  const { setDialog } = panels;
  const { prefs, view, selectedId } = navigation;
  const { i18n } = useLingui();

  const [compose, setComposeState] = useState<Draft | null>(null);
  const setCompose = (draft: Draft | null) => {
    if (composeId) {
      setComposeState(draft);
      return;
    }
    if (draft === null) setComposeState(null);
    run(
      withMail((call) => call("ClaimInlineDraft", { id: draft?.id ?? null })).pipe(
        Effect.map((claimed) => {
          if (draft && claimed) setComposeState(draft);
        }),
      ),
    );
  };
  const [popOutRequested, setPopOutRequested] = useState(0);
  const [closeRequested, setCloseRequested] = useState(0);
  const [crashFeedback, setCrashFeedback] = useState(false);

  /** The local signature for an account: one for new messages, one for replies and forwards. */
  const signatureAt = (accountId: string, mode: ComposeMode, from?: string) => {
    const address = (from ?? accountList.find((a) => a.id === accountId)?.email)?.toLowerCase();
    const kind = mode === "new" ? "new" : "reply";
    return signatures.find((s) => s.address === address && s.kind === kind);
  };
  const [quotePrompt, setQuotePrompt] = useState<((useSelection: boolean) => void) | null>(null);
  const signatureFor = (accountId: string, mode: ComposeMode, from?: string) =>
    signatureAt(accountId, mode, from)?.text;
  const signed = (draft: Draft): Draft => ({
    ...draft,
    body: applyComposeSignature(
      draft.body,
      undefined,
      signatureAt(draft.accountId, draft.mode, draft.from?.address),
      prefs,
    ),
  });

  const newMessageDraft = () =>
    Atom.getResult(accountsAtom).pipe(
      Effect.flatMap((loadedAccounts) =>
        resolveComposeSender({
          accounts: loadedAccounts,
          view,
          scope: scopeAccountIds(view, loadedAccounts),
          prefs: Atom.getResult(prefsAtom),
          aliases: Atom.getResult(sendAsAtom),
        }),
      ),
      Effect.map((sender) =>
        sender
          ? signed({
              ...emptyDraft(sender.accountId),
              from: { name: sender.name, address: sender.address },
            })
          : null,
      ),
    );
  const startNewMessage = (mailto?: Extract<DesktopEvent, { _tag: "Compose" }>["draft"]) =>
    run(
      newMessageDraft().pipe(
        Effect.flatMap((base) => {
          if (!base) return Effect.void;
          const draft = mailto
            ? signed({ ...base, ...mailto, body: richComposeBody(textComposeHtml(mailto.body)) })
            : base;
          setCompose(draft);
          return mailto ? saveDraft(toDraftInput(draft)).pipe(Effect.asVoid) : Effect.void;
        }),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            const reason = causeText(i18n, cause);
            say({ text: messages.cantOpenTheDraft(reason), tone: "error" });
          }),
        ),
      ),
    );
  const sendAgain = (id = selectedId) => {
    if (!id) return;
    run(
      withMail((call) => call("SendAgain", { id })).pipe(
        Effect.matchCause({
          onSuccess: (draft) => setCompose(fromStored(draft)),
          onFailure: (cause) => {
            const reason = causeText(i18n, cause);
            say({ text: messages.cantOpenTheDraft(reason), tone: "error" });
          },
        }),
      ),
    );
  };

  const startCompose = (
    mode: Draft["mode"],
    asAttachment = false,
    id = replyTarget(readerSelection, selectedId, prefs.threadGrouping, currentReaderThreadKey),
  ) => {
    if (mode === "new") {
      startNewMessage();
      return;
    }
    if (!id) return;
    const selectedText = asAttachment ? undefined : readerSelectedText(document, id);
    const open = (useSelection: boolean) =>
      run(
        Effect.gen(function* () {
          const thread = yield* Atom.getResult(threadAtom(id));
          const aliases = mode === "forward" ? [] : yield* Atom.getResult(sendAsAtom);
          const last = replySource(thread, id);
          const account = accountList.find((a) => a.id === last?.accountId);
          if (!last || !account) return;
          const draft = draftFor(
            mode,
            last,
            account,
            asAttachment,
            aliases,
            useSelection ? selectedText : undefined,
            { preference: prefs.replyFrom, aliases },
          );
          setCompose(signed(draft));
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              say({ text: causeText(i18n, cause), tone: "error" });
            }),
          ),
        ),
      );
    const choice = quoteChoice(prefs.quoteSelection, selectedText);
    if (choice === "ask") setQuotePrompt(() => open);
    else open(choice === "selection");
  };

  /** Opens a saved draft: a local draft id, a draft message, or "proposal:<id>". */
  const openSavedDraft = (id: string) =>
    run(
      openDraft(id).pipe(
        Effect.matchCause({
          onSuccess: (d) => {
            if (composeId) setCompose(fromStored(d));
            else run(withMail((call) => call("OpenComposeWindow", { id: d.id })));
          },
          onFailure: (cause) => {
            const reason = causeText(i18n, cause);
            say({ text: messages.cantOpenTheDraft(reason), tone: "error" });
          },
        }),
      ),
    );

  const openProposal = (p: Proposal) => {
    if (p.command.kind !== "send" && p.command.kind !== "draft") return;
    setDialog(null);
    openSavedDraft(`proposal:${p.id}`);
  };

  const finishCompose = () => {
    setCompose(null);
    if (composeId) run(withMail((call) => call("CloseComposeWindow", undefined)));
  };
  const popOut = (draft: Draft) =>
    run(
      saveDraft(toDraftInput(draft)).pipe(
        Effect.andThen(
          withMail((call) =>
            call("OpenComposeWindow", {
              id: draft.id,
              recipients: { to: draft.to, cc: draft.cc, bcc: draft.bcc },
              transfer: true,
            }),
          ),
        ),
        Effect.matchCause({
          onSuccess: () => setCompose(null),
          onFailure: () => say({ text: messages.couldNotOpenTheComposeWindow, tone: "error" }),
        }),
      ),
    );
  const feedbackDraft = (input: FeedbackInput) =>
    run(
      newMessageDraft().pipe(
        Effect.flatMap((base) => {
          if (!base) {
            say({ text: messages.connectAnAccountToSendFeedback, tone: "error" });
            return Effect.void;
          }
          const draft = {
            ...base,
            id: `${FEEDBACK_DRAFT_PREFIX}${crypto.randomUUID()}`,
            to: input.to,
            subject: input.subject,
            body: richComposeBody(textComposeHtml(input.body)),
            attachments: input.attachments,
          };
          return saveDraft(toDraftInput(draft)).pipe(
            Effect.andThen(
              withMail((call) =>
                call("OpenComposeWindow", {
                  id: draft.id,
                  recipients: { to: draft.to, cc: draft.cc, bcc: draft.bcc },
                  transfer: true,
                }),
              ),
            ),
          );
        }),
        Effect.catchCause(() =>
          Effect.sync(() => say({ text: messages.couldNotOpenTheFeedbackDraft, tone: "error" })),
        ),
      ),
    );
  const startupDraftFailed = useEffectEvent(() =>
    say({ text: messages.couldNotOpenTheDraft, tone: "error" }),
  );
  useEffect(() => {
    if (composeId) {
      run(
        withMail((call) => call("ComposeWindowDraft", { id: composeId })).pipe(
          Effect.matchCause({
            onSuccess: ({ draft, recipients }) =>
              setComposeState({ ...fromStored(draft), ...recipients }),
            onFailure: startupDraftFailed,
          }),
        ),
      );
    } else {
      run(
        withMail((call) => call("CrashReportPending", undefined)).pipe(
          Effect.map((pending) => {
            if (pending) {
              setCrashFeedback(true);
              setDialog("feedback");
            }
          }),
        ),
      );
    }
  }, [composeId, run, setDialog]);
  /** Quiet closes retain storage; explicit Save persists even a cleared draft. */
  const closeCompose = (draft: Draft, changed: boolean) => {
    if (!changed) {
      finishCompose();
      return;
    }
    run(
      saveDraft(toDraftInput(draft)).pipe(
        Effect.matchCause({
          onSuccess: finishCompose,
          onFailure: (cause) => {
            const reason = causeText(i18n, cause);
            say({ text: messages.couldntSaveTheDraft(reason), tone: "error" });
          },
        }),
      ),
    );
  };

  const discard = (draft: Draft) => {
    setCompose(null);
    run(
      discardDraft(draft.id).pipe(
        Effect.matchCause({
          onSuccess: () => {
            say({ text: messages.draftDiscarded });
            if (composeId) finishCompose();
          },
          onFailure: (cause) => {
            const reason = causeText(i18n, cause);
            say({ text: messages.couldntDiscard(reason), tone: "error" });
          },
        }),
      ),
    );
  };

  const { send, hasPendingSends, reportSendState, undoSend } = useComposeDelivery({
    messages,
    run,
    setCompose,
    say,
    composeId,
    finishCompose,
    navigation,
    undoRef,
    setToast,
  });

  return {
    compose,
    setCompose,
    popOutRequested,
    setPopOutRequested,
    closeRequested,
    setCloseRequested,
    crashFeedback,
    setCrashFeedback,
    hasPendingSends,
    reportSendState,
    undoSend,
    signatureFor,
    quotePrompt,
    setQuotePrompt,
    newMessageDraft,
    startNewMessage,
    sendAgain,
    startCompose,
    openSavedDraft,
    openProposal,
    popOut,
    feedbackDraft,
    closeCompose,
    discard,
    send,
  };
}

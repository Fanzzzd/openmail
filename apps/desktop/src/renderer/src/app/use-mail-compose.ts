import { canCall, isDesktop } from "../lib/platform";
import { useLingui } from "@lingui/react/macro";
import type { Signature } from "@openmail/core/schema";
import { FEEDBACK_DRAFT_PREFIX } from "@openmail/core/schema";
import { Effect } from "effect";
import { constVoid } from "effect/Function";
import { Atom } from "effect/reactivity";
import type { Dispatch, SetStateAction } from "react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { Account, Proposal } from "../../../shared/api";
import { type DesktopEvent } from "../../../shared/desktop";
import type { AppMessages } from "./use-app-messages";
import { type FeedbackInput } from "../features/feedback/Feedback";
import { type ToastState } from "../ui/Toast";
import { defaultSignature, resolveComposeSender } from "../features/compose/compose-sender";
import { useComposeDelivery } from "./use-compose-delivery";
import type { ComposeMode, Draft } from "../features/compose/draft";
import { loadDrafts } from "../features/compose/draft-loader";
import {
  clearDraftBackup,
  draftFromBackup,
  markRestored,
  readDraftBackup,
} from "../features/compose/draft-backup";
import { causeText } from "../lib/errors";
import { quoteChoice, readerSelectedText } from "../features/reader/quote-selection";
import {
  replySource,
  replyTarget,
  type ReaderSelection,
} from "../features/reader/reader-selection";
import {
  discardDraft,
  openDraft,
  restoreDraft,
  saveDraft,
  useRunMail,
  withMail,
} from "../state/mail";
import { accountsAtom, prefsAtom, sendAsAtom, threadAtom } from "../state/queries";
import { useBatchUndo } from "../state/undo";
import { scopeAccountIds } from "../lib/view";
import { useAtomSet } from "@effect/atom-react";
import { dialogAtom } from "../state/ui";
import type { useMailSelection } from "./use-mail-selection";

/** Core holds a discarded draft this long; the toast closes first, so Undo never races it. */
const DISCARD_HOLD_MS = 15_000;
const DISCARD_TOAST_MS = 8000;

export function useMailCompose({
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
  const setDialog = useAtomSet(dialogAtom);
  const { prefs, view, selectedId } = navigation;
  const { i18n } = useLingui();

  const [compose, setComposeState] = useState<Draft | null>(null);
  /** The open inline draft now, for callbacks that finish after a later render. */
  const composeRef = useRef<Draft | null>(null);
  useEffect(() => {
    composeRef.current = compose;
  }, [compose]);
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

  const signatureAt = (accountId: string, mode: ComposeMode, from?: string) =>
    defaultSignature(signatures, accountList, accountId, mode, from);
  const [quotePrompt, setQuotePrompt] = useState<((useSelection: boolean) => void) | null>(null);
  const signatureFor = (accountId: string, mode: ComposeMode, from?: string) =>
    signatureAt(accountId, mode, from)?.text;
  const signed = (
    { applyComposeSignature }: Effect.Success<typeof loadDrafts>,
    draft: Draft,
  ): Draft => ({
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
      Effect.flatMap((sender) =>
        sender
          ? Effect.map(loadDrafts, (drafts) =>
              signed(drafts, {
                ...drafts.emptyDraft(sender.accountId),
                from: { name: sender.name, address: sender.address },
              }),
            )
          : Effect.succeed(null),
      ),
    );
  const startNewMessage = (mailto?: Extract<DesktopEvent, { _tag: "Compose" }>["draft"]) =>
    run(
      newMessageDraft().pipe(
        Effect.flatMap((base) => {
          if (!base) return Effect.void;
          if (!mailto) {
            setCompose(base);
            return Effect.void;
          }
          return Effect.flatMap(loadDrafts, (drafts) => {
            const draft = signed(drafts, {
              ...base,
              ...mailto,
              body: drafts.richComposeBody(drafts.textComposeHtml(mailto.body)),
            });
            setCompose(draft);
            return saveDraft(drafts.toDraftInput(draft)).pipe(Effect.asVoid);
          });
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
        Effect.flatMap((draft) => Effect.map(loadDrafts, ({ fromStored }) => fromStored(draft))),
        Effect.matchCause({
          onSuccess: setCompose,
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
          const drafts = yield* loadDrafts;
          const draft = drafts.draftFor(
            i18n,
            mode,
            last,
            account,
            asAttachment,
            aliases,
            useSelection ? selectedText : undefined,
            { preference: prefs.replyFrom, aliases },
          );
          setCompose(signed(drafts, draft));
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
        Effect.flatMap((d) =>
          // The web build has no compose windows; drafts open inline.
          composeId || !isDesktop()
            ? Effect.map(loadDrafts, ({ fromStored }) => setCompose(fromStored(d)))
            : Effect.sync(() => run(withMail((call) => call("OpenComposeWindow", { id: d.id })))),
        ),
        Effect.matchCause({
          onSuccess: constVoid,
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
      loadDrafts.pipe(
        Effect.flatMap(({ toDraftInput }) => saveDraft(toDraftInput(draft))),
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
          return loadDrafts.pipe(
            Effect.flatMap(({ richComposeBody, textComposeHtml, toDraftInput }) => {
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
          Effect.flatMap(({ draft, recipients }) =>
            Effect.map(loadDrafts, ({ fromStored }) => ({ ...fromStored(draft), ...recipients })),
          ),
          Effect.matchCause({
            onSuccess: setComposeState,
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
  // The web build: a reload (the Mac restarted, or the phone dropped the tab)
  // reopens the draft this tab had open with the typing it had.
  const reopenBackup = useEffectEvent((draft: Draft) => {
    markRestored(draft.id);
    setCompose(draft);
  });
  useEffect(() => {
    if (composeId || isDesktop()) return;
    const backup = readDraftBackup();
    if (!backup) return;
    const { id } = backup.draft;
    run(
      openDraft(id).pipe(
        Effect.flatMap((stored) => Effect.map(loadDrafts, ({ fromStored }) => fromStored(stored))),
        Effect.catchTag("NotFound", () => Effect.succeed(null)),
        Effect.matchCause({
          onSuccess: (stored) => {
            const draft = draftFromBackup(backup, stored);
            if (draft) reopenBackup(draft);
            else clearDraftBackup(id);
          },
          // The Mac didn't answer: keep the backup for the next load.
          onFailure: constVoid,
        }),
      ),
    );
  }, [composeId, run]);
  /** Quiet closes retain storage; explicit Save persists even a cleared draft. */
  const closeCompose = (draft: Draft, changed: boolean) => {
    if (!changed) {
      finishCompose();
      return;
    }
    run(
      loadDrafts.pipe(
        Effect.flatMap(({ toDraftInput }) => saveDraft(toDraftInput(draft))),
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

  /**
   * Shows a draft again without replacing another open draft: a compose window, or inline
   * when nothing else is open. The web build has one composer; the open one saves as it closes.
   */
  const reopenDraft = (draft: Draft) => {
    const open = composeRef.current;
    if (composeId || !isDesktop() || !open || open.id === draft.id) {
      setCompose(draft);
      return;
    }
    run(
      withMail((call) => call("OpenComposeWindow", { id: draft.id })).pipe(
        Effect.catchCause(() =>
          Effect.sync(() => say({ text: messages.couldNotOpenTheComposeWindow, tone: "error" })),
        ),
      ),
    );
  };
  const anotherDraftOpen = (id: string) =>
    !composeId && composeRef.current !== null && composeRef.current.id !== id;

  /** Undo for a held discard; `latest` has typing the last autosave missed. */
  const offerDiscardUndo = (id: string, latest: Draft | null) => {
    let used = false;
    const undo = () => {
      if (used) return;
      used = true;
      if (undoRef.current === undo) undoRef.current = null;
      setToast(null);
      run(
        restoreDraft(id).pipe(
          Effect.flatMap((stored) =>
            Effect.flatMap(loadDrafts, ({ fromStored, toDraftInput }) =>
              latest
                ? saveDraft(toDraftInput(latest)).pipe(Effect.as(latest))
                : Effect.succeed(fromStored(stored)),
            ),
          ),
          Effect.matchCause({
            onSuccess: reopenDraft,
            onFailure: (cause) =>
              say({ text: messages.couldntRestoreTheDraft(causeText(i18n, cause)), tone: "error" }),
          }),
        ),
      );
    };
    undoRef.current = undo;
    say({
      text: messages.draftDiscarded,
      duration: DISCARD_TOAST_MS,
      action: { label: messages.undo, run: undo },
    });
  };

  /**
   * Core holds the discard for the undo window, so nothing is deleted until it ends. A compose
   * window closes at once; the main window shows its Undo.
   */
  const discard = (draft: Draft) => {
    setCompose(null);
    const holdMs = canCall("RestoreDraft") ? DISCARD_HOLD_MS : undefined;
    run(
      loadDrafts.pipe(
        Effect.flatMap(({ toDraftInput }) =>
          // The main window cannot see this window's latest typing; core keeps it.
          composeId && holdMs ? saveDraft(toDraftInput(draft)) : Effect.void,
        ),
        Effect.andThen(discardDraft(draft.id, holdMs)),
        Effect.matchCause({
          onSuccess: (held) => {
            if (composeId) {
              if (held)
                run(
                  withMail((call) =>
                    call("ShowUndo", {
                      text: messages.draftDiscarded,
                      undo: { _tag: "Draft", id: draft.id },
                    }),
                  ),
                );
              finishCompose();
            } else if (held) offerDiscardUndo(draft.id, draft);
            else say({ text: messages.draftDiscarded });
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
    reopenDraft,
    anotherDraftOpen,
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
    offerDiscardUndo,
    send,
  };
}

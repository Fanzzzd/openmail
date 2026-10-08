import { focusedSenderMessage, requestFocusedPermission, threadStateFor } from "./focused-inbox";
import { nativeShareKind } from "../../shared/native-actions";
import { Settings, ShortcutHelp, AddAccountDialog } from "./components/LazyDialogs";
import { dispatchNativeAction, shouldDropNativeAction } from "./native-actions";
import { useDesktopEvents, useDesktopLabels } from "./state/desktop";
import { deleteKeyOp, usesDeletePreference } from "./delete-key";
import { Alert, AlertCancel, alertButton } from "./components/ui/Dialog";
import { shortcutAction } from "../../shared/shortcuts";

import { useAtomMount, useAtomValue } from "@effect/atom-react";
import { useLingui } from "@lingui/react/macro";
import { DEFAULT_PREFS, markReadAfter } from "@openmail/core/schema";
import { Effect } from "effect";
import { constVoid } from "effect/Function";
import { AsyncResult } from "effect/reactivity";
import { Mail } from "lucide-react";
import { useCallback, useEffect, useEffectEvent, useState } from "react";

import type { MailOp } from "../../shared/api";
import { ThreadView, useThreadPrint } from "./components/Reader";
import { readerThreadKey } from "./reader-selection";
import { useBatchUndo } from "./state/undo";
import { FocusedInboxPermission } from "./components/FocusedInboxActions";
import { ThreadActions } from "./components/ThreadActions";
import type { ThreadState } from "./focused-inbox";
import { isTypingTarget } from "./typing-target";
import { Toast, type ToastState } from "./components/Toast";
import { trafficLightInset } from "./components/ui/styles";
import { causeText } from "./errors";
import { MailClient } from "./rpc";
import { liveUpdatesAtom } from "./state/events";
import { modifyMessages, modifyThreads, modifyWithUndo, useRunMail, withMail } from "./state/mail";
import { accountsAtom, labelsAtom, prefsAtom, threadAtom, sendAsAtom } from "./state/queries";

/** Ops after which the thread has left where it was; the window closes, as in Mail. */
const LEAVES = new Set<MailOp["kind"]>(["archive", "trash", "spam"]);

/**
 * A window with one thread, opened from the list (double-click, context menu)
 * or the reader toolbar. Same renderer and preload as the main window; it
 * shows only the reader, with the thread's actions but no compose.
 */
export function ThreadWindow({ id, single = false }: { id: string; single?: boolean }) {
  useAtomMount(MailClient.runtime);
  useAtomMount(liveUpdatesAtom);
  const run = useRunMail();
  useDesktopLabels();
  const { t, i18n } = useLingui();
  const [selectedMessage, setSelectedMessage] = useState(id);
  const [toast, setToast] = useState<ToastState | null>(null);
  const hideToast = useCallback(() => setToast(null), []);
  const say = (next: Omit<ToastState, "id">) => setToast({ ...next, id: Date.now() });
  const { undoRef, showUndo } = useBatchUndo({
    notify: say,
    clearToast: hideToast,
    label: t`Undo`,
    failureText: (cause) => {
      const reason = causeText(i18n, cause);
      return t`Action failed: ${reason}`;
    },
  });
  const print = useThreadPrint((next) => say(next));

  const thread = useAtomValue(threadAtom(id));
  const messages = AsyncResult.isSuccess(thread)
    ? single
      ? thread.value.filter((message) => message.id === id)
      : thread.value
    : undefined;
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  const accounts = AsyncResult.getOrElse(useAtomValue(accountsAtom), () => []);
  const account = accounts.find((a) => a.id === messages?.[0]?.accountId);
  const labels = AsyncResult.getOrElse(useAtomValue(labelsAtom()), () => []).filter(
    (l) => l.accountId === account?.id,
  );
  const [deleteKeyPrompt, setDeleteKeyPrompt] = useState(false);
  const [labelPicker, setLabelPicker] = useState(false);
  const [pickerMode, setPickerMode] = useState<"label" | "move">("label");
  const [dialog, setDialog] = useState<"settings" | "help" | "add" | null>(null);
  const subject = messages?.at(-1)?.subject;

  useEffect(() => {
    document.title = subject || "OpenMail";
  }, [subject]);

  const aliasResult = useAtomValue(sendAsAtom);
  const aliases = AsyncResult.getOrElse(aliasResult, () => []);
  const focusedMessage = AsyncResult.isSuccess(aliasResult)
    ? focusedSenderMessage(
        messages,
        [
          ...accounts.map((ownedAccount) => ownedAccount.email),
          ...aliases.map((alias) => alias.address),
        ],
        selectedMessage,
      )
    : undefined;
  const state: ThreadState | null =
    account && messages ? threadStateFor(account.provider, messages, focusedMessage) : null;

  // Opening the window counts as opening the thread, with the same delay.
  const unread = state?.isUnread ?? false;
  const markRead = useEffectEvent(() => {
    run(
      single
        ? modifyMessages([id], { kind: "read", value: true }).pipe(Effect.asVoid)
        : modifyThreads([id], { kind: "read", value: true }).pipe(Effect.asVoid),
    );
  });
  const [marked, setMarked] = useState(false);
  useEffect(
    () =>
      unread && !marked
        ? markReadAfter(prefs.markReadDelay, () => {
            setMarked(true);
            markRead();
          })
        : constVoid,
    [unread, marked, prefs.markReadDelay],
  );

  const act = (op: MailOp, keepOpen = false) => {
    if (op.kind === "read" && !op.value) setMarked(true);
    return run(
      (op.kind === "classification"
        ? modifyWithUndo([id], op, false).pipe(
            Effect.tap((result) =>
              Effect.sync(() =>
                showUndo(
                  result,
                  [id],
                  op.value === "focused" ? t`Moved to Focused` : t`Moved to Other`,
                ),
              ),
            ),
            Effect.asVoid,
          )
        : single
          ? modifyMessages([id], op).pipe(Effect.asVoid)
          : modifyThreads([id], op).pipe(Effect.asVoid)
      ).pipe(
        Effect.matchCause({
          onFailure: (cause) => {
            if (requestFocusedPermission(cause)) return;
            const reason = causeText(i18n, cause);
            say({ text: t`Action failed: ${reason}`, tone: "error" });
          },
          onSuccess: () => {
            if (LEAVES.has(op.kind) && !keepOpen) window.close();
          },
        }),
      ),
    );
  };
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (
      dialog ||
      deleteKeyPrompt ||
      e.defaultPrevented ||
      (e.target instanceof Element && e.target.closest('[role="menu"],[role="dialog"]'))
    )
      return;
    const action = shortcutAction(prefs.shortcutSet, e, isTypingTarget(e.target));
    if (!action) return;
    switch (action) {
      case "undo":
        e.preventDefault();
        undoRef.current?.();
        break;
      case "print":
        e.preventDefault();
        print(id, false, !single && prefs.threadGrouping ? undefined : id);
        break;
      case "compose":
        e.preventDefault();
        run(withMail((call) => call("ComposeNew", undefined)));
        break;
      case "newWindow":
        e.preventDefault();
        run(withMail((call) => call("NewWindow", undefined)));
        break;
      case "settings":
        e.preventDefault();
        setDialog("settings");
        break;
      case "help":
        e.preventDefault();
        setDialog("help");
        break;
      case "archive":
        e.preventDefault();
        act({ kind: "archive" });
        break;
      case "trash": {
        e.preventDefault();
        if (!usesDeletePreference(e)) {
          act({ kind: "trash" });
          break;
        }
        if (prefs.deleteKeyAction === "ask") {
          setDeleteKeyPrompt(true);
          break;
        }
        const { op, fallback } = deleteKeyOp(prefs.deleteKeyAction, {});
        if (fallback) say({ text: t`No current label applies. Moving to Trash.` });
        act(op, fallback);
        break;
      }
      case "spam":
        e.preventDefault();
        act({ kind: "spam" });
        break;
      case "read":
        if (state) {
          e.preventDefault();
          act({ kind: "read", value: state.isUnread });
        }
        break;
      case "star":
        if (state) {
          e.preventDefault();
          act({ kind: "star", value: !state.isStarred });
        }
        break;
      case "label":
      case "move":
        if (state) {
          e.preventDefault();
          setPickerMode(action);
          setLabelPicker(true);
        }
        break;
    }
  });
  useEffect(() => {
    const listener = (e: KeyboardEvent) => onKey(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const composeFrom = (
    messageId: string,
    mode: "reply" | "replyAll" | "forward",
    asAttachment = false,
  ) => run(withMail((call) => call("ComposeMessage", { id: messageId, mode, asAttachment })));
  useDesktopEvents((event) => {
    if (
      event._tag !== "NativeAction" ||
      shouldDropNativeAction(event.action, event.triggeredByAccelerator)
    )
      return;
    const kind = nativeShareKind(event.action);
    if (kind) {
      run(
        withMail((call) => call("ShareMessageLink", { id: selectedMessage, kind })).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => say({ text: causeText(i18n, cause), tone: "error" })),
          ),
        ),
      );
      return;
    }
    if (
      event.action === "reply" ||
      event.action === "replyAll" ||
      event.action === "forward" ||
      event.action === "forwardAttachment"
    )
      composeFrom(
        selectedMessage,
        event.action === "forwardAttachment" ? "forward" : event.action,
        event.action === "forwardAttachment",
      );
    else dispatchNativeAction(prefs.shortcutSet, event.action, event.triggeredByAccelerator);
  });
  useEffect(() => {
    run(
      withMail((call) =>
        call("SetNativeMenuState", {
          state: {
            selected: Boolean(messages?.length) && !dialog,
            composing: false,
            mailbox: false,
            gmail: account?.provider === "gmail",
            web: account?.provider === "gmail" || account?.provider === "outlook",
          },
        }),
      ),
    );
  }, [run, messages?.length, dialog, account?.provider]);

  return (
    <div className="flex h-full flex-col bg-white text-[13px] text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
      <FocusedInboxPermission />
      {/* Room on the left for the traffic lights; actions that do not fit fold into the menu. */}
      <header
        data-thread-toolbar
        className={`drag flex h-13 shrink-0 items-center pr-4 ${trafficLightInset}`}
      >
        {state && (
          <ThreadActions
            pickerMode={pickerMode}
            organizationTarget={
              account ? { accountId: account.id, threads: [id], flat: single } : undefined
            }
            state={state}
            mailbox="all"
            labels={labels}
            onOp={act}
            labelPicker={labelPicker}
            onLabelPicker={setLabelPicker}
          />
        )}
      </header>
      {messages ? (
        <ThreadView
          key={readerThreadKey(messages[0])}
          messages={AsyncResult.isSuccess(thread) ? thread.value : []}
          selectedId={id}
          onSelectMessage={setSelectedMessage}
          onComposeMessage={composeFrom}
          onMarkUnread={() => setMarked(true)}
          onActionDone={({ result, ids }) => showUndo(result, ids, t`Message updated`)}
          single={single || !prefs.threadGrouping}
          notify={(next) => say(next)}
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-neutral-300 dark:text-neutral-600">
          <Mail className="size-10 stroke-1" />
          {AsyncResult.isFailure(thread) && (
            <p className="text-a11y-muted">{causeText(i18n, thread.cause)}</p>
          )}
        </div>
      )}
      {dialog === "settings" && (
        <Settings
          accounts={accounts}
          onClose={() => setDialog(null)}
          onAddAccount={() => setDialog("add")}
        />
      )}
      {dialog === "help" && <ShortcutHelp onClose={() => setDialog(null)} />}
      {dialog === "add" && (
        <AddAccountDialog onClose={() => setDialog(null)} onAdded={() => setDialog("settings")} />
      )}
      <Alert
        open={deleteKeyPrompt}
        onOpenChange={setDeleteKeyPrompt}
        title={t`Choose Delete key action`}
      >
        <AlertCancel>{t`Cancel`}</AlertCancel>
        {(["trash", "archive"] as const).map((action) => (
          <button
            type="button"
            key={action}
            className={alertButton}
            onClick={() => {
              setDeleteKeyPrompt(false);
              act({ kind: action });
            }}
          >
            {action === "trash" ? t`Move to Trash` : t`Archive`}
          </button>
        ))}
      </Alert>
      <Toast toast={toast} onDone={hideToast} />
    </div>
  );
}

import { shortcutAction } from "../../shared/shortcuts";
import { Settings } from "./components/Settings";
import { ShortcutHelp } from "./components/SystemSettings";
import { AddAccountDialog } from "./components/AddAccountDialog";
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
import { ThreadActions, type ThreadState } from "./components/ThreadActions";
import { Toast, type ToastState } from "./components/Toast";
import { causeText } from "./errors";
import { MailClient } from "./rpc";
import { liveUpdatesAtom } from "./state/events";
import { modifyMessages, modifyThreads, useRunMail, withMail } from "./state/mail";
import { accountsAtom, labelsAtom, prefsAtom, threadAtom } from "./state/queries";

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
  const { t, i18n } = useLingui();
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
  const [labelPicker, setLabelPicker] = useState(false);
  const [pickerMode, setPickerMode] = useState<"label" | "move">("label");
  const [dialog, setDialog] = useState<"settings" | "help" | "add" | null>(null);
  const subject = messages?.at(-1)?.subject;

  useEffect(() => {
    document.title = subject || "OpenMail";
  }, [subject]);

  const state: ThreadState | null =
    account && messages
      ? {
          provider: account.provider,
          isUnread: messages.some((m) => m.isUnread),
          isStarred: messages.some((m) => m.isStarred),
          isImportant: messages.some((m) => m.labels.includes("IMPORTANT")),
          labels: [...new Set(messages.flatMap((m) => m.labels))],
        }
      : null;

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

  const act = (op: MailOp) => {
    if (op.kind === "read" && !op.value) setMarked(true);
    return run(
      (single
        ? modifyMessages([id], op).pipe(Effect.asVoid)
        : modifyThreads([id], op).pipe(Effect.asVoid)
      ).pipe(
        Effect.matchCause({
          onFailure: (cause) => {
            const reason = causeText(i18n, cause);
            say({ text: t`Action failed: ${reason}`, tone: "error" });
          },
          onSuccess: () => {
            if (LEAVES.has(op.kind)) window.close();
          },
        }),
      ),
    );
  };
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (
      dialog ||
      e.defaultPrevented ||
      (e.target instanceof Element &&
        e.target.closest('[role="menu"],[role="dialog"],input,textarea,[contenteditable="true"]'))
    )
      return;
    const action = shortcutAction(prefs.shortcutSet, e);
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
      case "trash":
        e.preventDefault();
        act({ kind: "trash" });
        break;
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

  return (
    <div className="flex h-full flex-col bg-white text-[13px] text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
      {/* Room on the left for the traffic lights. */}
      <header className="drag flex h-13 shrink-0 items-center pr-4 pl-20">
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
          onMarkUnread={() => setMarked(true)}
          onActionDone={({ result, ids }) => showUndo(result, ids, t`Message updated`)}
          single={single || !prefs.threadGrouping}
          notify={(next) => say(next)}
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-neutral-300 dark:text-neutral-600">
          <Mail className="size-10 stroke-1" />
          {AsyncResult.isFailure(thread) && (
            <p className="text-neutral-400">{causeText(i18n, thread.cause)}</p>
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
      <Toast toast={toast} onDone={hideToast} />
    </div>
  );
}

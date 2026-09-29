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
import { ThreadActions, type ThreadState } from "./components/ThreadActions";
import { Toast, type ToastState } from "./components/Toast";
import { causeText } from "./errors";
import { MailClient } from "./rpc";
import { liveUpdatesAtom } from "./state/events";
import { modifyThreads, useRunMail } from "./state/mail";
import { accountsAtom, labelsAtom, prefsAtom, threadAtom } from "./state/queries";

/** Ops after which the thread has left where it was; the window closes, as in Mail. */
const LEAVES = new Set<MailOp["kind"]>(["archive", "trash", "spam"]);

/**
 * A window with one thread, opened from the list (double-click, context menu)
 * or the reader toolbar. Same renderer and preload as the main window; it
 * shows only the reader, with the thread's actions but no compose.
 */
export function ThreadWindow({ id }: { id: string }) {
  useAtomMount(MailClient.runtime);
  useAtomMount(liveUpdatesAtom);
  const run = useRunMail();
  const { t, i18n } = useLingui();
  const [toast, setToast] = useState<ToastState | null>(null);
  const hideToast = useCallback(() => setToast(null), []);
  const say = (next: Omit<ToastState, "id">) => setToast({ ...next, id: Date.now() });
  const print = useThreadPrint((next) => say(next));

  const thread = useAtomValue(threadAtom(id));
  const messages = AsyncResult.isSuccess(thread) ? thread.value : undefined;
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  const accounts = AsyncResult.getOrElse(useAtomValue(accountsAtom), () => []);
  const account = accounts.find((a) => a.id === messages?.[0]?.accountId);
  const labels = AsyncResult.getOrElse(useAtomValue(labelsAtom()), () => []).filter(
    (l) => l.accountId === account?.id,
  );
  const [labelPicker, setLabelPicker] = useState(false);
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
    run(modifyThreads([id], { kind: "read", value: true }));
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

  const act = (op: MailOp) =>
    run(
      modifyThreads([id], op).pipe(
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

  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "p") {
      e.preventDefault();
      print(id, false, prefs.threadGrouping ? undefined : id);
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
          messages={messages}
          selectedId={id}
          single={!prefs.threadGrouping}
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
      <Toast toast={toast} onDone={hideToast} />
    </div>
  );
}

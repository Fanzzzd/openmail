import { useAtom, useAtomMount, useAtomValue } from "@effect/atom-react";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { applySignature, DEFAULT_PREFS, holdSend, markReadAfter } from "@openmail/core/schema";
import { Effect, Fiber } from "effect";
import { constVoid } from "effect/Function";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { Group, Panel, useDefaultLayout } from "react-resizable-panels";

import type {
  Account,
  MailOp,
  OutgoingMessage,
  Profile,
  Proposal,
  ThreadSummary,
} from "../../shared/api";
import { AddAccountDialog } from "./components/AddAccountDialog";
import { Composer } from "./components/Composer";
import { MessageList, type SelectionSource } from "./components/MessageList";
import { Overview } from "./components/Overview";
import { ProfileEditor } from "./components/ProfileEditor";
import { Proposals } from "./components/Proposals";
import { Reader, useThreadPrint } from "./components/Reader";
import { ResizeHandle } from "./components/ResizeHandle";
import { Settings } from "./components/Settings";
import { Sidebar } from "./components/Sidebar";
import { ThreadActions, type ThreadState } from "./components/ThreadActions";
import { Toast, type ToastState } from "./components/Toast";
import {
  type ComposeMode,
  type Draft,
  draftFor,
  emptyDraft,
  fromStored,
  isEmpty,
  toDraftInput,
} from "./draft";
import { causeText } from "./errors";
import { MailClient } from "./rpc";
import { liveUpdatesAtom, syncProgressAtom, syncStateAtom } from "./state/events";
import {
  discardDraft,
  modifyThreads,
  openDraft,
  openThreadWindow,
  reauthAccount,
  saveDraft,
  sendMessage,
  syncNow,
  useRunMail,
} from "./state/mail";
import {
  accountsAtom,
  labelsAtom,
  prefsAtom,
  profilesAtom,
  proposalsAtom,
  signaturesAtom,
  threadAtom,
  unreadCountsAtom,
} from "./state/queries";
import { threadListAtom } from "./state/threads";
import {
  filtersAtom,
  NO_FILTERS,
  rememberedViewsAtom,
  searchAtom,
  searchTextAtom,
  viewAtom,
} from "./state/ui";
import {
  ALL,
  CATEGORY_NAMES,
  MAILBOX_NAMES,
  OVERVIEW,
  scopeAccountIds,
  type SpaceId,
  type View,
} from "./view";

import { GoToFolder } from "./components/GoToFolder";
import { SnoozeDialog } from "./components/SnoozeDialog";
import { FilterEditor } from "./components/ServerSettings";

type Dialog = "add" | "settings" | "proposals" | null;

const OP_DONE: Record<MailOp["kind"], (op: MailOp) => MessageDescriptor> = {
  read: (op) => (op.kind === "read" && op.value ? msg`Marked as read` : msg`Marked as unread`),
  star: (op) => (op.kind === "star" && op.value ? msg`Added star` : msg`Removed star`),
  important: (op) =>
    op.kind === "important" && op.value ? msg`Marked as important` : msg`Marked as not important`,
  archive: () => msg`Archived`,
  inbox: () => msg`Moved to Inbox`,
  trash: () => msg`Deleted`,
  spam: () => msg`Reported as spam`,
  label: (op) => (op.kind === "label" && op.value ? msg`Label added` : msg`Label removed`),
};

/** Ops that take the thread out of the list it is in. */
const MOVES = new Set<MailOp["kind"]>(["archive", "inbox", "trash", "spam"]);

/** The op that puts a thread back, given its state before `op`. */
function inverse(op: MailOp, before: ThreadState): MailOp | null {
  switch (op.kind) {
    case "read":
    case "star":
    case "important":
      return { ...op, value: !op.value };
    case "label":
      if (before.provider === "gmail" || !op.value) return { ...op, value: !op.value };
      break;
  }
  if (before.provider === "gmail") {
    if (op.kind === "archive" || op.kind === "trash" || op.kind === "spam") {
      return before.labels.includes("INBOX") ? { kind: "inbox" } : null;
    }
    if (op.kind === "inbox") {
      if (before.labels.includes("TRASH")) return { kind: "trash" };
      if (before.labels.includes("SPAM")) return { kind: "spam" };
      return { kind: "archive" };
    }
    return null;
  }
  // Folder providers: move back to the folder the thread was in.
  const folder = before.labels.find((l) => !["UNREAD", "STARRED", "IMPORTANT"].includes(l));
  switch (folder) {
    case "INBOX":
      return { kind: "inbox" };
    case "ARCHIVE":
      return { kind: "archive" };
    case "TRASH":
      return { kind: "trash" };
    case "SPAM":
      return { kind: "spam" };
    case undefined:
      return null;
    default:
      return { kind: "label", labelId: folder, value: true };
  }
}

export function App() {
  // The one subscription to the main process's events, and the RPC runtime,
  // live as long as the window.
  useAtomMount(MailClient.runtime);
  useAtomMount(liveUpdatesAtom);
  const run = useRunMail();
  const { t, i18n } = useLingui();

  const [view, setView] = useAtom(viewAtom);
  const remembered = useAtomValue(rememberedViewsAtom);
  const [query, setQuery] = useAtom(searchTextAtom);
  const search = useAtomValue(searchAtom);
  const [filters, setFilters] = useAtom(filtersAtom);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectionSource, setSelectionSource] = useState<SelectionSource>("mouse");
  const [editing, setEditing] = useState<Profile | "new" | null>(null);
  const syncState = useAtomValue(syncStateAtom);
  const progress = useAtomValue(syncProgressAtom);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [compose, setCompose] = useState<Draft | null>(null);
  const [labelPicker, setLabelPicker] = useState(false);
  const [goToFolder, setGoToFolder] = useState(false);
  const [snoozeIds, setSnoozeIds] = useState<readonly string[] | null>(null);
  const [filterSeed, setFilterSeed] = useState<{ accountId: string; from: string } | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const undoRef = useRef<(() => void) | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const hideToast = useCallback(() => setToast(null), []);
  const say = (next: Omit<ToastState, "id">) => setToast({ ...next, id: Date.now() });

  const accounts = useAtomValue(accountsAtom);
  const accountList = AsyncResult.getOrElse(accounts, () => []);
  const profileList = AsyncResult.getOrElse(useAtomValue(profilesAtom), () => []);
  const counts = AsyncResult.getOrElse(useAtomValue(unreadCountsAtom), () => ({}));
  const scope = scopeAccountIds(view, accountList);
  const filterAccount = filterSeed
    ? accountList.find((a) => a.id === filterSeed.accountId)
    : undefined;

  const labels = AsyncResult.getOrElse(useAtomValue(labelsAtom()), () => []);
  const labelMap = new Map(labels.map((l) => [`${l.accountId}/${l.id}`, l]));

  const [threads, loadMore] = useAtom(threadListAtom);
  const list = threads.threads;
  const selected = list.find((thread) => thread.id === selectedId);
  const openThread = AsyncResult.value(useAtomValue(threadAtom(selectedId)));
  const messages = openThread._tag === "Some" ? openThread.value : undefined;
  const proposals = AsyncResult.getOrElse(useAtomValue(proposalsAtom), () => []);
  const signatures = AsyncResult.getOrElse(useAtomValue(signaturesAtom), () => []);
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  const undoSeconds = prefs.undoSendSeconds;
  /** The unread thread just opened with select(); it is marked read after the delay in preferences. */
  const [readTarget, setReadTarget] = useState<string | null>(null);
  const print = useThreadPrint((next) => say(next));

  /** The local signature for an account: one for new messages, one for replies and forwards. */
  const signatureFor = (accountId: string, mode: ComposeMode, from?: string) => {
    const address = (from ?? accountList.find((a) => a.id === accountId)?.email)?.toLowerCase();
    const kind = mode === "new" ? "new" : "reply";
    return signatures.find((s) => s.address === address && s.kind === kind)?.text;
  };
  const signed = (d: Draft): Draft => ({
    ...d,
    body: applySignature(d.body, undefined, signatureFor(d.accountId, d.mode)),
  });

  const selectedAccount = accountList.find(
    (a) => a.id === (selected?.accountId ?? messages?.[0]?.accountId),
  );
  const threadState: ThreadState | null =
    selectedAccount && messages
      ? {
          provider: selectedAccount.provider,
          isUnread: messages.some((m) => m.isUnread),
          isStarred: messages.some((m) => m.isStarred),
          isImportant: messages.some((m) => m.labels.includes("IMPORTANT")),
          labels: [...new Set(messages.flatMap((m) => m.labels))],
        }
      : null;
  const threadLabels = labels.filter((l) => l.accountId === selectedAccount?.id);

  /** A list row's state, for its context menu; the list already has what the menu needs. */
  const rowState = (m: ThreadSummary): ThreadState | null => {
    const account = accountList.find((a) => a.id === m.accountId);
    if (!account) return null;
    return {
      provider: account.provider,
      isUnread: m.isUnread,
      isStarred: m.isStarred,
      isImportant: m.labels.includes("IMPORTANT"),
      labels: [...m.labels],
    };
  };

  /**
   * Runs an op on the selected thread, or on `target` (a row's context menu).
   * Moving the selected thread selects the next one, the way Mimestream does;
   * every visible op can be undone with ⌘Z.
   */
  const act = (
    op: MailOp,
    opts: { quiet?: boolean } = {},
    target?: { id: string; state: ThreadState },
  ) => {
    const id = target?.id ?? selectedId;
    const state = target?.state ?? threadState;
    if (!id || !state) return;
    const back = inverse(op, state);
    const leaves = MOVES.has(op.kind) || (op.kind === "label" && state.provider !== "gmail");
    const wasSelected = id === selectedId;
    if (leaves && wasSelected) {
      const index = list.findIndex((thread) => thread.id === id);
      const next = list[index + 1] ?? list[index - 1];
      select(next?.id ?? null, selectionSource);
    }
    run(
      modifyThreads([id], op).pipe(
        Effect.matchCause({
          onFailure: (cause) => {
            const reason = causeText(i18n, cause);
            say({ text: t`Action failed: ${reason}`, tone: "error" });
          },
          onSuccess: (outcome) => {
            // The change applied locally even when the push waits for a new
            // sign-in, so it can still be undone.
            const needsReauth = outcome.status === "applied" && outcome.flush?.reauth.length;
            if (opts.quiet && !needsReauth) return;
            const undo =
              back && !opts.quiet
                ? () => {
                    run(modifyThreads([id], back));
                    if (leaves && wasSelected) setSelectedId(id);
                  }
                : null;
            undoRef.current = undo;
            const action = undo ? { action: { label: t`Undo`, run: undo } } : {};
            say(
              needsReauth
                ? {
                    text: t`The account's sign-in has expired. Changes will sync after you sign in again.`,
                    tone: "error",
                    ...action,
                  }
                : { text: i18n._(OP_DONE[op.kind](op)), ...action },
            );
          },
        }),
      ),
    );
  };

  /**
   * Selects a thread. Opening an unread thread marks it read right away, after
   * a few seconds, or never, as set in Settings > Reading.
   */
  const select = (id: string | null, source: SelectionSource) => {
    setSelectedId(id);
    setLabelPicker(false);
    setSelectionSource(source);
    setReadTarget(id && list.find((thread) => thread.id === id)?.isUnread ? id : null);
  };

  const markRead = useEffectEvent((id: string) => {
    run(modifyThreads([id], { kind: "read", value: true }));
  });
  // Moving to another thread before the delay passes leaves this one unread.
  useEffect(
    () =>
      readTarget && readTarget === selectedId
        ? markReadAfter(prefs.markReadDelay, () => markRead(readTarget))
        : constVoid,
    [readTarget, selectedId, prefs.markReadDelay],
  );

  const openWindow = (id: string) => run(openThreadWindow(id));

  const defaultAccount = (): Account | undefined =>
    accountList.find((a) => a.id === (view.accountId ?? scope?.[0])) ?? accountList[0];

  const startCompose = (mode: Draft["mode"], asAttachment = false, id = selectedId) => {
    if (mode === "new") {
      const account = defaultAccount();
      if (account) setCompose(signed(emptyDraft(account.id)));
      return;
    }
    if (!id) return;
    // The reader usually has the thread loaded already; this waits for it if not.
    run(
      Atom.getResult(threadAtom(id)).pipe(
        Effect.tap((thread) =>
          Effect.sync(() => {
            const last = thread.at(-1);
            const account = accountList.find((a) => a.id === last?.accountId);
            if (last && account) setCompose(signed(draftFor(mode, last, account, asAttachment)));
          }),
        ),
      ),
    );
  };

  /** Opens a saved draft: a local draft id, a draft message, or "proposal:<id>". */
  const openSavedDraft = (id: string) =>
    run(
      openDraft(id).pipe(
        Effect.matchCause({
          onSuccess: (d) => setCompose(fromStored(d)),
          onFailure: (cause) => {
            const reason = causeText(i18n, cause);
            say({ text: t`Can't open the draft: ${reason}`, tone: "error" });
          },
        }),
      ),
    );

  const openProposal = (p: Proposal) => {
    if (p.command.kind !== "send" && p.command.kind !== "draft") return;
    setDialog(null);
    openSavedDraft(`proposal:${p.id}`);
  };

  /** Closing keeps the draft; an untouched or empty one is not saved. */
  const closeCompose = (draft: Draft, changed: boolean) => {
    setCompose(null);
    if (changed && !isEmpty(draft)) run(saveDraft(toDraftInput(draft)));
  };

  const discard = (draft: Draft) => {
    setCompose(null);
    run(
      discardDraft(draft.id).pipe(
        Effect.matchCause({
          onSuccess: () => say({ text: t`Draft discarded` }),
          onFailure: (cause) => {
            const reason = causeText(i18n, cause);
            say({ text: t`Couldn't discard: ${reason}`, tone: "error" });
          },
        }),
      ),
    );
  };

  /**
   * Saves the draft (so quitting during the wait loses nothing), holds the
   * message for the undo window from preferences, then sends it. The window
   * is a timer (`holdSend`) that undo clears, so a message taken back never
   * reaches the main process. Undo, from the toast or ⌘Z, reopens the draft.
   */
  const send = (draft: Draft, message: OutgoingMessage, options: { archive: boolean }) => {
    setCompose(null);
    const reopen = () => setCompose(draft);
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
          Effect.matchCause({
            onSuccess: () => {
              say({ text: options.archive ? t`Sent and archived` : t`Sent` });
              // The archived thread leaves the list; move on as E does.
              if (options.archive && selectedId === draft.inReplyTo) {
                const index = list.findIndex((thread) => thread.id === selectedId);
                const next = list[index + 1] ?? list[index - 1];
                setSelectedId(next?.id ?? null);
              }
            },
            onFailure: (cause) => {
              const reason = causeText(i18n, cause);
              say({ text: t`Couldn't send: ${reason}`, tone: "error" });
              reopen();
            },
          }),
        ),
      );
    const delay = undoSeconds * 1000;
    if (delay === 0) {
      say({ text: t`Sending…` });
      deliver();
      return;
    }
    const held = holdSend(delay, () => {
      if (undoRef.current === undo) undoRef.current = null;
      deliver();
    });
    const undo = () => {
      if (held.undo()) reopen();
    };
    undoRef.current = undo;
    say({ text: t`Sending…`, duration: delay, action: { label: t`Undo`, run: undo } });
  };

  const reauth = (account: Account) => {
    if (account.provider === "imap") {
      setDialog("add");
      return;
    }
    say({ text: t`Finish signing in in your browser`, duration: 60_000 });
    run(
      reauthAccount(account.id).pipe(
        Effect.matchCause({
          onSuccess: () => {
            const email = account.email;
            say({ text: t`${email} is signed in again` });
          },
          onFailure: (cause) => {
            const reason = causeText(i18n, cause);
            say({ text: t`Sign-in failed: ${reason}`, tone: "error" });
          },
        }),
      ),
    );
  };

  const changeView = (next: View) => {
    setView(next);
    setSelectedId(null);
  };

  const switchSpace = (space: SpaceId, messageId?: string) => {
    const next = messageId
      ? { space, mailbox: "inbox" as const }
      : (remembered.get(space) ?? { space, mailbox: "inbox" as const });
    changeView(next);
    setQuery("");
    if (messageId) {
      setFilters(NO_FILTERS);
      setSelectedId(messageId);
      setSelectionSource("mouse");
    }
  };

  const onKey = useEffectEvent((e: KeyboardEvent) => {
    // Dialogs and the compose window handle their own keys, and so do open
    // menus and pickers (typeahead must not archive the selected thread).
    if (dialog || compose || editing || goToFolder || snoozeIds || filterSeed || e.defaultPrevented)
      return;
    if (e.target instanceof Element && e.target.closest('[role="menu"],[role="dialog"]')) return;
    const typing =
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement ||
      e.target instanceof HTMLSelectElement;
    const cmd = e.metaKey || e.ctrlKey;
    if (cmd && e.key === "n") {
      e.preventDefault();
      startCompose("new");
      return;
    }
    if (cmd && e.key === ",") {
      e.preventDefault();
      setDialog("settings");
      return;
    }
    if (cmd && !e.shiftKey && e.key === "z" && !typing) {
      e.preventDefault();
      undoRef.current?.();
      undoRef.current = null;
      setToast(null);
      return;
    }
    if (cmd && e.shiftKey && e.key.toLowerCase() === "u") {
      e.preventDefault();
      if (threadState) act({ kind: "read", value: threadState.isUnread });
      return;
    }
    if (cmd && e.shiftKey && e.key.toLowerCase() === "o") {
      e.preventDefault();
      if (selectedId && view.mailbox !== "drafts") openWindow(selectedId);
      return;
    }
    if (cmd && !e.shiftKey && e.key === "p") {
      e.preventDefault();
      if (selectedId && threadState) {
        print(selectedId, false, prefs.threadGrouping ? undefined : selectedId);
      }
      return;
    }
    if (cmd && e.shiftKey && e.key.toLowerCase() === "g") {
      e.preventDefault();
      setGoToFolder(true);
      return;
    }
    if (cmd && e.shiftKey && e.key.toLowerCase() === "i") {
      e.preventDefault();
      act({ kind: "inbox" });
      return;
    }
    if (e.key === "Escape") {
      setQuery("");
      searchRef.current?.blur();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "f") {
      e.preventDefault();
      searchRef.current?.focus();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "r") {
      e.preventDefault();
      run(syncNow);
      return;
    }
    // ⌃1 overview, ⌃2 all accounts, ⌃3… profiles in switcher order.
    if (e.ctrlKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
      e.preventDefault();
      const n = Number(e.key);
      const space = n === 1 ? OVERVIEW : n === 2 ? ALL : profileList[n - 3]?.id;
      if (space) switchSpace(space);
      return;
    }
    if (e.metaKey && e.altKey && e.code === "KeyL") {
      e.preventDefault();
      setFilters((f) => ({ ...f, unread: !f.unread }));
      return;
    }
    if (typing || view.space === OVERVIEW) return;
    if (e.key === "/") {
      e.preventDefault();
      searchRef.current?.focus();
      return;
    }
    if (e.key === "c" && !cmd) {
      e.preventDefault();
      startCompose("new");
      return;
    }
    if (threadState && !cmd && !e.altKey) {
      const single: Record<string, () => void> = {
        e: () => act({ kind: "archive" }),
        "#": () => act({ kind: "trash" }),
        Backspace: () => act({ kind: "trash" }),
        "!": () => act({ kind: "spam" }),
        s: () => act({ kind: "star", value: !threadState.isStarred }),
        u: () => act({ kind: "read", value: threadState.isUnread }),
        "=": () => {
          if (threadState.provider === "gmail") {
            act({ kind: "important", value: !threadState.isImportant });
          }
        },
        r: () => startCompose("reply"),
        a: () => startCompose("replyAll"),
        f: () => startCompose("forward"),
        F: () => startCompose("forward", true),
        // L labels on Gmail, V moves to a folder elsewhere.
        [threadState.provider === "gmail" ? "l" : "v"]: () => {
          if (threadLabels.length) setLabelPicker(true);
        },
      };
      const handler = single[e.key];
      if (handler) {
        e.preventDefault();
        handler();
        return;
      }
    }
    if (e.key === "j" || e.key === "ArrowDown" || e.key === "k" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "j" || e.key === "ArrowDown" ? 1 : -1;
      const index = list.findIndex((m) => m.id === selectedId);
      const next = list[Math.max(0, Math.min(list.length - 1, index + step))];
      if (next) {
        select(next.id, "keyboard");
      }
    }
  });

  useEffect(() => {
    const listener = (e: KeyboardEvent) => onKey(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const hasAccounts = accountList.length > 0;
  const viewAccount = accountList.find((a) => a.id === (view.label?.accountId ?? view.accountId));
  const category = view.label ? CATEGORY_NAMES[view.label.id] : undefined;
  const baseTitle = view.label
    ? category
      ? i18n._(category)
      : (labelMap.get(`${view.label.accountId}/${view.label.id}`)?.name ?? t`Label`)
    : i18n._(MAILBOX_NAMES[view.mailbox]);
  const user = viewAccount?.email.split("@")[0];
  const title = viewAccount ? t`${baseTitle}: ${user}` : baseTitle;

  // Pane widths persist per layout: mail has three panes, the overview and
  // the empty state two.
  const paneMode = !hasAccounts ? "empty" : view.space === OVERVIEW ? "overview" : "mail";
  const panes = useDefaultLayout({
    id: `openmail:panes:${paneMode}`,
    panelIds: paneMode === "mail" ? ["sidebar", "list", "reader"] : ["sidebar", "main"],
    storage: localStorage,
  });

  return (
    <div className="h-full text-[13px] text-neutral-900 dark:text-neutral-100">
      <Group
        key={paneMode}
        orientation="horizontal"
        className="h-full"
        defaultLayout={panes.defaultLayout}
        onLayoutChanged={panes.onLayoutChanged}
        resizeTargetMinimumSize={{ fine: 9, coarse: 24 }}
      >
        <Panel
          id="sidebar"
          defaultSize={232}
          minSize={190}
          maxSize={380}
          groupResizeBehavior="preserve-pixel-size"
        >
          <Sidebar
            view={view}
            // The overview has no list; picking a mailbox there opens it in All.
            onView={(v) => changeView(v.space === OVERVIEW ? { ...v, space: ALL } : v)}
            onSpace={switchSpace}
            onEditProfile={setEditing}
            accounts={accountList}
            profiles={profileList}
            unread={counts}
            syncState={syncState}
            progress={progress}
            proposals={proposals.length}
            onAddAccount={() => setDialog("add")}
            onCompose={() => startCompose("new")}
            onReauth={reauth}
            onProposals={() => setDialog("proposals")}
            onSettings={() => setDialog("settings")}
          />
        </Panel>
        <ResizeHandle />
        {!hasAccounts ? (
          <Panel id="main" minSize={360}>
            <main className="h-full bg-white dark:bg-neutral-900">
              <div className="drag h-13" />
            </main>
          </Panel>
        ) : view.space === OVERVIEW ? (
          <Panel id="main" minSize={360}>
            <Overview
              accounts={accountList}
              profiles={profileList}
              unread={counts}
              syncState={syncState}
              onOpen={switchSpace}
              onEditProfile={setEditing}
            />
          </Panel>
        ) : (
          <>
            <Panel
              id="list"
              defaultSize={380}
              minSize={280}
              maxSize={720}
              groupResizeBehavior="preserve-pixel-size"
            >
              <MessageList
                title={title}
                threads={list}
                loading={threads.loading}
                showAccount={!viewAccount && (scope?.length ?? accountList.length) > 1}
                searching={search !== ""}
                searchingServer={threads.searchingServer}
                searchTruncated={threads.searchTruncated}
                searchErrors={threads.searchErrors}
                filters={filters}
                onFilters={setFilters}
                labels={labelMap}
                selectedId={selectedId}
                selectionSource={selectionSource}
                rowActions={{
                  mailbox: view.mailbox,
                  labels,
                  stateOf: rowState,
                  onOp: (m, state, op) => act(op, {}, { id: m.id, state }),
                  onCompose: (m, mode, asAttachment) => startCompose(mode, asAttachment, m.id),
                  onSnooze: (thread) => setSnoozeIds([thread.id]),
                  onFilter: (thread) =>
                    setFilterSeed({ accountId: thread.accountId, from: thread.from.address }),
                  onOpenWindow: (m) =>
                    view.mailbox === "drafts" ? openSavedDraft(m.id) : openWindow(m.id),
                }}
                onSelect={(id) => {
                  if (view.mailbox !== "drafts") {
                    select(id, "mouse");
                    return;
                  }
                  // Drafts open in the compose window.
                  setSelectedId(id);
                  openSavedDraft(id);
                }}
                onEndReached={() => {
                  if (threads.canLoadMore) loadMore();
                }}
              />
            </Panel>
            <ResizeHandle />
            <Panel id="reader" minSize={360}>
              <Reader
                messageId={selectedId}
                derivedMatches={selected?.derivedMatches}
                query={query}
                onQuery={setQuery}
                searchRef={searchRef}
                onEditDraft={openSavedDraft}
                notify={(next) => say(next)}
                toolbar={
                  threadState && (
                    <ThreadActions
                      state={threadState}
                      mailbox={view.mailbox}
                      labels={threadLabels}
                      onOp={(op) => act(op)}
                      onCompose={startCompose}
                      onSnooze={() => {
                        if (selectedId) setSnoozeIds([selectedId]);
                      }}
                      onFilter={
                        selectedAccount?.provider === "imap"
                          ? undefined
                          : () => {
                              if (selectedAccount && selected)
                                setFilterSeed({
                                  accountId: selectedAccount.id,
                                  from: selected.from.address,
                                });
                            }
                      }
                      onOpenWindow={() => {
                        if (selectedId) openWindow(selectedId);
                      }}
                      labelPicker={labelPicker}
                      onLabelPicker={setLabelPicker}
                    />
                  )
                }
              />
            </Panel>
          </>
        )}
      </Group>
      {editing && (
        <ProfileEditor
          profile={editing === "new" ? undefined : editing}
          accounts={accountList}
          profiles={profileList}
          onClose={() => setEditing(null)}
          onSaved={(p) => {
            if (editing === "new") switchSpace(p.id);
          }}
          onDeleted={() => {
            if (editing !== "new" && view.space === editing.id) switchSpace(ALL);
          }}
        />
      )}
      {(dialog === "add" || (!hasAccounts && accounts._tag !== "Initial")) && (
        <AddAccountDialog
          {...(hasAccounts ? { onClose: () => setDialog(null) } : {})}
          onAdded={(a) => {
            setDialog(null);
            const email = a.email;
            say({ text: t`Added ${email}. Syncing…` });
          }}
        />
      )}
      {goToFolder && (
        <GoToFolder
          labels={labels}
          accounts={accountList}
          view={view}
          onView={changeView}
          onClose={() => setGoToFolder(false)}
        />
      )}
      {snoozeIds && (
        <SnoozeDialog
          threads={snoozeIds}
          onClose={() => setSnoozeIds(null)}
          onSnoozed={() => {
            setSnoozeIds(null);
            setSelectedId(null);
          }}
        />
      )}
      {filterSeed && filterAccount && (
        <FilterEditor
          account={filterAccount}
          from={filterSeed.from}
          onClose={() => setFilterSeed(null)}
        />
      )}
      {dialog === "settings" && (
        <Settings
          accounts={accountList}
          onClose={() => setDialog(null)}
          onAddAccount={() => setDialog("add")}
        />
      )}
      {dialog === "proposals" && (
        <Proposals
          proposals={proposals}
          accounts={accountList}
          onClose={() => setDialog(null)}
          onOpenDraft={openProposal}
        />
      )}
      {compose && (
        <Composer
          key={compose.id}
          draft={compose}
          accounts={accountList}
          signatureFor={signatureFor}
          onClose={closeCompose}
          onDiscard={discard}
          onSend={send}
        />
      )}
      <Toast toast={toast} onDone={hideToast} />
    </div>
  );
}

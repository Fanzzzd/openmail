import { useAtom, useAtomMount, useAtomValue } from "@effect/atom-react";
import { Cause, Effect } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";

import type { Account, MailOp, OutgoingMessage, Profile, Proposal } from "../../shared/api";
import { AddAccountDialog } from "./components/AddAccountDialog";
import { Composer } from "./components/Composer";
import { MessageList, type SelectionSource } from "./components/MessageList";
import { Overview } from "./components/Overview";
import { ProfileEditor } from "./components/ProfileEditor";
import { Proposals } from "./components/Proposals";
import { Reader } from "./components/Reader";
import { Settings } from "./components/Settings";
import { Sidebar } from "./components/Sidebar";
import { ThreadActions, type ThreadState } from "./components/ThreadActions";
import { Toast, type ToastState } from "./components/Toast";
import { type Draft, draftFor, emptyDraft, formatAddress } from "./draft";
import { causeText } from "./errors";
import { MailClient } from "./rpc";
import { liveUpdatesAtom, syncProgressAtom, syncStateAtom } from "./state/events";
import {
  decideProposal,
  modifyThreads,
  reauthAccount,
  sendMessage,
  syncNow,
  useRunMail,
} from "./state/mail";
import {
  accountsAtom,
  labelsAtom,
  profilesAtom,
  proposalsAtom,
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

/** How long a sent message waits so the person can take it back. */
const UNDO_SEND_MS = 5000;

type Dialog = "add" | "settings" | "proposals" | null;

const OP_DONE: Record<MailOp["kind"], (op: MailOp) => string> = {
  read: (op) => (op.kind === "read" && op.value ? "已标为已读" : "已标为未读"),
  star: (op) => (op.kind === "star" && op.value ? "已加星标" : "已去掉星标"),
  important: (op) => (op.kind === "important" && op.value ? "已标为重要" : "已取消重要"),
  archive: () => "已归档",
  inbox: () => "已移回收件箱",
  trash: () => "已删除",
  spam: () => "已报告为垃圾邮件",
  label: (op) => (op.kind === "label" && op.value ? "已加标签" : "已去掉标签"),
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
  const [compose, setCompose] = useState<{ draft: Draft; proposalId?: number } | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const undoRef = useRef<(() => void) | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const hideToast = useCallback(() => setToast(null), []);
  const say = (t: Omit<ToastState, "id">) => setToast({ ...t, id: Date.now() });

  const accounts = useAtomValue(accountsAtom);
  const accountList = AsyncResult.getOrElse(accounts, () => []);
  const profileList = AsyncResult.getOrElse(useAtomValue(profilesAtom), () => []);
  const counts = AsyncResult.getOrElse(useAtomValue(unreadCountsAtom), () => ({}));
  const scope = scopeAccountIds(view, accountList);

  const labels = AsyncResult.getOrElse(useAtomValue(labelsAtom()), () => []);
  const labelMap = new Map(labels.map((l) => [`${l.accountId}/${l.id}`, l]));

  const [threads, loadMore] = useAtom(threadListAtom);
  const list = threads.threads;
  const selected = list.find((t) => t.id === selectedId);
  const openThread = AsyncResult.value(useAtomValue(threadAtom(selectedId)));
  const messages = openThread._tag === "Some" ? openThread.value : undefined;
  const proposals = AsyncResult.getOrElse(useAtomValue(proposalsAtom), () => []);

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

  /**
   * Runs an op on the selected thread. Moves select the next thread, the way
   * Mimestream does; every visible op can be undone with ⌘Z.
   */
  const act = (op: MailOp, opts: { quiet?: boolean } = {}) => {
    if (!selectedId || !threadState) return;
    const id = selectedId;
    const back = inverse(op, threadState);
    const leaves = MOVES.has(op.kind) || (op.kind === "label" && threadState.provider !== "gmail");
    if (leaves) {
      const index = list.findIndex((t) => t.id === id);
      const next = list[index + 1] ?? list[index - 1];
      select(next?.id ?? null, selectionSource);
    }
    run(
      modifyThreads([id], op).pipe(
        Effect.matchCause({
          onFailure: (cause) => say({ text: `操作失败：${causeText(cause)}`, tone: "error" }),
          onSuccess: (outcome) => {
            // The change applied locally even when the push waits for a new
            // sign-in, so it can still be undone.
            const needsReauth = outcome.status === "applied" && outcome.flush?.reauth.length;
            if (opts.quiet && !needsReauth) return;
            const undo =
              back && !opts.quiet
                ? () => {
                    run(modifyThreads([id], back));
                    if (leaves) setSelectedId(id);
                  }
                : null;
            undoRef.current = undo;
            const action = undo ? { action: { label: "撤销", run: undo } } : {};
            say(
              needsReauth
                ? { text: "账户登录已失效，改动会在重新登录后同步", tone: "error", ...action }
                : { text: OP_DONE[op.kind](op), ...action },
            );
          },
        }),
      ),
    );
  };

  /** Selects a thread. Opening an unread thread marks it read, as Mimestream does by default. */
  const select = (id: string | null, source: SelectionSource) => {
    setSelectedId(id);
    setSelectionSource(source);
    if (id && list.find((t) => t.id === id)?.isUnread) {
      run(modifyThreads([id], { kind: "read", value: true }));
    }
  };

  const defaultAccount = (): Account | undefined =>
    accountList.find((a) => a.id === (view.accountId ?? scope?.[0])) ?? accountList[0];

  const startCompose = (mode: Draft["mode"]) => {
    if (mode === "new") {
      const account = defaultAccount();
      if (account) setCompose({ draft: emptyDraft(account.id) });
      return;
    }
    if (!selectedId) return;
    // The reader usually has the thread loaded already; this waits for it if not.
    run(
      Atom.getResult(threadAtom(selectedId)).pipe(
        Effect.tap((thread) =>
          Effect.sync(() => {
            const last = thread.at(-1);
            const account = accountList.find((a) => a.id === last?.accountId);
            if (last && account) setCompose({ draft: draftFor(mode, last, account) });
          }),
        ),
      ),
    );
  };

  const openProposal = (p: Proposal) => {
    if (p.command.kind !== "send" && p.command.kind !== "draft") return;
    const m = p.command.message;
    setDialog(null);
    setCompose({
      proposalId: p.id,
      draft: {
        mode: m.mode ?? "new",
        accountId: p.command.accountId,
        to: m.to.map(formatAddress).join(", "),
        cc: m.cc.map(formatAddress).join(", "),
        bcc: m.bcc.map(formatAddress).join(", "),
        subject: m.subject,
        body: m.text,
        attachments: m.attachments,
        ...(m.inReplyTo ? { inReplyTo: m.inReplyTo } : {}),
      },
    });
  };

  /** Holds the message for UNDO_SEND_MS, then sends it. Undo reopens the draft. */
  const send = (draft: Draft, message: OutgoingMessage, proposalId?: number) => {
    setCompose(null);
    const reopen = () => setCompose({ draft, ...(proposalId !== undefined ? { proposalId } : {}) });
    const sending = run(
      Effect.sleep(UNDO_SEND_MS).pipe(
        Effect.andThen(sendMessage(draft.accountId, message)),
        Effect.andThen(proposalId === undefined ? Effect.void : decideProposal(proposalId, true)),
        Effect.matchCause({
          onSuccess: () => say({ text: "已发送" }),
          onFailure: (cause) => {
            // Undo interrupts the wait; the draft is already back.
            if (Cause.hasInterruptsOnly(cause)) return;
            say({ text: `发送失败：${causeText(cause)}`, tone: "error" });
            reopen();
          },
        }),
      ),
    );
    say({
      text: "正在发送…",
      duration: UNDO_SEND_MS,
      action: {
        label: "撤销",
        run: () => {
          sending.interruptUnsafe();
          reopen();
        },
      },
    });
  };

  const reauth = (account: Account) => {
    if (account.provider === "imap") {
      setDialog("add");
      return;
    }
    say({ text: "请在浏览器里完成授权", duration: 60_000 });
    run(
      reauthAccount(account.id).pipe(
        Effect.matchCause({
          onSuccess: () => say({ text: `${account.email} 已重新登录` }),
          onFailure: (cause) => say({ text: `登录失败：${causeText(cause)}`, tone: "error" }),
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
    // Dialogs and the compose window handle their own keys.
    if (dialog || compose || editing) return;
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
  const baseTitle = view.label
    ? (CATEGORY_NAMES[view.label.id] ??
      labelMap.get(`${view.label.accountId}/${view.label.id}`)?.name ??
      "标签")
    : MAILBOX_NAMES[view.mailbox];
  const title = viewAccount ? `${baseTitle}：${viewAccount.email.split("@")[0]}` : baseTitle;

  return (
    <div className="flex h-full text-[13px] text-neutral-900 dark:text-neutral-100">
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
      {!hasAccounts ? (
        <main className="flex-1 bg-white dark:bg-neutral-900">
          <div className="drag h-13" />
        </main>
      ) : view.space === OVERVIEW ? (
        <Overview
          accounts={accountList}
          profiles={profileList}
          unread={counts}
          syncState={syncState}
          onOpen={switchSpace}
          onEditProfile={setEditing}
        />
      ) : (
        <>
          <MessageList
            title={title}
            threads={list}
            loading={threads.loading}
            showAccount={!viewAccount && (scope?.length ?? accountList.length) > 1}
            searching={search !== ""}
            filters={filters}
            onFilters={setFilters}
            labels={labelMap}
            selectedId={selectedId}
            selectionSource={selectionSource}
            onSelect={(id) => select(id, "mouse")}
            onEndReached={() => {
              if (threads.canLoadMore) loadMore();
            }}
          />
          <Reader
            messageId={selectedId}
            query={query}
            onQuery={setQuery}
            searchRef={searchRef}
            toolbar={
              threadState && (
                <ThreadActions
                  state={threadState}
                  mailbox={view.mailbox}
                  labels={threadLabels}
                  onOp={(op) => act(op)}
                  onCompose={startCompose}
                />
              )
            }
          />
        </>
      )}
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
            say({ text: `已添加 ${a.email}，正在同步` });
          }}
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
          key={compose.proposalId ?? compose.draft.inReplyTo ?? "new"}
          draft={compose.draft}
          accounts={accountList}
          onClose={() => setCompose(null)}
          onSend={(draft, message) => send(draft, message, compose.proposalId)}
        />
      )}
      <Toast toast={toast} onDone={hideToast} />
    </div>
  );
}

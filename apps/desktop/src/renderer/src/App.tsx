import { readerSelectedText, quoteChoice } from "./quote-selection";
import {
  readerThreadKey,
  replySource,
  replyTarget,
  type ReaderSelection,
} from "./reader-selection";
import { permanentDeleteFolder, supportsInInboxFilter } from "./folder-actions";
import { FolderActions } from "./components/FolderActions";
import { useAtom, useAtomMount, useAtomValue } from "@effect/atom-react";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
  applySignature,
  DEFAULT_PREFS,
  holdSend,
  markReadAfter,
  richComposeBody,
  remoteComposeBody,
  textComposeHtml,
  type DeleteFolder,
} from "@openmail/core/schema";
import { Cause, Effect, Fiber, Option } from "effect";
import { PermanentDeletePermission } from "./components/PermanentDeletePermission";
import { constVoid } from "effect/Function";
import { AsyncResult, Atom, Reactivity } from "effect/reactivity";
import { MAIL_KEYS } from "./state/keys";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { Group, Panel, useDefaultLayout } from "react-resizable-panels";

import { desktopEventRoute, editCommandRoute, type DesktopEvent } from "../../shared/desktop";
import {
  selectionShortcut,
  shortcutAction,
  spaceShortcut,
  folderShortcut,
  paneShortcut,
} from "../../shared/shortcuts";
import { ShortcutHelp } from "./components/SystemSettings";
import { useDesktopEvents, useDesktopLabels } from "./state/desktop";
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
  toDraftInput,
} from "./draft";
import { resolveComposeSender } from "./compose-sender";
import { causeText } from "./errors";
import { MailClient } from "./rpc";
import { liveUpdatesAtom, syncProgressAtom, syncStateAtom } from "./state/events";
import {
  discardDraft,
  modifyWithUndo,
  openDraft,
  openThreadWindow,
  reauthAccount,
  saveDraft,
  sendMessage,
  syncNow,
  useRunMail,
  withMail,
} from "./state/mail";
import {
  accountsAtom,
  labelsAtom,
  prefsAtom,
  profilesAtom,
  proposalsAtom,
  signaturesAtom,
  sendAsAtom,
  threadAtom,
  unreadCountsAtom,
} from "./state/queries";
import {
  EMPTY_SELECTION,
  singleSelection,
  selectRow,
  selectAll,
  moveSelection,
  selectionAfterRemoval,
  reconcileSelection,
  trimSelection,
  selectionForQuery,
  batchScope,
  requiresBatchDeleteConfirmation,
  type Selection,
} from "./state/selection";
import { Alert, AlertCancel, alertDanger, alertButton, alertPrimary } from "./components/ui/Dialog";
import { BatchActions, BatchMenuItems } from "./components/BatchActions";
import { useBatchUndo } from "./state/undo";
import { leavesList } from "./state/batch";
import { listQueryAtom, threadListAtom } from "./state/threads";
import {
  filtersAtom,
  rememberedViewsAtom,
  searchAtom,
  searchTextAtom,
  searchScopeAtom,
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

import { moveMailPaneFocus } from "./pane-navigation";
import { GoToFolder } from "./components/GoToFolder";
import { SnoozeDialog } from "./components/SnoozeDialog";
import { FilterEditor } from "./components/ServerSettings";

type Dialog = "add" | "settings" | "proposals" | "help" | null;

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

export function App() {
  // The one subscription to the main process's events, and the RPC runtime,
  // live as long as the window.
  useAtomMount(MailClient.runtime);
  useAtomMount(liveUpdatesAtom);
  const run = useRunMail();
  useDesktopLabels();
  const [desktopEvents, setDesktopEvents] = useState<readonly DesktopEvent[]>([]);

  const { t, i18n } = useLingui();

  const [view, setView] = useAtom(viewAtom);
  const remembered = useAtomValue(rememberedViewsAtom);
  const [query, setQuery] = useAtom(searchTextAtom);
  const [, setSearchScope] = useAtom(searchScopeAtom);
  const search = useAtomValue(searchAtom);
  const [filters, setFilters] = useAtom(filtersAtom);
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const selectedId = selection.ids.size === 1 ? ([...selection.ids][0] ?? null) : null;
  const setSelectedId = (id: string | null) => setSelection(singleSelection(id));
  const [restoration, setRestoration] = useState<{
    selection: Selection;
    scopeKey: string;
    fromList: readonly ThreadSummary[];
    expected: Selection;
  } | null>(null);
  const [deleteRequest, setDeleteRequest] = useState<{
    ids: ReadonlySet<string>;
    scopeKey: string;
  } | null>(null);
  const [permanentRequest, setPermanentRequest] = useState<{
    ids: readonly string[];
    flat: boolean;
    folder: DeleteFolder;
  } | null>(null);
  const requestPermanentDelete = (ids: readonly string[]) => {
    if (deleteFolder)
      setPermanentRequest({ ids: [...ids], flat: !prefs.threadGrouping, folder: deleteFolder });
  };
  const [permissionAccount, setPermissionAccount] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
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
  const searchRef = useRef<HTMLInputElement>(null);
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
  const listQuery = useAtomValue(listQueryAtom);
  const deleteFolder = permanentDeleteFolder(view, listQuery);
  const folderAccountIds = listQuery?.accountIds ?? scope;
  const scopeKey = JSON.stringify([listQuery, search, filters]);
  const currentSelection = useRef({ selection, scopeKey, list });
  useEffect(() => {
    currentSelection.current = { selection, scopeKey, list };
  }, [selection, scopeKey, list]);
  const rowMap = new Map(list.map((row) => [row.id, row]));
  const visibleIds = new Set(rowMap.keys());
  if (restoration && (restoration.scopeKey !== scopeKey || restoration.expected !== selection))
    setRestoration(null);
  if (
    restoration?.scopeKey === scopeKey &&
    restoration.expected === selection &&
    restoration.fromList !== list &&
    !threads.loading
  ) {
    setRestoration(null);
    setSelection(trimSelection(restoration.selection, visibleIds));
  }
  const [rowCache, setRowCache] = useState({
    list,
    selection,
    rows: new Map<string, ThreadSummary>(),
    scopeKey,
  });
  if (
    rowCache.list !== list ||
    rowCache.selection !== selection ||
    rowCache.scopeKey !== scopeKey
  ) {
    const sameScope = rowCache.scopeKey === scopeKey;
    const remapped = reconcileSelection(
      selectionForQuery(selection, rowCache.scopeKey, scopeKey),
      sameScope ? rowCache.rows : new Map(),
      list,
      listQuery?.flat ?? false,
    );
    const reconciled = threads.loading ? remapped : trimSelection(remapped, visibleIds);
    if (reconciled !== selection) setSelection(reconciled);
    if (!sameScope) {
      setLabelPicker(false);
      setDeleteRequest(null);
    }
    const rows = new Map(
      list.filter((row) => reconciled.ids.has(row.id)).map((row) => [row.id, row]),
    );
    setRowCache({ list, selection: reconciled, rows, scopeKey });
  }
  const batchRows = batchScope(selection, rowMap).rows;
  const selected = selectedId ? rowMap.get(selectedId) : undefined;
  const [readerSelection, setReaderSelection] = useState<ReaderSelection | null>(null);
  const openThread = AsyncResult.value(useAtomValue(threadAtom(selectedId)));
  const messages = openThread._tag === "Some" ? openThread.value : undefined;
  const currentReaderThreadKey = readerThreadKey(selected ?? messages?.[0]);
  const proposals = AsyncResult.getOrElse(useAtomValue(proposalsAtom), () => []);
  const signatures = AsyncResult.getOrElse(useAtomValue(signaturesAtom), () => []);
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  const [readTarget, setReadTarget] = useState<string | null>(null);
  const groupingRef = useRef(prefs.threadGrouping);
  useEffect(() => {
    if (groupingRef.current !== prefs.threadGrouping) {
      groupingRef.current = prefs.threadGrouping;
      setSelection(EMPTY_SELECTION);
      setReadTarget(null);
    }
  }, [prefs.threadGrouping]);
  const undoSeconds = prefs.undoSendSeconds;
  /** The unread thread just opened with select(); it is marked read after the delay in preferences. */
  const print = useThreadPrint((next) => say(next));

  /** The local signature for an account: one for new messages, one for replies and forwards. */
  const signatureFor = (accountId: string, mode: ComposeMode, from?: string) => {
    const address = (from ?? accountList.find((a) => a.id === accountId)?.email)?.toLowerCase();
    const kind = mode === "new" ? "new" : "reply";
    return signatures.find((s) => s.address === address && s.kind === kind)?.text;
  };
  const [quotePrompt, setQuotePrompt] = useState<((useSelection: boolean) => void) | null>(null);
  const signed = (d: Draft): Draft => ({
    ...d,
    body:
      d.body.kind === "rich" && d.body.originalHtml !== undefined
        ? remoteComposeBody(
            `${textComposeHtml(applySignature("", undefined, signatureFor(d.accountId, d.mode, d.from?.address)))}${d.body.originalHtml}`,
          )
        : richComposeBody(
            textComposeHtml(
              applySignature(
                d.body.text,
                undefined,
                signatureFor(d.accountId, d.mode, d.from?.address),
              ),
            ),
          ),
  });

  const selectedAccount = accountList.find(
    (a) => a.id === (selected?.accountId ?? messages?.[0]?.accountId),
  );
  const stateMessages = prefs.threadGrouping
    ? messages
    : messages?.filter((message) => message.id === selectedId);
  const threadState: ThreadState | null =
    selectedAccount && stateMessages
      ? {
          provider: selectedAccount.provider,
          isUnread: stateMessages.some((m) => m.isUnread),
          isStarred: stateMessages.some((m) => m.isStarred),
          isImportant: stateMessages.some((m) => m.labels.includes("IMPORTANT")),
          labels: [...new Set(stateMessages.flatMap((m) => m.labels))],
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

  /** The selected IDs are captured once; core records exact per-message undo. */
  const act = (
    op: MailOp,
    opts: { quiet?: boolean; accountId?: string; confirmedIds?: ReadonlySet<string> } = {},
    target?: { id: string; state: ThreadState },
  ) => {
    const selectionScope = opts.confirmedIds ? { ...selection, ids: opts.confirmedIds } : selection;
    const {
      rows,
      ids: targets,
      count,
    } = batchScope(selectionScope, rowMap, target?.id, opts.accountId);
    if (!targets.length || threads.loading) return;
    if (op.kind === "trash" && requiresBatchDeleteConfirmation(count) && !opts.confirmedIds) {
      setDeleteRequest({ ids: new Set(targets), scopeKey });
      return;
    }
    const before = selection;
    const actionScopeKey = scopeKey;
    const targetSet = new Set(targets);
    const removed = new Set(
      rows
        .filter((row) => {
          if (!targetSet.has(row.id)) return false;
          const state = rowState(row);
          if (!state) return false;
          return listQuery ? leavesList(row, op, state.provider, listQuery, labels) : false;
        })
        .map((row) => row.id),
    );
    const next = removed.size
      ? selectionAfterRemoval(
          before,
          list.map((row) => row.id),
          removed,
          prefs.nextSelection,
        )
      : before;
    setReadTarget(null);
    run(
      modifyWithUndo(targets, op, !prefs.threadGrouping).pipe(
        Effect.matchCause({
          onFailure: (cause) => {
            const reason = causeText(i18n, cause);
            say({ text: t`Action failed: ${reason}`, tone: "error" });
          },
          onSuccess: (result) => {
            applyActionSelection(before, next, actionScopeKey);
            if (opts.quiet) return;
            showUndo(result, targets, i18n._(OP_DONE[op.kind](op)), () => {
              restoreActionSelection(before, actionScopeKey, rows);
            });
          },
        }),
      ),
    );
  };

  const focusList = (focus: string | null) => {
    requestAnimationFrame(() => {
      const element = listRef.current;
      const row = focus
        ? [...(element?.querySelectorAll<HTMLButtonElement>("[data-id]") ?? [])].find(
            (candidate) => candidate.dataset.id === focus,
          )
        : undefined;
      (row ?? element)?.focus({ preventScroll: true });
    });
  };
  const applyActionSelection = (before: Selection, next: Selection, actionScope: string) => {
    const current = currentSelection.current;
    if (current.scopeKey !== actionScope || current.selection !== before) return;
    setSelection(next);
    setSelectionSource("keyboard");
    focusList(next.focus);
  };
  const restoreActionSelection = (
    before: Selection,
    actionScope: string,
    rows: readonly ThreadSummary[],
  ) => {
    if (currentSelection.current.scopeKey !== actionScope) return;
    const current = currentSelection.current;
    const remapped = reconcileSelection(
      before,
      new Map(rows.map((row) => [row.id, row])),
      current.list,
      !prefs.threadGrouping,
    );
    const expected = trimSelection(remapped, new Set(current.list.map((row) => row.id)));
    setSelection(expected);
    setRestoration(
      expected.ids.size === remapped.ids.size
        ? null
        : { selection: remapped, scopeKey: actionScope, fromList: current.list, expected },
    );
    setReadTarget(null);
    setSelectionSource("keyboard");
    focusList(before.focus);
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
    run(modifyWithUndo([id], { kind: "read", value: true }, !prefs.threadGrouping));
  });
  // Moving to another thread before the delay passes leaves this one unread.
  useEffect(
    () =>
      selection.ids.size === 1 && readTarget && readTarget === selectedId
        ? markReadAfter(prefs.markReadDelay, () => markRead(readTarget))
        : constVoid,
    [readTarget, selectedId, selection.ids.size, prefs.markReadDelay],
  );

  const openWindow = (id: string) => run(openThreadWindow(id));

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
            say({ text: t`Can't open the draft: ${reason}`, tone: "error" });
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
            say({ text: t`Can't open the draft: ${reason}`, tone: "error" });
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

  /** Quiet closes retain storage; explicit Save persists even a cleared draft. */
  const closeCompose = (draft: Draft, changed: boolean) => {
    if (!changed) {
      setCompose(null);
      return;
    }
    run(
      saveDraft(toDraftInput(draft)).pipe(
        Effect.matchCause({
          onSuccess: () => setCompose(null),
          onFailure: (cause) => {
            const reason = causeText(i18n, cause);
            say({ text: t`Couldn't save the draft: ${reason}`, tone: "error" });
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
              say({ text: options.archive ? t`Sent and archived` : t`Sent` });
              // The archived thread leaves the list; move on as E does.
              if (options.archive && selectedId === draft.inReplyTo) {
                setSelection(
                  selectionAfterRemoval(
                    selection,
                    list.map((row) => row.id),
                    new Set([selectedId]),
                    prefs.nextSelection,
                  ),
                );
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
      setFilters((chosen) => ({ ...chosen, enabled: false }));
      setSelectedId(messageId);
      setSelectionSource("mouse");
    }
  };

  const openExternal = (id: string) => {
    run(
      withMail((call) =>
        Effect.gen(function* () {
          const linkedMessages = yield* call("Thread", { id });
          const linkedAccounts = yield* call("Accounts", undefined);
          const owner = linkedAccounts.find(
            (account) => account.id === linkedMessages[0]?.accountId,
          );
          const space = owner?.profileId ?? ALL;
          setView({ space, mailbox: "all", ...(owner ? { accountId: owner.id } : {}) });
          setQuery("");
          setFilters((chosen) => ({ ...chosen, enabled: false }));
          setSelectedId(id);
          setSelectionSource("mouse");
          setReadTarget(linkedMessages.some((m) => m.isUnread) ? id : null);
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            const reason = causeText(i18n, cause);
            say({ text: t`Can't open the message: ${reason}`, tone: "error" });
          }),
        ),
      ),
    );
  };
  const receiveDesktop = (event: DesktopEvent) => {
    setDesktopEvents((events) => events.filter((item) => item !== event));
    switch (event._tag) {
      case "AttachFiles":
        window.dispatchEvent(new Event("openmail-attach-files"));
        break;
      case "QuitCheck":
        reportSendState();
        break;
      case "UndoSend":
        undoSend();
        break;
      case "Edit": {
        const busy = Boolean(
          dialog ||
          compose ||
          editing ||
          goToFolder ||
          snoozeIds ||
          filterSeed ||
          view.space === OVERVIEW ||
          threads.loading ||
          document.querySelector('[role="dialog"],[role="alertdialog"]'),
        );
        const typing = Boolean(
          document.activeElement?.closest('input,textarea,select,[contenteditable="true"]'),
        );
        if (
          editCommandRoute(
            busy,
            typing,
            event.action === "selectAll" &&
              Boolean(document.activeElement?.closest("iframe,[data-reader-text]")),
          ) === "text"
        )
          run(withMail((call) => call("NativeEdit", { action: event.action })));
        else if (event.action === "undo") undoRef.current?.();
        else {
          const next = selectAll(
            selection,
            list.map((row) => row.id),
          );
          setSelection(next);
          setReadTarget(null);
          setSelectionSource("keyboard");
          focusList(next.focus);
        }
        break;
      }
      case "OpenThread":
        openExternal(event.id);
        break;
      case "Search":
        changeView({ space: ALL, mailbox: "all" });
        setSearchScope("all");
        setQuery(event.query);
        searchRef.current?.focus();
        break;
      case "Compose":
        startNewMessage(event.draft);
        break;
      case "Command":
        if (event.command === "compose") startCompose("new");
        else if (event.command === "inbox") {
          changeView({ space: view.space === OVERVIEW ? ALL : view.space, mailbox: "inbox" });
          setQuery("");
        } else setDialog(event.command === "help" ? "help" : "settings");
        break;
    }
  };
  useDesktopEvents((event) => {
    const route = desktopEventRoute(
      event,
      Boolean(
        dialog ||
        compose ||
        editing ||
        goToFolder ||
        snoozeIds ||
        filterSeed ||
        document.querySelector('[role="dialog"],[role="alertdialog"]'),
      ),
    );
    if (route === "dispatch") receiveDesktop(event);
    else if (route === "defer") setDesktopEvents((events) => [...events, event]);
  });
  const receiveLink = useEffectEvent(receiveDesktop);
  useEffect(() => {
    // An incoming link waits while another draft/dialog is being edited.
    if (dialog || compose || editing || goToFolder || snoozeIds || filterSeed) return constVoid;
    const event = desktopEvents.find(
      (item) => accountList.length || (item._tag === "Command" && item.command !== "compose"),
    );
    if (!event) return constVoid;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) receiveLink(event);
    });
    return () => {
      cancelled = true;
    };
  }, [
    desktopEvents,
    accountList.length,
    dialog,
    compose,
    editing,
    goToFolder,
    snoozeIds,
    filterSeed,
  ]);

  useEffect(() => {
    run(withMail((call) => call("SetActiveSpace", { space: view.space })));
  }, [view.space, run]);

  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (
      dialog ||
      compose ||
      editing ||
      goToFolder ||
      snoozeIds ||
      filterSeed ||
      deleteRequest ||
      e.defaultPrevented
    )
      return;
    if (e.target instanceof Element && e.target.closest('[role="menu"],[role="dialog"]')) return;
    const typing =
      e.target instanceof Element &&
      Boolean(e.target.closest('input,textarea,select,[contenteditable="true"]'));
    const spaceKey = !typing ? spaceShortcut(e, prefs.shortcutSet) : null;
    if (spaceKey) {
      e.preventDefault();
      const space =
        spaceKey.kind === "overview"
          ? OVERVIEW
          : spaceKey.kind === "all"
            ? ALL
            : profileList[spaceKey.index]?.id;
      if (space) switchSpace(space);
      return;
    }
    const mailboxKey = folderShortcut(prefs.shortcutSet, e, typing);
    if (mailboxKey) {
      e.preventDefault();
      changeView({
        ...view,
        space: view.space === OVERVIEW ? ALL : view.space,
        mailbox: mailboxKey,
        label: undefined,
      });
      focusList(null);
      return;
    }
    const direction = !typing ? paneShortcut(e) : null;
    if (
      direction &&
      view.space !== OVERVIEW &&
      moveMailPaneFocus(document, direction, selection.focus)
    ) {
      e.preventDefault();
      return;
    }
    if (e.key === "Escape") {
      setQuery("");
      searchRef.current?.blur();
      return;
    }
    if (!typing && view.space !== OVERVIEW && !threads.loading) {
      const gesture = selectionShortcut(e);
      if (gesture === "all") {
        if (document.activeElement?.closest("iframe,[data-reader-text]")) return;
        e.preventDefault();
        setSelection(
          selectAll(
            selection,
            list.map((row) => row.id),
          ),
        );
        setReadTarget(null);
        setSelectionSource("keyboard");
        focusList(selection.focus ?? list[0]?.id ?? null);
        return;
      }
      if (gesture === "extendNext" || gesture === "extendPrevious") {
        e.preventDefault();
        const next = moveSelection(
          selection,
          list.map((row) => row.id),
          gesture === "extendNext" ? 1 : -1,
          true,
        );
        setSelection(next);
        setReadTarget(null);
        setSelectionSource("keyboard");
        focusList(next.focus);
        if (next.focus === list.at(-1)?.id) loadMore();
        return;
      }
    }
    const action = shortcutAction(prefs.shortcutSet, e, typing);
    if (!action) return;
    if (
      view.space === OVERVIEW &&
      !["compose", "newWindow", "settings", "help", "search", "sync"].includes(action)
    )
      return;
    e.preventDefault();
    switch (action) {
      case "compose":
        startCompose("new");
        break;
      case "newWindow":
        run(withMail((call) => call("NewWindow", undefined)));
        break;
      case "settings":
        setDialog("settings");
        break;
      case "help":
        setDialog("help");
        break;
      case "search":
        searchRef.current?.focus();
        break;
      case "sync":
        run(syncNow);
        break;
      case "undo":
        undoRef.current?.();
        break;
      case "goToFolder":
        setGoToFolder(true);
        break;
      case "filterUnread":
        setFilters((f) => ({ ...f, enabled: !f.enabled }));
        break;
      case "openThread":
        if (selectedId && view.mailbox !== "drafts") openWindow(selectedId);
        break;
      case "print":
        if (selectedId && threadState)
          print(selectedId, false, prefs.threadGrouping ? undefined : selectedId);
        break;
      case "archive":
        act({ kind: "archive" });
        break;
      case "trash":
        act({ kind: "trash" });
        break;
      case "spam":
        act({ kind: "spam" });
        break;
      case "inbox":
        act({ kind: "inbox" });
        break;
      case "read":
        if (batchRows.length) act({ kind: "read", value: batchRows.some((row) => row.isUnread) });
        break;
      case "star":
        if (batchRows.length)
          act({ kind: "star", value: !batchRows.every((row) => row.isStarred) });
        break;
      case "important":
        if (threadState?.provider === "gmail")
          act({ kind: "important", value: !threadState.isImportant });
        break;
      case "reply":
        startCompose("reply");
        break;
      case "replyAll":
        startCompose("replyAll");
        break;
      case "forward":
        startCompose("forward");
        break;
      case "forwardAttachment":
        startCompose("forward", true);
        break;
      case "label":
      case "move":
        if (batchRows.length && labels.length) setLabelPicker(true);
        break;
      case "next":
      case "previous": {
        const next = moveSelection(
          selection,
          list.map((row) => row.id),
          action === "next" ? 1 : -1,
          false,
        );
        select(next.focus, "keyboard");
        focusList(next.focus);
        if (next.focus === list.at(-1)?.id) loadMore();
        break;
      }
      // Composer and Reader own these actions.
      case "templates":
      case "sendArchive":
      case "attach":
      case "saveDraft":
      case "showCc":
      case "closeCompose":
      case "zoomIn":
      case "zoomOut":
      case "zoomReset":
      case "expandAll":
      case "collapseAll":
      case "saveMessage":
      case "searchSender":
      case "openMessageWeb":
      case "send":
        break;
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
          data-mail-pane="sidebar"
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
              data-mail-pane="list"
              defaultSize={380}
              minSize={280}
              maxSize={720}
              groupResizeBehavior="preserve-pixel-size"
            >
              <MessageList
                key={JSON.stringify([view, search, filters])}
                title={title}
                threads={list}
                loading={threads.loading}
                showAccount={!viewAccount && (scope?.length ?? accountList.length) > 1}
                searching={search !== ""}
                searchingServer={threads.searchingServer}
                searchTruncated={threads.searchTruncated}
                searchErrors={threads.searchErrors}
                filters={filters}
                inLabel={supportsInInboxFilter(view, accountList)}
                onFilters={setFilters}
                folderActions={
                  <FolderActions
                    folder={{
                      mailbox: view.mailbox,
                      ...(folderAccountIds ? { accountIds: folderAccountIds } : {}),
                      ...(view.label ? { label: view.label.id } : {}),
                    }}
                    notify={(text, error) =>
                      say({ text, ...(error ? { tone: "error" as const } : {}) })
                    }
                  />
                }
                labels={labelMap}
                selectedId={selection.focus}
                selectedIds={selection.ids}
                listRef={listRef}
                selectionSource={selectionSource}
                rowActions={{
                  batchMenu: (
                    <BatchMenuItems
                      onPermanentDelete={
                        deleteFolder
                          ? () => requestPermanentDelete(batchRows.map((row) => row.id))
                          : undefined
                      }
                      rows={batchRows}
                      accounts={accountList}
                      labels={labels}
                      onOp={(op, accountId) => act(op, accountId ? { accountId } : {})}
                    />
                  ),
                  mailbox: view.mailbox,
                  labels,
                  stateOf: rowState,
                  onOp: (m, state, op) => act(op, {}, { id: m.id, state }),
                  onCompose: (m, mode, asAttachment) => startCompose(mode, asAttachment, m.id),
                  onPermanentDelete: deleteFolder
                    ? (thread) => requestPermanentDelete([thread.id])
                    : undefined,
                  onSnooze: (thread) => setSnoozeIds([thread.id]),
                  onFilter: (thread) =>
                    setFilterSeed({ accountId: thread.accountId, from: thread.from.address }),
                  onOpenWindow: (m) =>
                    view.mailbox === "drafts" ? openSavedDraft(m.id) : openWindow(m.id),
                }}
                onSelect={(id, modifiers) => {
                  if (threads.loading) return;
                  if (view.mailbox !== "drafts") {
                    const next = selectRow(
                      selection,
                      list.map((row) => row.id),
                      id,
                      modifiers,
                    );
                    setSelection(next);
                    if (modifiers.toggle && !next.ids.has(id)) focusList(next.focus);
                    setSelectionSource("mouse");
                    setLabelPicker(false);
                    setReadTarget(
                      next.ids.size === 1 &&
                        next.ids.has(id) &&
                        list.find((row) => row.id === id)?.isUnread
                        ? id
                        : null,
                    );
                    return;
                  }
                  // Drafts open in the compose window.
                  setSelectedId(id);
                  openSavedDraft(id);
                }}
                onEndReached={() => {
                  loadMore();
                }}
              />
            </Panel>
            <ResizeHandle />
            <Panel id="reader" data-mail-pane="reader" tabIndex={-1} minSize={360}>
              <Reader
                messageId={selectedId}
                threadKey={currentReaderThreadKey}
                onMarkUnread={() => setReadTarget(null)}
                onActionDone={({ result, ids, op }) =>
                  showUndo(result, ids, i18n._(OP_DONE[op.kind](op)))
                }
                onSelectMessage={(id) => {
                  if (currentReaderThreadKey)
                    setReaderSelection({ threadKey: currentReaderThreadKey, id });
                }}
                derivedMatches={selected?.derivedMatches}
                query={query}
                onQuery={setQuery}
                searchRef={searchRef}
                onComposeMessage={(id, mode, attachment) => startCompose(mode, attachment, id)}
                onEditDraft={openSavedDraft}
                notify={(next) => say(next)}
                renderToolbar={(compact) =>
                  selection.ids.size > 1 ? (
                    <BatchActions
                      onPermanentDelete={
                        deleteFolder
                          ? () => requestPermanentDelete(batchRows.map((row) => row.id))
                          : undefined
                      }
                      rows={batchRows}
                      canLoadMore={threads.canLoadMore}
                      moreNotLoaded={threads.moreNotLoaded}
                      accounts={accountList}
                      labels={labels}
                      onOp={(op, accountId) => act(op, accountId ? { accountId } : {})}
                      labelPicker={labelPicker}
                      onLabelPicker={setLabelPicker}
                    />
                  ) : (
                    threadState && (
                      <ThreadActions
                        compact={compact}
                        state={threadState}
                        mailbox={view.mailbox}
                        labels={threadLabels}
                        onOp={(op) => act(op)}
                        onPermanentDelete={
                          deleteFolder
                            ? () => {
                                if (selectedId) requestPermanentDelete([selectedId]);
                              }
                            : undefined
                        }
                        onCompose={startCompose}
                        onSendAgain={
                          stateMessages?.some((m) => m.labels.includes("SENT"))
                            ? () =>
                                sendAgain(
                                  stateMessages.filter((m) => m.labels.includes("SENT")).at(-1)?.id,
                                )
                            : undefined
                        }
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
                  )
                }
              />
            </Panel>
          </>
        )}
      </Group>
      <Alert
        open={quotePrompt !== null}
        onOpenChange={(open) => {
          if (!open) setQuotePrompt(null);
        }}
        title={t`Quote only the selected text?`}
      >
        <AlertCancel>{t`Cancel`}</AlertCancel>
        <button
          type="button"
          className={alertButton}
          onClick={() => {
            quotePrompt?.(false);
            setQuotePrompt(null);
          }}
        >{t`Whole message`}</button>
        <button
          type="button"
          className={alertPrimary}
          onClick={() => {
            quotePrompt?.(true);
            setQuotePrompt(null);
          }}
        >{t`Selected text`}</button>
      </Alert>
      <Alert
        open={deleteRequest !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteRequest(null);
        }}
        title={t`Delete ${deleteRequest?.ids.size ?? 0} conversations?`}
        description={t`These loaded conversations will be moved to Trash. You can undo this batch.`}
      >
        <AlertCancel>{t`Cancel`}</AlertCancel>
        <button
          type="button"
          className={alertDanger}
          onClick={() => {
            const request = deleteRequest;
            setDeleteRequest(null);
            if (request && request.scopeKey === scopeKey)
              act({ kind: "trash" }, { confirmedIds: request.ids });
          }}
        >{t`Delete`}</button>
      </Alert>
      <Alert
        open={permanentRequest !== null}
        onOpenChange={(open) => {
          if (!open) setPermanentRequest(null);
        }}
        title={t`Permanently delete selected mail?`}
        description={
          permanentRequest?.flat
            ? t`Only the selected messages in this Trash or Spam folder will be permanently deleted. This cannot be undone.`
            : t`Only messages in this Trash or Spam folder from the selected conversations will be permanently deleted. Inbox and Sent copies will remain. This cannot be undone.`
        }
      >
        <AlertCancel>{t`Cancel`}</AlertCancel>
        <button
          type="button"
          className={alertDanger}
          onClick={() => {
            const request = permanentRequest;
            if (!request) return;
            setPermanentRequest(null);
            run(
              withMail((call) =>
                call("PermanentlyDelete", {
                  threads: request.ids,
                  flat: request.flat,
                  folder: request.folder,
                  confirmed: true,
                }),
              ).pipe(
                Reactivity.mutation(MAIL_KEYS),
                Effect.matchCause({
                  onSuccess: (count) => {
                    say({ text: t`Permanently deleted ${count} messages` });
                    setSelectedId(null);
                  },
                  onFailure: (cause) => {
                    const error = Cause.findErrorOption(cause);
                    if (
                      Option.isSome(error) &&
                      error.value._tag === "FeatureScopeMissing" &&
                      error.value.feature === "permanentDelete"
                    ) {
                      setPermissionAccount(error.value.accountId);
                      return;
                    }
                    const reason = causeText(i18n, cause);
                    say({ text: t`Couldn't delete: ${reason}`, tone: "error" });
                  },
                }),
              ),
            );
          }}
        >{t`Permanently delete`}</button>
      </Alert>
      {permissionAccount && (
        <PermanentDeletePermission
          key={permissionAccount}
          accountId={permissionAccount}
          onClose={() => setPermissionAccount(null)}
        />
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
      {dialog === "help" && <ShortcutHelp onClose={() => setDialog(null)} />}
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

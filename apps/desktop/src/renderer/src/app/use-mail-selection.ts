import { useAtom, useAtomValue } from "@effect/atom-react";
import { useLingui } from "@lingui/react/macro";
import { DEFAULT_PREFS, markReadAfter } from "@openmail/core/schema";
import { Effect } from "effect";
import { constVoid } from "effect/Function";
import { AsyncResult } from "effect/reactivity";
import type { Dispatch, SetStateAction } from "react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { Account, ThreadSummary } from "../../../shared/api";
import type { AppMessages } from "../App";
import { type SelectionSource } from "../components/MessageList";
import type { ToastState } from "../components/Toast";
import { causeText } from "../errors";
import { permanentDeleteFolder } from "../folder-actions";
import { modifyWithUndo, openThreadWindow, useRunMail, withMail } from "../state/mail";
import { prefsAtom } from "../state/queries";
import {
  batchScope,
  EMPTY_SELECTION,
  moveSelection,
  reconcileSelection,
  selectAll,
  selectionAfterRemoval,
  selectionForQuery,
  selectRow,
  singleSelection,
  trimSelection,
  type Selection,
} from "../state/selection";
import { listQueryAtom, threadListAtom } from "../state/threads";
import {
  filtersAtom,
  rememberedViewsAtom,
  searchAtom,
  searchScopeAtom,
  searchTextAtom,
  viewAtom,
} from "../state/ui";
import { ALL, scopeAccountIds, type SpaceId, type View } from "../view";
import { restoredSelection, settleStartupSelection } from "../window-selection";

export function useMailSelection({
  setLabelPicker,
  accountsReady,
  accountList,
  run,
  composeId,
  say,
  messages,
}: {
  messages: AppMessages;
  setLabelPicker: Dispatch<SetStateAction<boolean>>;
  accountsReady: boolean;
  accountList: readonly Account[];
  run: ReturnType<typeof useRunMail>;
  composeId: string | undefined;
  say: (next: Omit<ToastState, "id">) => void;
}) {
  const { i18n } = useLingui();
  const [view, setView] = useAtom(viewAtom);
  const remembered = useAtomValue(rememberedViewsAtom);
  const [query, setQuery] = useAtom(searchTextAtom);
  const [, setSearchScope] = useAtom(searchScopeAtom);
  const search = useAtomValue(searchAtom);
  const [filters, setFilters] = useAtom(filtersAtom);
  const [selection, setSelection] = useState<Selection>(() =>
    singleSelection(restoredSelection()?.messageId ?? null),
  );
  const selectedId = selection.ids.size === 1 ? ([...selection.ids][0] ?? null) : null;
  const setSelectedId = (id: string | null) => setSelection(singleSelection(id));
  const [removalNavigation, setRemovalNavigation] = useState<{
    scopeKey: string;
    before: Selection;
    fromList: readonly ThreadSummary[];
    fallback: Selection;
    target: Selection | null;
  } | null>(null);
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

  const listRef = useRef<HTMLDivElement>(null);
  const [selectionSource, setSelectionSource] = useState<SelectionSource>("mouse");

  const [threads, loadMore] = useAtom(threadListAtom);
  const list = threads.threads;
  const listQuery = useAtomValue(listQueryAtom);
  const deleteFolder = permanentDeleteFolder(view, listQuery);
  const folderAccountIds = listQuery?.accountIds ?? scopeAccountIds(view, accountList);
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
  const [startupTarget, setStartupTarget] = useState<{ id: string; scope: string | null } | null>(
    () => {
      const id = restoredSelection()?.messageId;
      return id ? { id, scope: null } : null;
    },
  );
  const startupMatchesScope =
    startupTarget?.scope == null || startupTarget.scope === JSON.stringify([view, query]);
  if (!startupMatchesScope) {
    setStartupTarget(null);
    setSelection(EMPTY_SELECTION);
  }
  const startupSelection = startupMatchesScope ? (startupTarget?.id ?? null) : null;
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
      startupSelection ? selection : selectionForQuery(selection, rowCache.scopeKey, scopeKey),
      sameScope ? rowCache.rows : new Map(),
      list,
      listQuery?.flat ?? false,
    );
    const preserveRemoval =
      removalNavigation?.scopeKey === scopeKey && removalNavigation.before === selection;
    const reconciled =
      startupSelection || threads.loading || preserveRemoval
        ? remapped
        : trimSelection(remapped, visibleIds);
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
  const settled = settleStartupSelection(
    startupSelection,
    selection,
    accountsReady && listQuery !== null && !threads.loading && startupMatchesScope,
    visibleIds,
  );
  if (settled.startupId !== startupSelection) {
    setStartupTarget(null);
  }
  if (settled.selection !== selection) setSelection(settled.selection);
  const batchRows = batchScope(selection, rowMap).rows;
  const selected = selectedId ? rowMap.get(selectedId) : undefined;

  const prefsResult = useAtomValue(prefsAtom);
  const prefs = AsyncResult.getOrElse(prefsResult, () => DEFAULT_PREFS);
  const [readTarget, setReadTarget] = useState<string | null>(null);
  const groupingRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (prefsResult._tag !== "Success") return;
    if (groupingRef.current !== null && groupingRef.current !== prefs.threadGrouping) {
      setSelection(EMPTY_SELECTION);
      setReadTarget(null);
    }
    groupingRef.current = prefs.threadGrouping;
  }, [prefs.threadGrouping, prefsResult._tag]);

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
  const continueRemovalNavigation = useEffectEvent(
    (state: {
      pending: typeof removalNavigation;
      scopeKey: string;
      selected: Selection;
      rows: readonly ThreadSummary[];
      loadingMore: boolean;
      canLoadMore: boolean;
    }) => {
      const pending = state.pending;
      if (!pending) return;
      if (pending.scopeKey !== state.scopeKey || state.selected !== pending.before) {
        setRemovalNavigation(null);
        return;
      }
      const target = pending.target;
      if (!target) return;
      if (target.focus && !state.rows.some((row) => row.id === target.focus)) {
        if (state.loadingMore) return;
        if (state.canLoadMore) {
          loadMore();
          return;
        }
        if (state.rows === pending.fromList) return;
      }
      setRemovalNavigation(null);
      const next =
        target.focus && !state.rows.some((row) => row.id === target.focus)
          ? trimSelection(pending.fallback, new Set(state.rows.map((row) => row.id)))
          : target;
      setSelection(next);
      setSelectionSource("keyboard");
      focusList(next.focus);
    },
  );
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled)
        continueRemovalNavigation({
          pending: removalNavigation,
          scopeKey,
          selected: selection,
          rows: list,
          loadingMore: threads.loadingMore,
          canLoadMore: threads.canLoadMore,
        });
    });
    return () => {
      cancelled = true;
    };
  }, [removalNavigation, scopeKey, selection, list, threads.loadingMore, threads.canLoadMore]);
  const beginRemoval = (before: Selection, fallback: Selection, actionScope: string) =>
    setRemovalNavigation({ scopeKey: actionScope, before, fromList: list, fallback, target: null });
  const settleRemoval = (before: Selection, actionScope: string, target: Selection) =>
    setRemovalNavigation((pending) =>
      pending?.scopeKey === actionScope && pending.before === before
        ? { ...pending, target }
        : pending,
    );
  const cancelRemoval = (before: Selection) =>
    setRemovalNavigation((pending) => (pending?.before === before ? null : pending));

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
    setRemovalNavigation(null);
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
      prefs.readingPaneVisible &&
      selection.ids.size === 1 &&
      readTarget &&
      readTarget === selectedId
        ? markReadAfter(prefs.markReadDelay, () => markRead(readTarget))
        : constVoid,
    [readTarget, selectedId, selection.ids.size, prefs.markReadDelay, prefs.readingPaneVisible],
  );

  const changeView = (next: View) => {
    setStartupTarget(null);
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

  useEffect(() => {
    if (!composeId)
      run(
        withMail((call) =>
          call("SetWindowSelection", { selection: { ...view, messageId: selectedId } }),
        ),
      );
  }, [run, composeId, view, selectedId]);

  useEffect(() => {
    run(withMail((call) => call("SetActiveSpace", { space: view.space })));
  }, [view.space, run]);

  const selectAllRows = (preserveFocus = false) => {
    const next = selectAll(
      selection,
      list.map((row) => row.id),
    );
    setSelection(next);
    setReadTarget(null);
    setSelectionSource("keyboard");
    focusList(preserveFocus ? (selection.focus ?? list[0]?.id ?? null) : next.focus);
  };
  const move = (direction: 1 | -1, extend = false) => {
    const next = moveSelection(
      selection,
      list.map((row) => row.id),
      direction,
      extend,
    );
    if (extend) {
      setSelection(next);
      setReadTarget(null);
      setSelectionSource("keyboard");
    } else select(next.focus, "keyboard");
    focusList(next.focus);
    if (next.focus === list.at(-1)?.id) loadMore();
  };
  const archiveSentReply = (replyTo: string | undefined) => {
    if (selectedId !== replyTo) return;
    setSelection(
      selectionAfterRemoval(
        selection,
        list.map((row) => row.id),
        new Set([selectedId]),
        prefs.nextSelection,
      ),
    );
  };

  const selectListRow = (id: string, modifiers: NonNullable<Parameters<typeof selectRow>[3]>) => {
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
      next.ids.size === 1 && next.ids.has(id) && list.find((row) => row.id === id)?.isUnread
        ? id
        : null,
    );
  };

  const openExternal = (id: string) => {
    run(
      withMail((call) =>
        Effect.gen(function* () {
          const result = yield* call("Thread", { id }).pipe(Effect.result);
          if (result._tag === "Failure") {
            if (result.failure._tag !== "NotFound") return yield* result.failure;
            yield* call("OpenMessageWeb", { id });
            return yield* Effect.void;
          }
          const linkedMessages = result.success;
          const linkedAccounts = yield* call("Accounts", undefined);
          const owner = linkedAccounts.find(
            (account) => account.id === linkedMessages[0]?.accountId,
          );
          const space = owner?.profileId ?? ALL;
          const nextView: View = {
            space,
            mailbox: "all",
            ...(owner ? { accountId: owner.id } : {}),
          };
          // Keep the requested message selected until the destination query has loaded.
          setStartupTarget({ id, scope: JSON.stringify([nextView, ""]) });
          setView(nextView);
          setQuery("");
          setFilters((chosen) => ({ ...chosen, enabled: false }));
          setSelectedId(id);
          setSelectionSource("mouse");
          setReadTarget(linkedMessages.some((m) => m.isUnread) ? id : null);
          return yield* Effect.void;
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            const reason = causeText(i18n, cause);
            say({ text: messages.cantOpenTheMessage(reason), tone: "error" });
          }),
        ),
      ),
    );
  };
  const openWindow = (id: string) => run(openThreadWindow(id));

  return {
    selectAll: selectAllRows,
    move,
    archiveSentReply,
    openExternal,
    openWindow,
    selectRow: selectListRow,
    view,
    query,
    setQuery,
    setSearchScope,
    search,
    filters,
    setFilters,
    selection,
    selectedId,
    setSelectedId,
    deleteRequest,
    setDeleteRequest,
    listRef,
    selectionSource,
    threads,
    loadMore,
    list,
    listQuery,
    deleteFolder,
    folderAccountIds,
    scopeKey,
    rowMap,
    batchRows,
    selected,
    prefs,
    setReadTarget,
    focusList,
    applyActionSelection,
    restoreActionSelection,
    select,
    switchSpace,
    changeView,
    beginRemoval,
    settleRemoval,
    cancelRemoval,
  };
}

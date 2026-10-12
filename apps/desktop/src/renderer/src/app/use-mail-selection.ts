import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { DEFAULT_PREFS, markReadAfter } from "@openmail/core/schema";
import { constVoid } from "effect/Function";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { Account, ThreadSummary } from "../../../shared/api";
import { type SelectionSource } from "../features/mail-list/MessageList";
import { permanentDeleteFolder } from "../lib/folder-actions";
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
} from "../lib/selection";
import { listQueryAtom, threadListAtom } from "../state/threads";
import {
  commitSearchAtom,
  filtersAtom,
  openThreadAtom,
  rememberedViewsAtom,
  searchAtom,
  searchScopeAtom,
  searchTextAtom,
  viewAtom,
} from "../state/ui";
import { scopeAccountIds, type SpaceId, type View } from "../lib/view";
import { settleStartupSelection } from "../state/window-selection";
import { navigateAtom } from "../state/location";
import { labelPickerAtom } from "../features/organize/organize-state";
import { parseAppHref } from "../../../shared/routes";

/** How long typing pauses before the search goes into the route. */
const SEARCH_COMMIT_MS = 400;

export function useMailSelection({
  accountsReady,
  accountList,
  run,
}: {
  accountsReady: boolean;
  accountList: readonly Account[];
  run: ReturnType<typeof useRunMail>;
}) {
  const [view, setView] = useAtom(viewAtom);
  const remembered = useAtomValue(rememberedViewsAtom);
  const [query, setQuery] = useAtom(searchTextAtom);
  const [, setSearchScope] = useAtom(searchScopeAtom);
  const search = useAtomValue(searchAtom);
  const [filters, setFilters] = useAtom(filtersAtom);
  // Typing stays local; the route's q follows once typing pauses, or at once when cleared.
  const committedSearch = useAtomValue(commitSearchAtom);
  const commitSearch = useAtomSet(commitSearchAtom);
  useEffect(() => {
    if (search === committedSearch) return constVoid;
    const timer = setTimeout(commitSearch, search ? SEARCH_COMMIT_MS : 0);
    return () => clearTimeout(timer);
  }, [search, committedSearch, commitSearch]);
  // The open thread lives in the route; a selection of several rows stays here.
  const [routeThread, setRouteThread] = useAtom(openThreadAtom);
  const navigate = useAtomSet(navigateAtom);
  const setLabelPicker = useAtomSet(labelPickerAtom);
  const [selection, setSelection] = useState<Selection>(() => singleSelection(routeThread));
  const selectedId = selection.ids.size === 1 ? ([...selection.ids][0] ?? null) : null;
  const [readTarget, setReadTarget] = useState<string | null>(null);
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
  /**
   * A thread the route opened before its list loaded: a restored window, Back,
   * or a link. It stays selected until the list shows whether it is there.
   * `read` marks it read once found, as opening a link to an unread thread does.
   */
  const [startupTarget, setStartupTarget] = useState<{
    id: string;
    scope: string | null;
    read?: boolean;
  } | null>(() => (routeThread ? { id: routeThread, scope: null } : null));
  const [syncedThread, setSyncedThread] = useState(routeThread);
  if (routeThread !== syncedThread) {
    // Either this window's selection reached the route, or the route moved on its own, as on
    // Back; then the list follows it.
    setSyncedThread(routeThread);
    if (routeThread !== selectedId) {
      setSelection(singleSelection(routeThread));
      setReadTarget(null);
      setStartupTarget(routeThread ? { id: routeThread, scope: null } : null);
    }
  }
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
    if (startupTarget?.read && rowMap.get(startupTarget.id)?.isUnread)
      setReadTarget(startupTarget.id);
  }
  if (settled.selection !== selection) setSelection(settled.selection);
  const batchRows = batchScope(selection, rowMap).rows;
  const selected = selectedId ? rowMap.get(selectedId) : undefined;

  const prefsResult = useAtomValue(prefsAtom);
  const prefs = AsyncResult.getOrElse(prefsResult, () => DEFAULT_PREFS);
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
    // A thread opened here goes into the route, in place: moving through the list adds no history.
    if (selectedId !== routeThread) setRouteThread(selectedId);
  }, [selectedId, routeThread, setRouteThread]);

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

  /**
   * Shows the screen a link names, as a new history entry. A thread it opens
   * shows with list filters off and is marked read like a clicked row.
   */
  const openLink = (href: string) => {
    const route = parseAppHref(href);
    if (route?.kind !== "mail") return;
    const thread = route.state.thread ?? null;
    setSelection(singleSelection(thread));
    setSelectionSource("mouse");
    setReadTarget(null);
    setStartupTarget(thread ? { id: thread, scope: null, read: true } : null);
    navigate(href);
    // Text typed but not yet committed belongs to the previous screen.
    setQuery(route.state.q ?? "");
    if (thread) setFilters((chosen) => ({ ...chosen, enabled: false }));
  };
  const openWindow = (id: string) => run(openThreadWindow(id));

  return {
    selectAll: selectAllRows,
    move,
    archiveSentReply,
    openLink,
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

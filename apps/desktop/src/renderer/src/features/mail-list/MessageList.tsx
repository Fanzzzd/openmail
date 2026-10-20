import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { EmptyList, type EmptyActions } from "./EmptyList";
import type { Label, ThreadQuery, ThreadSummary } from "../../../../shared/api";
import type { Filters } from "../../lib/view";
import { Row, RowMenu, type RowActions, type SelectRow } from "./MessageRow";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  DEFAULT_PREFS,
  LIST_DENSITIES,
  MAX_SEARCH_DEPTH,
  MAX_SEARCH_TERMS,
  moveSourceLabel,
  searchUsesSize,
  type SwipeAction,
} from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import { useAtomValue } from "@effect/atom-react";
import { prefsAtom } from "../../state/queries";
import type { SearchIgnored, SearchInputProblem } from "../../state/threads";
import { attachmentMatches } from "../search";
import { rowLayout, rowWindow } from "./row-layout";
import { swipeMailOp } from "./message-swipe";
import { pressQuickFilter, quickFilterOn } from "./quick-filters";
import { constVoid } from "effect/Function";
import { buttonLink, noticeRow, noticeTone, titlebarRow, touchTarget } from "../../ui/styles";
import { TrafficLightSpace } from "../../ui/TrafficLights";
import { TriangleAlert } from "lucide-react";
import { ContextMenuContent, ContextMenuRoot, ContextMenuTrigger } from "../../ui/Menu";
import { Tip } from "../../ui/Tip";
import { useShortcutText } from "../../i18n/use-shortcut-text";
import { Toggle } from "@base-ui/react/toggle";
import { useScrollFade } from "../../lib/scroll-fade";

/** How the current selection was made. Keyboard selection gets the solid accent. */
export type SelectionSource = "keyboard" | "mouse";

interface Props {
  /** A new key starts the rows over: scroll position, viewport and open menu. */
  resetKey?: string;
  /** The search field, when the list has the window's search instead of the reader. */
  searchBar?: ReactNode;
  /** Actions for the selected rows, shown in place of the filter chips. */
  selectionBar?: ReactNode;
  /** Controls before everything else when the list is the window's leftmost pane. */
  leading?: ReactNode;
  /** Connection or sync problems, above the rows. */
  notice?: ReactNode;
  /** The next step an empty list offers. */
  emptyActions?: EmptyActions;
  /** The name to show for an account id, in search errors. */
  accountLabel?: (accountId: string) => string;
  /** Runs the server search again after it failed for some accounts. */
  onRetrySearch?: () => void;
  title: string;
  threads: readonly ThreadSummary[];
  loading: boolean;
  loadError?: boolean;
  loadingMore?: boolean;
  exhausted?: boolean;
  showAccount: boolean;
  searching: boolean;
  searchingServer: boolean;
  searchTruncated: boolean;
  searchErrorAccounts: readonly string[];
  searchReauthAccounts: readonly string[];
  searchInputInvalid: false | SearchInputProblem;
  searchIgnored: readonly SearchIgnored[];
  searchQuery?: ThreadQuery | undefined;
  filters: Filters;
  inLabel: boolean;
  folderActions: ReactNode;
  onFilters: (f: Filters) => void;
  /** User labels by `${accountId}/${labelId}`, for the chips on each row. */
  labels: Map<string, Label>;
  selectedId: string | null;
  selectedIds: ReadonlySet<string>;
  listRef: RefObject<HTMLDivElement | null>;
  selectionSource: SelectionSource;
  onSelect: SelectRow;
  onEndReached: () => void;
  /** What a row's context menu needs; the same handlers as the reader toolbar. */
  rowActions: RowActions;
}

/**
 * The search row sits outside the keyed body, so a search that replaces the rows never remounts
 * the field being typed in.
 */
export function MessageList({ resetKey, searchBar, leading, ...body }: Props) {
  const { t } = useLingui();
  // The mailbox's scroll position outlives the search bodies, so clearing a search returns to it.
  const mailboxScroll = useRef<{ key: string | undefined; top: number }>({
    key: undefined,
    top: 0,
  });
  const rememberScroll = useCallback((key: string, top: number) => {
    mailboxScroll.current = { key, top };
  }, []);
  const rememberedScroll = useCallback(
    (key: string) => (mailboxScroll.current.key === key ? mailboxScroll.current.top : null),
    [],
  );
  return (
    <section
      aria-label={body.searching ? t`Search results` : body.title}
      className="flex h-full w-full flex-col bg-surface"
    >
      {searchBar && (
        <div className={`${titlebarRow} gap-2 pr-4 pl-4`}>
          <TrafficLightSpace />
          {leading}
          {searchBar}
        </div>
      )}
      <MessageListBody
        key={resetKey}
        {...body}
        leading={searchBar ? undefined : leading}
        scrollKey={body.searching ? null : (resetKey ?? "")}
        rememberScroll={rememberScroll}
        rememberedScroll={rememberedScroll}
      />
    </section>
  );
}

function MessageListBody({
  title,
  selectionBar,
  leading,
  notice,
  emptyActions,
  accountLabel = (accountId) => accountId,
  onRetrySearch,
  threads,
  loading,
  loadingMore = false,
  loadError = false,
  exhausted = false,
  showAccount,
  searching,
  searchingServer,
  searchTruncated,
  searchErrorAccounts,
  searchReauthAccounts,
  searchInputInvalid,
  searchIgnored,
  searchQuery,
  filters,
  inLabel,
  folderActions,
  onFilters,
  labels,
  selectedId,
  selectedIds,
  listRef,
  selectionSource,
  onSelect,
  onEndReached,
  rowActions,
  scrollKey,
  rememberScroll,
  rememberedScroll,
}: Omit<Props, "resetKey" | "searchBar"> & {
  /** Where this mailbox's scroll position is kept; null while search results show. */
  scrollKey: string | null;
  rememberScroll: (key: string, top: number) => void;
  rememberedScroll: (key: string) => number | null;
}) {
  const { t, i18n } = useLingui();
  const shortcutText = useShortcutText();
  const { ref: chipsRef, mask: chipsMask } = useScrollFade();
  // One status region stays mounted, so screen readers hear each change of its text.
  const count = threads.length;
  const searchStatus = searchingServer
    ? t`Searching server…`
    : !searching || loading
      ? ""
      : count === 0
        ? t`No results`
        : exhausted
          ? t`${plural(count, { one: "# result", other: "# results" })}`
          : t`${plural(count, { one: "More than # result", other: "More than # results" })}`;
  // Local results still show when a server search fails, so the notice says so first.
  const listNames = (ids: readonly string[]) =>
    new Intl.ListFormat(i18n.locale, { type: "conjunction" }).format(ids.map(accountLabel));
  const failedSearch = listNames(
    searchErrorAccounts.filter((accountId) => !searchReauthAccounts.includes(accountId)),
  );
  const reauthSearch = listNames(
    searchErrorAccounts.filter((accountId) => searchReauthAccounts.includes(accountId)),
  );
  const searchProblem = [
    t`Showing results from this Mac.`,
    ...(failedSearch ? [t`${failedSearch} couldn't search the server.`] : []),
    ...(reauthSearch ? [t`${reauthSearch} must sign in again to search the server.`] : []),
  ].join(" ");
  // Server results skip these operators; the list then applies the whole query to them locally.
  // An account whose server search failed has no server results, so only the failure shows.
  const searchIgnoredMessages = searchIgnored
    .filter(({ accountId }) => !searchErrorAccounts.includes(accountId))
    .map(({ accountId, operators }) => {
      const account = accountLabel(accountId);
      const names = operators.join(", ");
      return operators.length === 1
        ? t`${account}: the server can't search with ${names}. OpenMail searched the server without it and applied it to the results here.`
        : t`${account}: the server can't search with ${names}. OpenMail searched the server without them and applied them to the results here.`;
    });
  /** The row under the pointer at the right-click, set before the menu opens. */
  const pressed = useRef<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const menuThread = threads.find((m) => m.id === menuFor);

  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const selectedIndex = threads.findIndex((m) => m.id === selectedId);
  const removeLabelId = moveSourceLabel(rowActions.mailbox, rowActions.currentLabel);
  const flat = !rowActions.grouped;
  const dragDataFor = (ids: readonly string[]) => JSON.stringify({ ids, removeLabelId, flat });
  // Built once per render, not once per selected row: a large selection is quadratic otherwise.
  const selectedDragData = dragDataFor(
    threads.filter((row) => selectedIds.has(row.id)).map((row) => row.id),
  );
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  const density = LIST_DENSITIES[prefs.messageListDensity];
  const [textScale, setTextScale] = useState(1);
  useEffect(() => {
    const measure = () =>
      setTextScale(parseFloat(getComputedStyle(document.documentElement).fontSize) / 16 || 1);
    measure();
    globalThis.addEventListener("resize", measure);
    return () => globalThis.removeEventListener("resize", measure);
  }, []);
  // Only rows that show attachment or text hits under them are taller.
  const layout = useMemo(
    () =>
      rowLayout(
        threads.map(
          (m) =>
            (m.derivedMatches?.length || attachmentMatches(m.searchMatches).length
              ? density.height + 48
              : density.height) * textScale,
        ),
      ),
    [threads, density.height, textScale],
  );
  const rowHeight = (index: number) =>
    (layout.offsets[index + 1] ?? 0) - (layout.offsets[index] ?? 0);
  const window = rowWindow(layout, viewport.top, viewport.height);
  const endReached = useRef(onEndReached);
  const callbacks = useRef({ onSelect, rowActions });
  useEffect(() => {
    callbacks.current = { onSelect, rowActions };
  }, [onSelect, rowActions]);
  const select = useCallback<Props["onSelect"]>(
    (id, modifiers) => callbacks.current.onSelect(id, modifiers),
    [],
  );
  const openRow = useCallback(
    (thread: ThreadSummary) => callbacks.current.rowActions.onOpenWindow(thread),
    [],
  );
  const swipe = useCallback((thread: ThreadSummary, action: SwipeAction) => {
    const actions = callbacks.current.rowActions;
    if (action === "snooze") {
      actions.onSnooze(thread);
      return;
    }
    const state = actions.stateOf(thread);
    const op = state && swipeMailOp(action, state);
    if (state && op) actions.onSwipeOp(thread, state, op);
  }, []);
  useEffect(() => {
    endReached.current = onEndReached;
  }, [onEndReached]);

  useEffect(() => {
    const observer = new ResizeObserver(() => {
      const el = listRef.current;
      if (el) setViewport({ top: el.scrollTop, height: el.clientHeight });
    });
    if (listRef.current) observer.observe(listRef.current);
    return () => observer.disconnect();
  }, [listRef]);

  // Until a new query's first page arrives the rows on screen are the previous list's (see
  // features/search/results-entry.ts). They are inert, so no click, tap or Tab reaches one and
  // focus can't sit on a row that the results then replace. They dim after a moment, so a fast
  // load does not flash.
  const stale = loading && threads.length > 0;

  // A mailbox shown again after a search scrolls back once its rows are there; another mailbox
  // starts at the top and becomes the one to remember.
  const pendingScroll = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (scrollKey === null) return;
    const saved = rememberedScroll(scrollKey);
    if (saved) pendingScroll.current = saved;
    else rememberScroll(scrollKey, 0);
  }, [scrollKey, rememberScroll, rememberedScroll]);
  useLayoutEffect(() => {
    const el = listRef.current;
    const top = pendingScroll.current;
    // The rows on screen stay the search results until the mailbox's first page loads.
    const rowsShown = window.total > 0;
    if (!el || top === null || loading || !rowsShown || searchQuery?.search !== undefined) return;
    pendingScroll.current = null;
    el.scrollTop = top;
    setViewport({ top: el.scrollTop, height: el.clientHeight });
  }, [loading, window.total, listRef, searchQuery?.search]);

  // Unmounted rows still have coordinates, so keyboard navigation can reach them. Focus moves to
  // the row only from the list or from nowhere: new results while the person types in the search
  // field must not pull keys, Backspace included, into the list.
  useEffect(() => {
    const el = listRef.current;
    if (!el || selectedIndex < 0 || selectionSource !== "keyboard") return constVoid;
    const top = layout.offsets[selectedIndex] ?? 0;
    const bottom = layout.offsets[selectedIndex + 1] ?? top;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
    setViewport({ top: el.scrollTop, height: el.clientHeight });
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body && !el.contains(active)) return;
      for (const row of el.querySelectorAll<HTMLButtonElement>("[data-id]"))
        if (row.dataset.id === selectedId) {
          row.focus({ preventScroll: true });
          break;
        }
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedIndex, selectedId, selectionSource, layout, listRef]);

  // Short first pages have no scrollbar. Ask for older mail once per list growth.
  useEffect(() => {
    if (!loading && window.total - viewport.top - viewport.height < 400) endReached.current();
  }, [loading, viewport.top, viewport.height, window.total]);

  return (
    <>
      <header className={`${titlebarRow} gap-2 pr-3 pl-5`}>
        <TrafficLightSpace />
        {leading}
        <h1 className="min-w-0 flex-1 truncate text-title font-bold">
          {searching ? <Trans>Search results</Trans> : title}
        </h1>
        <div className="flex shrink-0 items-center gap-2">{folderActions}</div>
      </header>
      {/* One row at any width; chips that do not fit scroll sideways, and a fade at a clipped
          end shows there is more. The vertical padding keeps their focus ring inside the box. */}
      <div
        ref={chipsRef}
        // The row holds the selection bar, nothing while searching, or the chips; a new key
        // measures the new content.
        key={selectionBar ? "selection" : searching ? "search" : inLabel ? "chips+inbox" : "chips"}
        data-filter-chips
        style={chipsMask ? { maskImage: chipsMask } : undefined}
        className="-mt-1 flex shrink-0 items-center gap-1 overflow-x-auto px-3 pt-1 pb-2"
      >
        {selectionBar}
        {!selectionBar && !searching && (
          <>
            <FilterChip
              active={filters.enabled}
              onChange={(enabled) => onFilters({ ...filters, enabled })}
              label={t`Quick filters`}
              tip={filters.enabled ? t`Turn off quick filters` : t`Turn on quick filters`}
              shortcut={shortcutText("filterUnread")}
            />
            <FilterChip
              active={quickFilterOn(filters, "unread")}
              onChange={(on) => onFilters(pressQuickFilter(filters, "unread", on))}
              label={t`Unread`}
              tip={t`Show only unread`}
            />
            <FilterChip
              active={quickFilterOn(filters, "starred")}
              onChange={(on) => onFilters(pressQuickFilter(filters, "starred", on))}
              label={t`Starred`}
              tip={t`Show only starred`}
            />
            <FilterChip
              active={quickFilterOn(filters, "important")}
              onChange={(on) => onFilters(pressQuickFilter(filters, "important", on))}
              label={t`Important`}
              tip={t`Show important messages`}
            />
            {inLabel && (
              <FilterChip
                active={quickFilterOn(filters, "inInbox")}
                onChange={(on) => onFilters(pressQuickFilter(filters, "inInbox", on))}
                label={t`In Inbox`}
                tip={t`Show messages also in Inbox`}
              />
            )}
          </>
        )}
      </div>

      {notice}
      <output aria-live="polite" aria-atomic="true" className="sr-only">
        {searchStatus}
      </output>
      {searchingServer && (
        <p className="px-5 pb-2 text-footnote text-a11y-muted">
          <Trans>Searching server…</Trans>
        </p>
      )}
      {searchTruncated && (
        <p className="px-5 pb-2 text-footnote text-a11y-muted">
          <Trans>More matches exist. Narrow your search.</Trans>
        </p>
      )}
      {searchIgnoredMessages.length > 0 && (
        <output className="px-5 pb-2 text-footnote text-orange-700 dark:text-orange-400">
          {searchIgnoredMessages.join(" ")}
        </output>
      )}
      {searchQuery && searchUsesSize(searchQuery) && (
        <output className="px-5 pb-2 text-footnote text-orange-700 dark:text-orange-400">
          <Trans>Unknown message sizes are left unfiltered.</Trans>
        </output>
      )}
      {searchInputInvalid && (
        <output
          role="alert"
          className="px-5 pb-2 text-footnote text-orange-700 dark:text-orange-400"
        >
          {searchInputInvalid === "terms" ? (
            <Trans>
              Search can use at most {MAX_SEARCH_TERMS} words and operators. Remove some.
            </Trans>
          ) : (
            <Trans>
              Search groups can nest at most {MAX_SEARCH_DEPTH} levels deep. Remove some
              parentheses.
            </Trans>
          )}
        </output>
      )}
      {searchErrorAccounts.length > 0 && (
        <div role="alert" className={`mx-3 mb-2 ${noticeRow} ${noticeTone.warning}`}>
          <TriangleAlert aria-hidden className="size-3.5 shrink-0 self-start" />
          {/* Wraps instead of truncating, so every account and reason stays readable. */}
          <p className="min-w-0 flex-1">{searchProblem}</p>
          {onRetrySearch && !searchingServer && (
            <button type="button" onClick={onRetrySearch} className={`self-start ${buttonLink}`}>
              <Trans>Try again</Trans>
            </button>
          )}
        </div>
      )}
      {threads.length === 0 && !loading && !searchingServer && (
        <EmptyList
          searching={searching}
          filtered={
            filters.enabled &&
            (filters.unread || filters.starred || filters.important || filters.inInbox)
          }
          mailbox={rowActions.mailbox}
          onClearFilters={() => onFilters({ ...filters, enabled: false })}
          actions={emptyActions}
        />
      )}
      <ContextMenuRoot
        onOpenChange={(open, details) => {
          // Only rows have a menu; a right-click on empty space does nothing.
          if (open && !pressed.current) {
            details.cancel();
            return;
          }
          if (open) setMenuFor(pressed.current);
        }}
        onOpenChangeComplete={(open) => {
          if (!open) setMenuFor(null);
        }}
      >
        <ContextMenuTrigger
          render={
            <div
              ref={listRef}
              // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a native select cannot host the windowed conversation rows.
              role="listbox"
              tabIndex={threads.length === 0 ? 0 : -1}
              aria-busy={loading}
              aria-multiselectable="true"
              aria-label={searching ? t`Search results` : title}
              onScroll={(e) => {
                const el = e.currentTarget;
                setViewport({ top: el.scrollTop, height: el.clientHeight });
                if (scrollKey !== null) rememberScroll(scrollKey, el.scrollTop);
                if (el.scrollTop + el.clientHeight >= el.scrollHeight - 160) endReached.current();
              }}
              onKeyDownCapture={(e) => {
                if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
                const row = e.target instanceof Element ? e.target.closest("[data-id]") : null;
                if (!row) return;
                e.preventDefault();
                e.stopPropagation();
                const rect = row.getBoundingClientRect();
                row.dispatchEvent(
                  new MouseEvent("contextmenu", {
                    bubbles: true,
                    clientX: rect.left,
                    clientY: rect.bottom,
                  }),
                );
              }}
              onContextMenuCapture={(e) => {
                const row = e.target instanceof Element ? e.target.closest("[data-id]") : null;
                pressed.current = row?.getAttribute("data-id") ?? null;
              }}
              className="flex-1 overflow-y-auto px-2 pb-2"
            />
          }
        >
          <div
            inert={stale}
            data-stale={stale || undefined}
            style={{ height: window.total, position: "relative" }}
            className={stale ? "opacity-50 transition-opacity delay-150 duration-150" : undefined}
          >
            <div style={{ transform: `translateY(${window.offset}px)` }}>
              {threads.slice(window.first, window.end).map((m, localIndex) => {
                const i = window.first + localIndex;
                return (
                  <Row
                    key={m.id}
                    thread={m}
                    rowHeight={rowHeight(i)}
                    density={density}
                    position={i + 1}
                    total={exhausted ? threads.length : -1}
                    tabbable={
                      m.id === selectedId ||
                      ((selectedIndex < window.first || selectedIndex >= window.end) &&
                        i === window.first)
                    }
                    labels={labels}
                    selected={selectedIds.has(m.id)}
                    accent={selectedIds.has(m.id) && selectionSource === "keyboard"}
                    menuOpen={m.id === menuFor}
                    // Mimestream drops the rule under the selected row and under the row above it.
                    rule={
                      i < threads.length - 1 &&
                      !selectedIds.has(m.id) &&
                      !selectedIds.has(threads[i + 1]?.id ?? "")
                    }
                    showAccount={showAccount}
                    onSelect={select}
                    dragData={selectedIds.has(m.id) ? selectedDragData : dragDataFor([m.id])}
                    onOpen={openRow}
                    swipeActions={prefs.swipeActions}
                    onSwipe={swipe}
                  />
                );
              })}
            </div>
          </div>
        </ContextMenuTrigger>
        <output className="block shrink-0 p-3 text-center text-a11y-muted">
          {loadError && (
            <p role="alert" className="text-a11y-danger">
              <Trans>Couldn't load older messages. Try again.</Trans>
            </p>
          )}
          {loadingMore ? (
            <>
              <span className="mr-2 inline-block size-3 animate-spin rounded-full border-2 border-current border-r-transparent" />
              <Trans>Loading older messages…</Trans>
            </>
          ) : exhausted ? (
            // An empty list already says so above; a server search still running may add rows.
            // After a failed server search, only the rows on this Mac have run out.
            threads.length > 0 &&
            !searchingServer &&
            (searchErrorAccounts.length > 0 ? (
              <Trans>No more messages on this Mac</Trans>
            ) : (
              <Trans>No more messages</Trans>
            ))
          ) : (
            <button type="button" onClick={onEndReached}>
              <Trans>Load older messages</Trans>
            </button>
          )}
        </output>
        {menuThread &&
          (selectedIds.has(menuThread.id) && selectedIds.size > 1 && rowActions.batchMenu ? (
            <ContextMenuContent label={t`Batch actions`}>{rowActions.batchMenu}</ContextMenuContent>
          ) : (
            <RowMenu thread={menuThread} actions={rowActions} />
          ))}
      </ContextMenuRoot>
    </>
  );
}

function FilterChip(props: {
  active: boolean;
  onChange: (active: boolean) => void;
  label: string;
  tip: string;
  shortcut?: string;
}) {
  return (
    <Tip label={props.tip} shortcut={props.shortcut}>
      <Toggle
        pressed={props.active}
        onPressedChange={props.onChange}
        // An outlined pill when off and a filled one when on, so each reads as a toggle.
        className={`h-6 shrink-0 rounded-full px-2.5 ${touchTarget} whitespace-nowrap text-footnote font-medium text-a11y-muted ring-1 ring-edge outline-offset-1 outline-a11y-focus ring-inset hover:bg-fill-hover focus-visible:outline-[3px] data-pressed:bg-blue-600 data-pressed:text-white data-pressed:ring-blue-600 dark:data-pressed:text-white`}
      >
        {props.label}
      </Toggle>
    </Tip>
  );
}

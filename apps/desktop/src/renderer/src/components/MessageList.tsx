import { labelChipColors } from "../label-colors";
import { useMessageSwipe } from "../message-swipe-hook";
import { attachmentMatches, distinctAttachmentMatches, SearchSnippet } from "./SearchSnippet";
import { TriageChip } from "./TriageChip";
import { swipeMailOp } from "../message-swipe";
import { actionNames } from "../action-names";
import type { Prefs, SwipeAction } from "@openmail/core/schema";
import { MESSAGE_DRAG } from "../organize-drag";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { prefsAtom } from "../state/queries";
import {
  moveSourceLabel,
  listWindow,
  LIST_DENSITIES,
  DEFAULT_PREFS,
  searchUsesSize,
} from "@openmail/core/schema";
import { Toggle } from "@base-ui/react/toggle";
import { constVoid } from "effect/Function";
import { Trans, useLingui } from "@lingui/react/macro";
import { Paperclip, Star } from "lucide-react";
import {
  useEffect,
  useCallback,
  useId,
  memo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import type { Label, MailOp, Mailbox, ThreadSummary, ThreadQuery } from "../../../shared/api";
import { displayName, previewText, shortDate } from "../format";
import { AccountBadge } from "./AccountBadge";
import type { Filters } from "../view";
import { ContextMenuContent, ContextMenuRoot, ContextMenuTrigger } from "./ui/Menu";
import type { ThreadState } from "../focused-inbox";
import { ThreadMenuItems } from "./ThreadActions";
import { Tip } from "./ui/Tip";

/** How the current selection was made. Keyboard selection gets the solid accent. */
export type SelectionSource = "keyboard" | "mouse";

interface Props {
  /** The search field, when the list has the window's search instead of the reader. */
  searchBar?: ReactNode;
  /** Actions for the selected rows, shown in place of the filter chips. */
  selectionBar?: ReactNode;
  /** Controls before everything else when the list is the window's leftmost pane. */
  leading?: ReactNode;
  /** Left padding that clears the traffic lights when the top row sits under them. */
  inset?: string | undefined;
  /** Connection or sync problems, above the rows. */
  notice?: ReactNode;
  /** The next step an empty list offers. */
  emptyActions?: EmptyActions;
  /** The name to show for an account id, in search errors. */
  accountLabel?: (accountId: string) => string;
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
  searchInputInvalid: boolean;
  searchIgnored: readonly string[];
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
  onSelect: (id: string, modifiers: { toggle: boolean; range: boolean }) => void;
  onEndReached: () => void;
  /** What a row's context menu needs; the same handlers as the reader toolbar. */
  rowActions: RowActions;
}

interface EmptyActions {
  onClearSearch: () => void;
  onCompose: () => void;
  onSync: () => void;
  /** A sync is running, so Sync now has nothing to start. */
  syncing: boolean;
}

interface RowActions {
  grouped?: boolean;
  currentLabel?: string | undefined;
  mailbox: Mailbox;
  /** User labels of every account. */
  labels: readonly Label[];
  stateOf: (thread: ThreadSummary) => ThreadState | null;
  onOp: (thread: ThreadSummary, state: ThreadState, op: MailOp) => void;
  onSwipeOp: (thread: ThreadSummary, state: ThreadState, op: MailOp) => void;
  onCompose: (
    thread: ThreadSummary,
    mode: "reply" | "replyAll" | "forward",
    asAttachment?: boolean,
  ) => void;
  /** Opens the thread in a window of its own; also on double-click. */
  onOpenWindow: (thread: ThreadSummary) => void;
  onSnooze: (thread: ThreadSummary) => void;
  onPermanentDelete?: ((thread: ThreadSummary) => void) | undefined;
  onFilter: (thread: ThreadSummary) => void;
  onCreate?: ((thread: ThreadSummary, move: boolean) => void) | undefined;
  batchMenu?: ReactNode;
}

export function MessageList({
  title,
  searchBar,
  selectionBar,
  leading,
  inset,
  notice,
  emptyActions,
  accountLabel = (accountId) => accountId,
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
}: Props) {
  const { t } = useLingui();
  const searchMessages = searchErrorAccounts.map(
    (accountId) =>
      `${accountLabel(accountId)}: ${searchReauthAccounts.includes(accountId) ? t`Sign in again` : t`The server could not complete this search.`}`,
  );
  /** The row under the pointer at the right-click, set before the menu opens. */
  const pressed = useRef<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const menuThread = threads.find((m) => m.id === menuFor);

  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const selectedIndex = threads.findIndex((m) => m.id === selectedId);
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
  const rowHeight =
    (threads.some((m) => m.derivedMatches?.length || attachmentMatches(m.searchMatches).length)
      ? density.height + 48
      : density.height) * textScale;
  const window = listWindow(threads.length, viewport.top, viewport.height, rowHeight);
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

  // Unmounted rows still have coordinates, so keyboard navigation can reach them.
  useEffect(() => {
    const el = listRef.current;
    if (!el || selectedIndex < 0 || selectionSource !== "keyboard") return constVoid;
    const top = selectedIndex * rowHeight;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowHeight > el.scrollTop + el.clientHeight)
      el.scrollTop = top + rowHeight - el.clientHeight;
    setViewport({ top: el.scrollTop, height: el.clientHeight });
    const frame = requestAnimationFrame(() => {
      for (const row of el.querySelectorAll<HTMLButtonElement>("[data-id]"))
        if (row.dataset.id === selectedId) {
          row.focus({ preventScroll: true });
          break;
        }
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedIndex, selectedId, selectionSource, rowHeight, listRef]);

  // Short first pages have no scrollbar. Ask for older mail once per list growth.
  useEffect(() => {
    if (!loading && threads.length * rowHeight - viewport.top - viewport.height < 400)
      endReached.current();
  }, [threads.length, loading, viewport.top, viewport.height, rowHeight]);

  return (
    <section
      aria-label={searching ? t`Search results` : title}
      className="flex h-full w-full flex-col bg-white dark:bg-neutral-900"
    >
      {searchBar && (
        <div className={`drag flex h-13 shrink-0 items-center gap-2 pr-4 ${inset ?? "pl-4"}`}>
          {leading}
          {searchBar}
        </div>
      )}
      <header
        className={`drag flex h-13 shrink-0 items-center gap-2 pr-3 ${inset && !searchBar ? inset : "pl-5"}`}
      >
        {!searchBar && leading}
        <h1 className="min-w-0 flex-1 truncate text-[17px] font-bold">
          {searching ? <Trans>Search results</Trans> : title}
        </h1>
        <div className="flex shrink-0 items-center gap-2">{folderActions}</div>
      </header>
      {/* One row at any width; chips that do not fit scroll sideways. The
          vertical padding keeps their focus ring inside the scroll box. */}
      <div className="-mt-1 flex shrink-0 items-center gap-1 overflow-x-auto px-3 pt-1 pb-2">
        {selectionBar}
        {!selectionBar && !searching && (
          <>
            <FilterChip
              active={filters.enabled}
              onChange={(enabled) => onFilters({ ...filters, enabled })}
              label={t`Filter`}
              tip={t`Enable filters`}
              shortcut="⌥⌘L"
            />
            <FilterChip
              active={filters.unread}
              onChange={(unread) => onFilters({ ...filters, unread, enabled: true })}
              label={t`Unread`}
              tip={t`Show only unread`}
            />
            <FilterChip
              active={filters.starred}
              onChange={(starred) => onFilters({ ...filters, starred, enabled: true })}
              label={t`Starred`}
              tip={t`Show only starred`}
            />
            <FilterChip
              active={filters.important}
              onChange={(important) => onFilters({ ...filters, important, enabled: true })}
              label={t`Important`}
              tip={t`Show important messages`}
            />
            {inLabel && (
              <FilterChip
                active={filters.inInbox}
                onChange={(inInbox) => onFilters({ ...filters, inInbox, enabled: true })}
                label={t`In Inbox`}
                tip={t`Show messages also in Inbox`}
              />
            )}
          </>
        )}
      </div>

      {notice}
      {searchingServer && (
        <output className="px-5 pb-2 text-[12px] text-a11y-muted">
          <Trans>Searching server…</Trans>
        </output>
      )}
      {searchTruncated && (
        <output className="px-5 pb-2 text-[12px] text-a11y-muted">
          <Trans>More matches exist. Narrow your search.</Trans>
        </output>
      )}
      {searchIgnored.length > 0 && (
        <output className="px-5 pb-2 text-[12px] text-orange-700 dark:text-orange-400">
          <Trans>
            Some server predicates were omitted to preserve matches; local filters still apply:
          </Trans>{" "}
          {searchIgnored.join("; ")}
        </output>
      )}
      {searchQuery && searchUsesSize(searchQuery) && (
        <output className="px-5 pb-2 text-[12px] text-orange-700 dark:text-orange-400">
          <Trans>Unknown message sizes are left unfiltered.</Trans>
        </output>
      )}
      {searchInputInvalid && (
        <output role="alert" className="px-5 pb-2 text-[12px] text-orange-700 dark:text-orange-400">
          <Trans>Simplify your search query.</Trans>
        </output>
      )}
      {searchErrorAccounts.length > 0 && (
        <output
          role="alert"
          title={searchMessages.join("\n")}
          className="px-5 pb-2 text-[12px] text-orange-700 dark:text-orange-400"
        >
          <Trans>Search could not finish:</Trans> {searchMessages.join("; ")}
        </output>
      )}
      {threads.length === 0 && !loading && (
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
              // A native select cannot host these windowed conversation previews.
              // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
              role="listbox"
              tabIndex={threads.length === 0 ? 0 : -1}
              aria-busy={loading}
              aria-multiselectable="true"
              aria-label={searching ? t`Search results` : title}
              onScroll={(e) => {
                const el = e.currentTarget;
                setViewport({ top: el.scrollTop, height: el.clientHeight });
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
          <div style={{ height: window.total, position: "relative" }}>
            <div style={{ transform: `translateY(${window.offset}px)` }}>
              {threads.slice(window.first, window.end).map((m, localIndex) => {
                const i = window.first + localIndex;
                return (
                  <Row
                    key={m.id}
                    thread={m}
                    rowHeight={rowHeight}
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
                    dragData={JSON.stringify({
                      ids: selectedIds.has(m.id)
                        ? threads.filter((row) => selectedIds.has(row.id)).map((row) => row.id)
                        : [m.id],
                      removeLabelId: moveSourceLabel(rowActions.mailbox, rowActions.currentLabel),
                      flat: !rowActions.grouped,
                    })}
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
              <Trans>Could not load older messages. Try again.</Trans>
            </p>
          )}
          {loadingMore ? (
            <>
              <span className="mr-2 inline-block size-3 animate-spin rounded-full border-2 border-current border-r-transparent" />
              <Trans>Loading older messages…</Trans>
            </>
          ) : exhausted ? (
            // An empty list already says so above.
            threads.length > 0 && <Trans>No more messages</Trans>
          ) : (
            <button type="button" onClick={onEndReached}>
              <Trans>Load older messages</Trans>
            </button>
          )}
        </output>
        {menuThread &&
          (selectedIds.has(menuThread.id) && selectedIds.size > 1 && rowActions.batchMenu ? (
            <ContextMenuContent>{rowActions.batchMenu}</ContextMenuContent>
          ) : (
            <RowMenu thread={menuThread} actions={rowActions} />
          ))}
      </ContextMenuRoot>
    </section>
  );
}

function RowMenu({ thread, actions }: { thread: ThreadSummary; actions: RowActions }) {
  const state = actions.stateOf(thread);
  if (!state) return null;
  return (
    <ContextMenuContent>
      <ThreadMenuItems
        state={state}
        mailbox={actions.mailbox}
        currentLabel={actions.currentLabel}
        labels={actions.labels.filter((l) => l.accountId === thread.accountId)}
        onCreate={actions.onCreate ? (move) => actions.onCreate?.(thread, move) : undefined}
        onOp={(op) => actions.onOp(thread, state, op)}
        onCompose={(mode, asAttachment) => actions.onCompose(thread, mode, asAttachment)}
        onSnooze={() => actions.onSnooze(thread)}
        onPermanentDelete={
          actions.onPermanentDelete ? () => actions.onPermanentDelete?.(thread) : undefined
        }
        onFilter={state.provider === "imap" ? undefined : () => actions.onFilter(thread)}
        onOpenWindow={() => actions.onOpenWindow(thread)}
      />
    </ContextMenuContent>
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
        className="h-6 shrink-0 rounded-full px-2.5 whitespace-nowrap text-[12px] font-medium text-a11y-muted outline-offset-1 outline-a11y-focus hover:bg-black/5 focus-visible:outline-[3px] data-pressed:bg-blue-600 data-pressed:text-white dark:hover:bg-white/10 dark:data-pressed:text-white"
      >
        {props.label}
      </Toggle>
    </Tip>
  );
}

/** "Keith, Bruce, Neil": first names of the thread's senders. */
function senders(t: ThreadSummary): string {
  const people = t.participants.length ? t.participants : [t.from];
  if (people.length === 1) return displayName(people[0]!);
  return people.map((p) => displayName(p).split(/\s+/)[0]).join(", ");
}

const Row = memo(function Row({
  thread: m,
  position,
  total,
  tabbable,
  rowHeight,
  density,
  labels,
  selected,
  accent,
  menuOpen,
  rule,
  showAccount,
  onSelect,
  onOpen,
  dragData,
  swipeActions,
  onSwipe,
}: {
  thread: ThreadSummary;
  rowHeight: number;
  density: (typeof LIST_DENSITIES)[keyof typeof LIST_DENSITIES];
  position: number;
  total: number;
  tabbable: boolean;
  labels: Map<string, Label>;
  selected: boolean;
  accent: boolean;
  /** The context menu is open for this row: outlined, as in macOS Mail. */
  menuOpen: boolean;
  rule: boolean;
  showAccount: boolean;
  onSelect: Props["onSelect"];
  /** Double-click: open in a window of its own. */
  onOpen: (thread: ThreadSummary) => void;
  dragData: string;
  swipeActions: Prefs["swipeActions"];
  onSwipe: (thread: ThreadSummary, action: SwipeAction) => void;
}) {
  const { i18n, t } = useLingui();
  const row = useRef<HTMLButtonElement>(null);
  const swipe = useMessageSwipe(row, swipeActions, (action) => onSwipe(m, action));
  const muted = accent ? "text-white" : "text-a11y-muted";
  const matchesId = useId();
  const attachmentHits = distinctAttachmentMatches(m.searchMatches).slice(0, 2);
  const derivedHits = m.searchMatches?.length ? [] : (m.derivedMatches?.slice(0, 2) ?? []);
  const hasHits = attachmentHits.length > 0 || derivedHits.length > 0;
  const chips = m.labels
    .flatMap((id) => labels.get(`${m.accountId}/${id}`) ?? [])
    .filter((l) => l.messageListVisibility !== "hide")
    .slice(0, 2);
  const labelChips = (
    <>
      {chips.map((l) => (
        <span
          key={l.id}
          className={`max-w-24 shrink-0 truncate rounded px-1.5 text-[12px] leading-[18px] ${
            accent
              ? "bg-black/20 text-white"
              : l.color
                ? "colored-label"
                : "bg-black/[0.06] dark:bg-white/10"
          }`}
          style={!accent && l.color ? labelChipColors(l.color) : undefined}
        >
          {l.name}
        </span>
      ))}
    </>
  );
  const star = (
    <>
      {m.isStarred && (
        <Star
          className={`size-3.5 shrink-0 ${accent ? "fill-white text-white" : "fill-amber-600 text-amber-600 dark:fill-amber-400 dark:text-amber-400"}`}
        />
      )}
    </>
  );
  return (
    <div className="relative overflow-hidden rounded-lg">
      {swipe.distance !== 0 && (
        <span
          className={`absolute inset-y-0 flex items-center px-3 text-xs font-medium ${swipe.distance < 0 ? "right-0" : "left-0"}`}
          aria-live="polite"
        >
          {i18n._(actionNames[swipe.action])}
        </span>
      )}
      <button
        ref={row}
        type="button"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(MESSAGE_DRAG, dragData);
          e.dataTransfer.effectAllowed = "move";
        }}
        data-id={m.id}
        // Keep the virtual conversation row clickable and expose its listbox position.
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
        role="option"
        style={{
          height: rowHeight,
          transform: swipe.distance
            ? `translateX(${Math.max(-100, Math.min(100, swipe.distance))}px)`
            : undefined,
        }}
        tabIndex={tabbable ? 0 : -1}
        aria-label={[
          senders(m),
          m.subject || t`(No subject)`,
          shortDate(m.date, i18n),
          ...(m.isUnread ? [t`Unread`] : []),
          ...(m.isStarred ? [t`Starred`] : []),
        ].join(", ")}
        aria-describedby={hasHits ? matchesId : undefined}
        aria-selected={selected}
        aria-setsize={total}
        aria-posinset={position}
        onClick={(event) =>
          onSelect(m.id, { toggle: event.metaKey || event.ctrlKey, range: event.shiftKey })
        }
        onDoubleClick={() => onOpen(m)}
        className={`motion-reduce:!transform-none relative block w-full overflow-hidden rounded-lg py-2.5 pr-3 pl-7 text-left ${
          menuOpen ? "ring-2 ring-blue-500 ring-inset" : ""
        } ${
          accent
            ? "bg-blue-600 text-white"
            : selected
              ? "bg-black/[0.07] dark:bg-white/10"
              : "hover:bg-black/[0.025] dark:hover:bg-white/[0.03]"
        }`}
      >
        <span className="sr-only">
          {m.isUnread && <Trans>Unread</Trans>} {m.isStarred && <Trans>Starred</Trans>}
        </span>
        {m.isUnread && (
          <span
            className={`absolute top-[16px] left-2.5 size-2 rounded-full ${accent ? "bg-white" : "bg-blue-500"}`}
          />
        )}
        <span className="flex items-baseline gap-1.5">
          <span className="min-w-0 truncate text-[14px] font-semibold">{senders(m)}</span>
          {m.threadCount > 1 && (
            <span className={`shrink-0 text-[13px] tabular-nums ${muted}`}>{m.threadCount}</span>
          )}
          <span className="flex-1" />
          {showAccount && <AccountBadge accountId={m.accountId} accent={accent} />}
          <span className={`shrink-0 text-[12px] tabular-nums ${muted}`}>
            {shortDate(m.date, i18n)}
          </span>
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[13px]">
          <span className="min-w-0 flex-1 truncate">
            {m.subject || <Trans>(No subject)</Trans>}
          </span>
          {!density.attachments && m.hasAttachments && (
            <Paperclip className={`size-3.5 shrink-0 ${muted}`} />
          )}
          {density.previewLines === 0 && (
            <>
              {labelChips}
              {star}
            </>
          )}
        </span>
        {density.previewLines > 0 && (
          <span className="mt-0.5 flex items-start gap-1.5">
            <span
              className={`min-w-0 flex-1 text-[13px] ${density.previewLines === 2 ? "line-clamp-2" : "truncate"} ${muted}`}
            >
              {previewText(m.snippet)}
            </span>
            {labelChips}
            {star}
          </span>
        )}
        {density.attachments && m.hasAttachments && (
          <span className={`mt-1 flex items-center gap-1.5 text-[11px] ${muted}`}>
            <Paperclip className="size-3.5 shrink-0" />
            {m.attachmentNames?.length ? (
              m.attachmentNames.slice(0, 2).map((name, index) => (
                <span
                  key={index}
                  className="max-w-32 truncate rounded bg-black/5 px-1 dark:bg-white/10"
                >
                  {name}
                </span>
              ))
            ) : (
              <Trans>Attachments</Trans>
            )}
          </span>
        )}
        {hasHits && (
          // The row's name is short; matches describe it, so a search says why the row matched.
          <span id={matchesId} className="block">
            {attachmentHits.map((match, index) => (
              <span key={index} className={`mt-1 block truncate text-[12px] ${muted}`}>
                <SearchSnippet match={match} lead={8} />
              </span>
            ))}
            {derivedHits.map((hit, index) => (
              <span key={index} className={`mt-1 block truncate text-[12px] ${muted}`}>
                {hit.source.kind === "body" ? (
                  <Trans
                    context="message text"
                    comment="Email message text, never an anatomical body."
                  >
                    Message body
                  </Trans>
                ) : (
                  hit.source.name
                )}
                {hit.page !== null && (
                  <>
                    {" "}
                    · <Trans>Page {hit.page}</Trans>
                  </>
                )}
                {hit.region !== null && (
                  <>
                    {" "}
                    · <Trans>Image region</Trans>
                  </>
                )}
                : {hit.text}
              </span>
            ))}
          </span>
        )}
        {rule && (
          <span className="absolute right-3 bottom-0 left-7 h-px bg-black/[0.06] dark:bg-white/[0.06]" />
        )}
      </button>
      <TriageChip id={m.id} accountId={m.accountId} labels={m.labels} compact />
    </div>
  );
});

/** Why the list is empty, with the step that changes it. */
function EmptyList({
  searching,
  filtered,
  mailbox,
  onClearFilters,
  actions,
}: {
  searching: boolean;
  filtered: boolean;
  mailbox: Mailbox;
  onClearFilters: () => void;
  actions: EmptyActions | undefined;
}) {
  let text: ReactNode = <Trans>No messages here</Trans>;
  let button: { label: ReactNode; onClick: () => void; disabled?: boolean } | undefined =
    actions && {
      label: <Trans>Sync now</Trans>,
      onClick: actions.onSync,
      disabled: actions.syncing,
    };
  if (searching) {
    text = <Trans>No matching messages</Trans>;
    button = actions && { label: <Trans>Clear search</Trans>, onClick: actions.onClearSearch };
  } else if (filtered) {
    text = <Trans>No messages match the filters</Trans>;
    button = { label: <Trans>Turn off filters</Trans>, onClick: onClearFilters };
  } else if (mailbox === "drafts") {
    text = <Trans>No drafts</Trans>;
    button = actions && { label: <Trans>New message</Trans>, onClick: actions.onCompose };
  } else if (mailbox === "starred") {
    text = <Trans>No starred messages. Star a message to find it here.</Trans>;
    button = undefined;
  }
  return (
    <div className="shrink-0 px-8 pt-8 pb-4 text-center text-a11y-muted">
      <p>{text}</p>
      {button && (
        // aria-disabled keeps focus on Sync now while a sync runs; disabled would drop it.
        <button
          type="button"
          onClick={button.disabled ? undefined : button.onClick}
          aria-disabled={button.disabled || undefined}
          className="mt-2 font-medium text-a11y-accent hover:underline aria-disabled:no-underline aria-disabled:opacity-50 dark:text-blue-400"
        >
          {button.label}
        </button>
      )}
    </div>
  );
}

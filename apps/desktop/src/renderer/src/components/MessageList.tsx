import { useMessageSwipe } from "../message-swipe-hook";
import { swipeMailOp } from "../message-swipe";
import { actionNames } from "./InteractionSettings";
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
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";

import type { Label, MailOp, Mailbox, ThreadSummary, ThreadQuery } from "../../../shared/api";
import { displayName, shortDate } from "../format";
import { AccountBadge } from "./AccountBadge";
import type { Filters } from "../view";
import { ContextMenuContent, ContextMenuRoot, ContextMenuTrigger } from "./ui/Menu";
import { ThreadMenuItems, type ThreadState } from "./ThreadActions";
import { Tip } from "./ui/Tip";

/** How the current selection was made. Keyboard selection gets the solid accent. */
export type SelectionSource = "keyboard" | "mouse";

interface Props {
  title: string;
  threads: readonly ThreadSummary[];
  loading: boolean;
  showAccount: boolean;
  searching: boolean;
  searchingServer: boolean;
  searchTruncated: boolean;
  searchErrors: readonly string[];
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

export interface RowActions {
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
  threads,
  loading,
  showAccount,
  searching,
  searchingServer,
  searchTruncated,
  searchErrors,
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
  /** The row under the pointer at the right-click, set before the menu opens. */
  const pressed = useRef<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const menuThread = threads.find((m) => m.id === menuFor);

  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const selectedIndex = threads.findIndex((m) => m.id === selectedId);
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  const density = LIST_DENSITIES[prefs.messageListDensity];
  const rowHeight = threads.some((m) => m.derivedMatches?.length)
    ? density.height + 48
    : density.height;
  const window = listWindow(threads.length, viewport.top, viewport.height, rowHeight);
  const endReached = useRef(onEndReached);
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
    <section className="flex h-full w-full flex-col bg-white dark:bg-neutral-900">
      <header className="drag flex h-13 shrink-0 items-center gap-2 pr-3 pl-5">
        <h1 className="min-w-0 flex-1 truncate text-[17px] font-bold">
          {searching ? <Trans>Search results</Trans> : title}
        </h1>
        {folderActions}
      </header>
      <div className="flex shrink-0 flex-wrap items-center gap-1 px-3 pb-2">
        {!searching && (
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

      {searchingServer && (
        <output className="px-5 pb-2 text-[12px] text-neutral-500">
          <Trans>Searching server…</Trans>
        </output>
      )}
      {searchTruncated && (
        <output className="px-5 pb-2 text-[12px] text-neutral-500">
          <Trans>More matches exist. Narrow your search.</Trans>
        </output>
      )}
      {searchIgnored.length > 0 && (
        <output className="px-5 pb-2 text-[12px] text-orange-500">
          <Trans>
            Some server predicates were omitted to preserve matches; local filters still apply:
          </Trans>{" "}
          {searchIgnored.join("; ")}
        </output>
      )}
      {searchQuery && searchUsesSize(searchQuery) && (
        <output className="px-5 pb-2 text-[12px] text-orange-500">
          <Trans>Unknown message sizes are left unfiltered.</Trans>
        </output>
      )}
      {searchErrors.length > 0 && (
        <output title={searchErrors.join("\n")} className="px-5 pb-2 text-[12px] text-orange-500">
          <Trans>Search could not finish:</Trans> {searchErrors.join("; ")}
        </output>
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
              tabIndex={-1}
              aria-multiselectable="true"
              aria-label={searching ? t`Search results` : title}
              onScroll={(e) => {
                const el = e.currentTarget;
                setViewport({ top: el.scrollTop, height: el.clientHeight });
              }}
              onContextMenuCapture={(e) => {
                const row = e.target instanceof Element ? e.target.closest("[data-id]") : null;
                pressed.current = row?.getAttribute("data-id") ?? null;
              }}
              className="flex-1 overflow-y-auto px-2 pb-2"
            />
          }
        >
          {threads.length === 0 && !loading && (
            <p className="p-8 text-center text-neutral-400">
              {searching ? (
                <Trans>No matching messages</Trans>
              ) : filters.enabled &&
                (filters.unread || filters.starred || filters.important || filters.inInbox) ? (
                <Trans>No messages match the filters</Trans>
              ) : (
                <Trans>No messages here</Trans>
              )}
            </p>
          )}
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
                    total={threads.length}
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
                    onSelect={(event) =>
                      onSelect(m.id, {
                        toggle: event.metaKey || event.ctrlKey,
                        range: event.shiftKey,
                      })
                    }
                    dragData={JSON.stringify({
                      ids: selectedIds.has(m.id)
                        ? threads.filter((row) => selectedIds.has(row.id)).map((row) => row.id)
                        : [m.id],
                      removeLabelId: moveSourceLabel(rowActions.mailbox, rowActions.currentLabel),
                      flat: !rowActions.grouped,
                    })}
                    onOpen={() => rowActions.onOpenWindow(m)}
                    swipeActions={prefs.swipeActions}
                    onSwipe={(action) => {
                      if (action === "snooze") {
                        rowActions.onSnooze(m);
                        return;
                      }
                      const state = rowActions.stateOf(m);
                      const op = state && swipeMailOp(action, state);
                      if (state && op) rowActions.onSwipeOp(m, state, op);
                    }}
                  />
                );
              })}
            </div>
          </div>
        </ContextMenuTrigger>
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
        className="h-6 shrink-0 rounded-full px-2.5 text-[12px] font-medium text-neutral-500 outline-offset-1 outline-blue-500/60 hover:bg-black/5 focus-visible:outline-[3px] data-pressed:bg-blue-600 data-pressed:text-white dark:text-neutral-400 dark:hover:bg-white/10 dark:data-pressed:text-white"
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

function Row({
  thread: m,
  position,
  total,
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
  labels: Map<string, Label>;
  selected: boolean;
  accent: boolean;
  /** The context menu is open for this row: outlined, as in macOS Mail. */
  menuOpen: boolean;
  rule: boolean;
  showAccount: boolean;
  onSelect: (event: MouseEvent<HTMLButtonElement>) => void;
  /** Double-click: open in a window of its own. */
  onOpen: () => void;
  dragData: string;
  swipeActions: Prefs["swipeActions"];
  onSwipe: (action: SwipeAction) => void;
}) {
  const { i18n } = useLingui();
  const row = useRef<HTMLButtonElement>(null);
  const swipe = useMessageSwipe(row, swipeActions, onSwipe);
  const muted = accent ? "text-white/75" : "text-neutral-500 dark:text-neutral-400";
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
            accent ? "bg-white/20 text-white" : l.color ? "" : "bg-black/[0.06] dark:bg-white/10"
          }`}
          style={
            !accent && l.color ? { backgroundColor: `${l.color}33`, color: l.color } : undefined
          }
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
          className={`size-3.5 shrink-0 ${accent ? "fill-white text-white" : "fill-amber-400 text-amber-400"}`}
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
        aria-selected={selected}
        aria-setsize={total}
        aria-posinset={position}
        onClick={onSelect}
        onDoubleClick={onOpen}
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
          {showAccount && <AccountBadge accountId={m.accountId} />}
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
              {m.snippet}
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
        {m.derivedMatches?.slice(0, 2).map((hit, index) => (
          <span key={index} className={`mt-1 block truncate text-[12px] ${muted}`}>
            {hit.source.kind === "body" ? <Trans>Message body</Trans> : hit.source.name}
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
        {rule && (
          <span className="absolute right-3 bottom-0 left-7 h-px bg-black/[0.06] dark:bg-white/[0.06]" />
        )}
      </button>
    </div>
  );
}

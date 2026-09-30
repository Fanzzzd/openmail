import { Toggle } from "@base-ui/react/toggle";
import { Trans, useLingui } from "@lingui/react/macro";
import { Paperclip, Star } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { Label, MailOp, Mailbox, ThreadSummary } from "../../../shared/api";
import { avatarColor, displayName, shortDate } from "../format";
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
  filters: Filters;
  onFilters: (f: Filters) => void;
  /** User labels by `${accountId}/${labelId}`, for the chips on each row. */
  labels: Map<string, Label>;
  selectedId: string | null;
  selectionSource: SelectionSource;
  onSelect: (id: string) => void;
  onEndReached: () => void;
  /** What a row's context menu needs; the same handlers as the reader toolbar. */
  rowActions: RowActions;
}

export interface RowActions {
  mailbox: Mailbox;
  /** User labels of every account. */
  labels: readonly Label[];
  stateOf: (thread: ThreadSummary) => ThreadState | null;
  onOp: (thread: ThreadSummary, state: ThreadState, op: MailOp) => void;
  onCompose: (
    thread: ThreadSummary,
    mode: "reply" | "replyAll" | "forward",
    asAttachment?: boolean,
  ) => void;
  /** Opens the thread in a window of its own; also on double-click. */
  onOpenWindow: (thread: ThreadSummary) => void;
  onSnooze: (thread: ThreadSummary) => void;
  onFilter: (thread: ThreadSummary) => void;
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
  filters,
  onFilters,
  labels,
  selectedId,
  selectionSource,
  onSelect,
  onEndReached,
  rowActions,
}: Props) {
  const { t } = useLingui();
  const listRef = useRef<HTMLDivElement>(null);
  /** The row under the pointer at the right-click, set before the menu opens. */
  const pressed = useRef<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const menuThread = threads.find((m) => m.id === menuFor);

  // Keep the keyboard selection in view.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-id="${CSS.escape(selectedId ?? "")}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const selectedIndex = threads.findIndex((m) => m.id === selectedId);

  return (
    <section className="flex h-full w-full flex-col bg-white dark:bg-neutral-900">
      <header className="drag flex h-13 shrink-0 items-center gap-2 pr-3 pl-5">
        <h1 className="min-w-0 flex-1 truncate text-[17px] font-bold">
          {searching ? <Trans>Search results</Trans> : title}
        </h1>
        {!searching && (
          <>
            <FilterChip
              active={filters.unread}
              onChange={(unread) => onFilters({ ...filters, unread })}
              label={t`Unread`}
              tip={t`Show only unread`}
              shortcut="⌥⌘L"
            />
            <FilterChip
              active={filters.starred}
              onChange={(starred) => onFilters({ ...filters, starred })}
              label={t`Starred`}
              tip={t`Show only starred`}
            />
          </>
        )}
      </header>

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
      {searchErrors.length > 0 && (
        <output title={searchErrors.join("\n")} className="px-5 pb-2 text-[12px] text-orange-500">
          <Trans>Server search failed. Local results are available.</Trans>
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
              onScroll={(e) => {
                const el = e.currentTarget;
                if (el.scrollHeight - el.scrollTop - el.clientHeight < 400) onEndReached();
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
              ) : filters.unread || filters.starred ? (
                <Trans>No messages match the filters</Trans>
              ) : (
                <Trans>No messages here</Trans>
              )}
            </p>
          )}
          {threads.map((m, i) => (
            <Row
              key={m.id}
              thread={m}
              labels={labels}
              selected={i === selectedIndex}
              accent={i === selectedIndex && selectionSource === "keyboard"}
              menuOpen={m.id === menuFor}
              // Mimestream drops the rule under the selected row and under the row above it.
              rule={i < threads.length - 1 && i !== selectedIndex && i !== selectedIndex - 1}
              showAccount={showAccount}
              onSelect={() => onSelect(m.id)}
              onOpen={() => rowActions.onOpenWindow(m)}
            />
          ))}
        </ContextMenuTrigger>
        {menuThread && <RowMenu thread={menuThread} actions={rowActions} />}
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
        labels={actions.labels.filter((l) => l.accountId === thread.accountId)}
        onOp={(op) => actions.onOp(thread, state, op)}
        onCompose={(mode, asAttachment) => actions.onCompose(thread, mode, asAttachment)}
        onSnooze={() => actions.onSnooze(thread)}
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
  labels,
  selected,
  accent,
  menuOpen,
  rule,
  showAccount,
  onSelect,
  onOpen,
}: {
  thread: ThreadSummary;
  labels: Map<string, Label>;
  selected: boolean;
  accent: boolean;
  /** The context menu is open for this row: outlined, as in macOS Mail. */
  menuOpen: boolean;
  rule: boolean;
  showAccount: boolean;
  onSelect: () => void;
  /** Double-click: open in a window of its own. */
  onOpen: () => void;
}) {
  const { i18n } = useLingui();
  const muted = accent ? "text-white/75" : "text-neutral-500 dark:text-neutral-400";
  const chips = m.labels.flatMap((id) => labels.get(`${m.accountId}/${id}`) ?? []).slice(0, 2);
  return (
    <button
      type="button"
      data-id={m.id}
      onClick={onSelect}
      onDoubleClick={onOpen}
      className={`relative block w-full rounded-lg py-2.5 pr-3 pl-7 text-left ${
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
        {showAccount && (
          <span
            className={`size-1.5 shrink-0 self-center rounded-full ${avatarColor(m.accountId.split(":")[1] ?? "")}`}
          />
        )}
        <span className={`shrink-0 text-[12px] tabular-nums ${muted}`}>
          {shortDate(m.date, i18n)}
        </span>
      </span>
      <span className="mt-0.5 block truncate text-[13px]">
        {m.subject || <Trans>(No subject)</Trans>}
      </span>
      <span className="mt-0.5 flex items-center gap-1.5">
        <span className={`min-w-0 flex-1 truncate text-[13px] ${muted}`}>{m.snippet}</span>
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
        {m.hasAttachments && <Paperclip className={`size-3.5 shrink-0 ${muted}`} />}
        {m.isStarred && (
          <Star
            className={`size-3.5 shrink-0 ${accent ? "fill-white text-white" : "fill-amber-400 text-amber-400"}`}
          />
        )}
      </span>
      {rule && (
        <span className="absolute right-3 bottom-0 left-7 h-px bg-black/[0.06] dark:bg-white/[0.06]" />
      )}
    </button>
  );
}

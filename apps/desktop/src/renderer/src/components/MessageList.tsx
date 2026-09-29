import { Trans, useLingui } from "@lingui/react/macro";
import { Paperclip, Star } from "lucide-react";
import { useEffect, useRef } from "react";

import type { Label, ThreadSummary } from "../../../shared/api";
import { avatarColor, displayName, shortDate } from "../format";
import type { Filters } from "../view";

/** How the current selection was made. Keyboard selection gets the solid accent. */
export type SelectionSource = "keyboard" | "mouse";

interface Props {
  title: string;
  threads: readonly ThreadSummary[];
  loading: boolean;
  showAccount: boolean;
  searching: boolean;
  filters: Filters;
  onFilters: (f: Filters) => void;
  /** User labels by `${accountId}/${labelId}`, for the chips on each row. */
  labels: Map<string, Label>;
  selectedId: string | null;
  selectionSource: SelectionSource;
  onSelect: (id: string) => void;
  onEndReached: () => void;
}

export function MessageList({
  title,
  threads,
  loading,
  showAccount,
  searching,
  filters,
  onFilters,
  labels,
  selectedId,
  selectionSource,
  onSelect,
  onEndReached,
}: Props) {
  const { t } = useLingui();
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the keyboard selection in view.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-id="${CSS.escape(selectedId ?? "")}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const selectedIndex = threads.findIndex((m) => m.id === selectedId);

  return (
    <section className="flex w-[380px] shrink-0 flex-col border-r border-black/5 bg-white dark:border-white/5 dark:bg-neutral-900">
      <header className="drag flex h-13 shrink-0 items-center gap-2 pr-3 pl-5">
        <h1 className="min-w-0 flex-1 truncate text-[17px] font-bold">
          {searching ? <Trans>Search results</Trans> : title}
        </h1>
        {!searching && (
          <>
            <FilterChip
              active={filters.unread}
              onClick={() => onFilters({ ...filters, unread: !filters.unread })}
              label={t`Unread`}
              title={t`Show only unread (⌥⌘L)`}
            />
            <FilterChip
              active={filters.starred}
              onClick={() => onFilters({ ...filters, starred: !filters.starred })}
              label={t`Starred`}
              title={t`Show only starred`}
            />
          </>
        )}
      </header>

      <div
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 400) onEndReached();
        }}
        className="flex-1 overflow-y-auto px-2 pb-2"
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
            // Mimestream drops the rule under the selected row and under the row above it.
            rule={i < threads.length - 1 && i !== selectedIndex && i !== selectedIndex - 1}
            showAccount={showAccount}
            onSelect={() => onSelect(m.id)}
          />
        ))}
      </div>
    </section>
  );
}

function FilterChip(props: { active: boolean; onClick: () => void; label: string; title: string }) {
  return (
    <button
      type="button"
      title={props.title}
      onClick={props.onClick}
      className={`h-6 shrink-0 rounded-full px-2.5 text-[12px] font-medium ${
        props.active
          ? "bg-blue-600 text-white"
          : "text-neutral-500 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/10"
      }`}
    >
      {props.label}
    </button>
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
  rule,
  showAccount,
  onSelect,
}: {
  thread: ThreadSummary;
  labels: Map<string, Label>;
  selected: boolean;
  accent: boolean;
  rule: boolean;
  showAccount: boolean;
  onSelect: () => void;
}) {
  const { i18n } = useLingui();
  const muted = accent ? "text-white/75" : "text-neutral-500 dark:text-neutral-400";
  const chips = m.labels.flatMap((id) => labels.get(`${m.accountId}/${id}`) ?? []).slice(0, 2);
  return (
    <button
      type="button"
      data-id={m.id}
      onClick={onSelect}
      className={`relative block w-full rounded-lg py-2.5 pr-3 pl-7 text-left ${
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

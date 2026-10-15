import type { Label, MailOp, Mailbox, ThreadSummary } from "../../../../shared/api";
import type { ThreadState } from "../../lib/focused-inbox";
import { memo, useId, useRef, type ReactNode } from "react";
import { ContextMenuContent } from "../../ui/Menu";
import { MESSAGE_DRAG, ThreadMenuItems } from "../organize";
import { displayName, shortDate } from "../../lib/format";
import {
  providerCapabilities,
  type LIST_DENSITIES,
  type Prefs,
  type SwipeAction,
} from "@openmail/core/schema";
import { msg, plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useMessageSwipe } from "./message-swipe-hook";
import { MatchedText, SearchPreview, SearchSnippet, distinctAttachmentMatches } from "../search";
import { labelChipColors } from "../../lib/label-colors";
import { Paperclip, Star } from "lucide-react";
import { actionNames } from "../../i18n/action-names";
import { AccountBadge, useAccountName } from "./AccountBadge";
import { TriageChip, TriageMenuItems, TriageSummary } from "../ai";

/** Opens a row, or adds it to the selection with ⌘ (toggle) or ⇧ (range). */
export type SelectRow = (id: string, modifiers: { toggle: boolean; range: boolean }) => void;

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

export function RowMenu({ thread, actions }: { thread: ThreadSummary; actions: RowActions }) {
  const { t } = useLingui();
  const state = actions.stateOf(thread);
  if (!state) return null;
  return (
    <ContextMenuContent label={t`Conversation actions`}>
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
        onFilter={
          providerCapabilities(state.provider).rules ? () => actions.onFilter(thread) : undefined
        }
        onOpenWindow={() => actions.onOpenWindow(thread)}
      />
      <TriageMenuItems id={thread.id} accountId={thread.accountId} labels={thread.labels} />
    </ContextMenuContent>
  );
}

/** Marks a selected row while the list is not focused, in both themes. */
export const SELECTION_BAR = "bg-neutral-500 dark:bg-neutral-400";

/** "Keith, Bruce, Neil": first names of the thread's senders. */
function senders(t: ThreadSummary): string {
  const people = t.participants.length ? t.participants : [t.from];
  if (people.length === 1) return displayName(people[0]!);
  return people.map((p) => displayName(p).split(/\s+/)[0]).join(", ");
}

export const Row = memo(function Row({
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
  onSelect: SelectRow;
  /** Double-click: open in a window of its own. */
  onOpen: (thread: ThreadSummary) => void;
  dragData: string;
  swipeActions: Prefs["swipeActions"];
  onSwipe: (thread: ThreadSummary, action: SwipeAction) => void;
}) {
  const { i18n, t } = useLingui();
  const accountLabel = useAccountName(m.accountId);
  const messageCount = m.threadCount;
  const row = useRef<HTMLButtonElement>(null);
  const swipe = useMessageSwipe(row, swipeActions, (action) => onSwipe(m, action));
  const muted = accent ? "text-white" : "text-a11y-muted";
  const matchesId = useId();
  const previewId = useId();
  const attachmentHits = distinctAttachmentMatches(m.searchMatches).slice(0, 2);
  const derivedHits = m.searchMatches?.length ? [] : (m.derivedMatches?.slice(0, 2) ?? []);
  const hasHits = attachmentHits.length > 0 || derivedHits.length > 0;
  // A search says why each row matched: the fields and marked text, then attachment hits.
  const searched = !!m.searchMatches?.length || !!m.related;
  const describedBy = [
    ...(searched && density.previewLines > 0 ? [previewId] : []),
    ...(hasHits ? [matchesId] : []),
  ].join(" ");
  const chips = m.labels
    .flatMap((id) => labels.get(`${m.accountId}/${id}`) ?? [])
    .filter((l) => l.messageListVisibility !== "hide")
    .slice(0, 2);
  const labelChips = (
    <>
      {chips.map((l) => (
        <span
          key={l.id}
          className={`max-w-24 shrink-0 truncate rounded px-1.5 text-footnote leading-[18px] ${
            accent ? "bg-black/20 text-white" : l.color ? "colored-label" : "bg-fill-hover"
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
    <div className="relative overflow-hidden rounded-card">
      {swipe.distance !== 0 && (
        <span
          className={`absolute inset-y-0 flex items-center px-3 text-footnote font-medium ${swipe.distance < 0 ? "right-0" : "left-0"}`}
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
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- an option element holds only text; the row holds the preview markup.
        role="option"
        style={{
          height: rowHeight,
          transform: swipe.distance
            ? `translateX(${Math.max(-100, Math.min(100, swipe.distance))}px)`
            : undefined,
        }}
        tabIndex={tabbable ? 0 : -1}
        aria-describedby={describedBy || undefined}
        aria-selected={selected}
        aria-setsize={total}
        aria-posinset={position}
        onClick={(event) =>
          onSelect(m.id, { toggle: event.metaKey || event.ctrlKey, range: event.shiftKey })
        }
        onDoubleClick={() => onOpen(m)}
        // Content centres in the fixed row height, so rows without an attachment line keep even margins.
        className={`motion-reduce:!transform-none relative flex w-full flex-col justify-center overflow-hidden rounded-card py-2 pr-3 pl-7 text-left ${
          menuOpen ? "ring-2 ring-blue-500 ring-inset" : ""
        } ${
          accent ? "bg-blue-600 text-white" : selected ? "bg-fill-pressed" : "hover:bg-fill-quiet"
        }`}
      >
        {/* The name comes from this summary, sender and subject first as on screen. The
            visible text is hidden from it so the preview is not read on every row; a search
            reads the preview and its hits as the description. */}
        <span className="sr-only">
          {[
            senders(m),
            m.subject || t`(No subject)`,
            shortDate(m.date, i18n),
            ...(messageCount > 1
              ? // The component's i18n, not the global one, which a window may not activate.
                [i18n._(msg`${plural(messageCount, { one: "# message", other: "# messages" })}`)]
              : []),
            ...(m.isUnread ? [t`Unread`] : []),
            ...(m.isStarred ? [t`Starred`] : []),
            ...(m.hasAttachments ? [t`Has attachments`] : []),
            ...chips.map((label) => label.name),
            ...(showAccount ? [accountLabel] : []),
          ].join(", ")}
          <TriageSummary id={m.id} accountId={m.accountId} labels={m.labels} />
        </span>
        <span aria-hidden className="relative flex items-baseline gap-1.5">
          {m.isUnread && (
            <span
              className={`absolute top-1/2 -left-[18px] size-2 -translate-y-1/2 rounded-full ${accent ? "bg-white" : "bg-blue-500"}`}
            />
          )}
          <span className="min-w-0 truncate text-callout font-semibold">{senders(m)}</span>
          {m.threadCount > 1 && (
            <span className={`shrink-0 text-body tabular-nums ${muted}`}>{m.threadCount}</span>
          )}
          <span className="flex-1" />
          {showAccount && <AccountBadge accountId={m.accountId} accent={accent} />}
          <span className={`shrink-0 text-footnote tabular-nums ${muted}`}>
            {shortDate(m.date, i18n)}
          </span>
        </span>
        <span aria-hidden className="mt-0.5 flex items-center gap-1.5 text-body">
          <span className="min-w-0 flex-1 truncate">
            {m.subject ? (
              <MatchedText
                text={m.subject}
                match={m.searchMatches?.find((match) => match.source === "subject")}
              />
            ) : (
              <Trans>(No subject)</Trans>
            )}
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
          <span aria-hidden className="mt-0.5 flex items-start gap-1.5">
            <span
              id={previewId}
              className={`min-w-0 flex-1 text-body ${density.previewLines === 2 ? "line-clamp-2" : "truncate"} ${muted}`}
            >
              <SearchPreview thread={m} lead={density.previewLines === 2 ? undefined : 24} />
            </span>
            {labelChips}
            {star}
          </span>
        )}
        {density.attachments && m.hasAttachments && (
          <span aria-hidden className={`mt-1 flex items-center gap-1.5 text-caption ${muted}`}>
            <Paperclip className="size-3.5 shrink-0" />
            {m.attachmentNames?.length ? (
              m.attachmentNames.slice(0, 2).map((name, index) => (
                <span key={index} className="max-w-32 truncate rounded bg-fill-hover px-1">
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
          <span id={matchesId} aria-hidden className="block">
            {attachmentHits.map((match, index) => (
              <span key={index} className={`mt-1 block truncate text-footnote ${muted}`}>
                <SearchSnippet match={match} lead={8} />
              </span>
            ))}
            {derivedHits.map((hit, index) => (
              <span key={index} className={`mt-1 block truncate text-footnote ${muted}`}>
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
        {selected && !accent && (
          // The pale selection fill alone is 1.2:1 against the list; this bar is over 3:1.
          <span
            aria-hidden
            data-selection-bar
            className={`absolute inset-y-2 left-1 w-[3px] rounded-full ${SELECTION_BAR}`}
          />
        )}
        {rule && <span className="absolute right-3 bottom-0 left-7 h-px bg-separator" />}
      </button>
      <TriageChip id={m.id} accountId={m.accountId} labels={m.labels} compact />
    </div>
  );
});

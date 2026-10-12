import { useAtomValue } from "@effect/atom-react";
import { useLingui } from "@lingui/react/macro";
import { DEFAULT_PREFS, specialFolderBadge } from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import { Layers, LayoutGrid, PanelLeft, SquarePen } from "lucide-react";
import type { ReactNode } from "react";
import type { Account, Mailbox, Profile } from "../../../../shared/api";
import { PROFILE_BG } from "../../lib/format";
import { prefsAtom } from "../../state/queries";
import { useShortcutText } from "../../i18n/use-shortcut-text";
import {
  ALL,
  MAILBOX_NAMES,
  OVERVIEW,
  type SpaceId,
  spaceAccounts,
  type View,
} from "../../lib/view";
import { MAILBOXES, spaceShortcutLabel, useMailboxCounts } from "./Sidebar";
import { Tip } from "../../ui/Tip";

/** The mailboxes the rail shows, in the sidebar's order. The drawer has the rest. */
const RAIL_MAILBOXES = new Set<Mailbox>(["snoozed", "inbox", "starred", "sent", "drafts"]);

const cell = (active: boolean) =>
  `relative flex size-9 shrink-0 items-center justify-center rounded-lg outline-offset-0 outline-a11y-focus focus-visible:outline-[3px] ${
    active
      ? "bg-white shadow-sm ring-1 ring-black/10 dark:bg-white/15 dark:ring-white/10"
      : "hover:bg-black/5 dark:hover:bg-white/10"
  }`;

interface Props {
  view: View;
  accounts: readonly Account[];
  profiles: readonly Profile[];
  /** Unread counts by account id. */
  unread: Readonly<Record<string, number>>;
  onView: (view: View) => void;
  onSpace: (space: SpaceId) => void;
  onOpenSidebar: () => void;
  onCompose: () => void;
}

/**
 * The sidebar as a column of icons, docked in the medium layout where the
 * full sidebar does not fit. Main mailboxes and spaces show with unread
 * badges; the first button opens the full sidebar as a drawer.
 */
export function SidebarRail({
  view,
  accounts,
  profiles,
  unread,
  onView,
  onSpace,
  onOpenSidebar,
  onCompose,
}: Props) {
  const { t, i18n } = useLingui();
  const shortcut = useShortcutText();
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  const counts = useMailboxCounts(view, accounts);
  const spaceUnread = (space: SpaceId) =>
    spaceAccounts(space, accounts).reduce((n, a) => n + (unread[a.id] ?? 0), 0);

  return (
    <div
      data-mail-pane="sidebar"
      data-sidebar-rail
      className="flex h-full w-14 shrink-0 flex-col items-center border-r border-black/[0.07] bg-neutral-100/60 dark:border-white/[0.08] dark:bg-neutral-950/70"
    >
      {/* The traffic lights sit in this strip. */}
      <div className="drag h-13 w-full shrink-0" />
      <div className="flex shrink-0 flex-col items-center gap-1 pb-2">
        <Tip label={t`Show sidebar`} shortcut={shortcut("toggleSidebar")} side="right">
          <button
            type="button"
            aria-label={t`Show sidebar`}
            onClick={onOpenSidebar}
            className={`${cell(false)} text-a11y-muted`}
          >
            <PanelLeft className="size-4.5" />
          </button>
        </Tip>
        <Tip label={t`New message`} shortcut={shortcut("compose")} side="right">
          <button
            type="button"
            aria-label={t`New message`}
            onClick={onCompose}
            className={`${cell(false)} text-a11y-muted`}
          >
            <SquarePen className="size-4.5" />
          </button>
        </Tip>
      </div>
      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-3 overflow-y-auto border-t border-black/5 pt-2 pb-2 dark:border-white/5">
        <nav aria-label={t`Mailboxes`} className="flex flex-col items-center gap-1">
          {MAILBOXES.filter(({ id }) => RAIL_MAILBOXES.has(id)).map(({ id, icon: Icon, color }) => (
            <RailButton
              key={id}
              label={i18n._(MAILBOX_NAMES[id])}
              current={
                view.space !== OVERVIEW && view.mailbox === id && !view.label ? "page" : undefined
              }
              badge={specialFolderBadge(id, counts, prefs.specialFolderBadges)}
              onClick={() => onView({ ...view, mailbox: id, label: undefined })}
            >
              <Icon className={`size-4.5 ${color}`} />
            </RailButton>
          ))}
        </nav>
        <fieldset
          aria-label={t`Spaces`}
          className="mt-auto flex min-w-0 flex-col items-center gap-1 border-t border-black/5 pt-2 dark:border-white/5"
        >
          <RailButton
            label={t`Overview`}
            shortcut="⌃1"
            current={view.space === OVERVIEW || undefined}
            badge={0}
            onClick={() => onSpace(OVERVIEW)}
          >
            <LayoutGrid className="size-4 text-neutral-600 dark:text-neutral-300" />
          </RailButton>
          <RailButton
            label={t`All accounts`}
            shortcut="⌃2"
            current={view.space === ALL || undefined}
            badge={spaceUnread(ALL)}
            onClick={() => onSpace(ALL)}
          >
            <Layers className="size-4 text-neutral-600 dark:text-neutral-300" />
          </RailButton>
          {profiles.map((p, i) => (
            <RailButton
              key={p.id}
              label={p.name}
              shortcut={spaceShortcutLabel(prefs.shortcutSet, i)}
              current={view.space === p.id || undefined}
              badge={spaceUnread(p.id)}
              onClick={() => onSpace(p.id)}
            >
              <span
                className={`flex size-6 items-center justify-center rounded-full text-[13px] ${PROFILE_BG[p.color]}`}
              >
                {p.icon}
              </span>
            </RailButton>
          ))}
        </fieldset>
      </div>
    </div>
  );
}

/** An icon with a tooltip and an unread badge. The name is the label, then the full count. */
function RailButton({
  label,
  shortcut,
  current,
  badge,
  onClick,
  children,
}: {
  label: string;
  shortcut?: string | undefined;
  current: "page" | true | undefined;
  badge: number;
  onClick: () => void;
  children: ReactNode;
}) {
  const { i18n } = useLingui();
  return (
    <Tip label={label} shortcut={shortcut} side="right">
      <button
        type="button"
        aria-current={current}
        onClick={onClick}
        className={cell(Boolean(current))}
      >
        <span aria-hidden className="flex">
          {children}
        </span>
        <span className="sr-only">
          {label}
          {badge > 0 && ` ${i18n.number(badge)}`}
        </span>
        {badge > 0 && (
          <span
            aria-hidden
            className="absolute -top-1 -right-1.5 min-w-4 rounded-full bg-blue-600 px-1 text-center text-[10px] leading-4 font-semibold text-white tabular-nums"
          >
            {badge > 99 ? `${i18n.number(99)}+` : i18n.number(badge)}
          </span>
        )}
      </button>
    </Tip>
  );
}

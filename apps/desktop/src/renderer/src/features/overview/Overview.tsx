import { useAtomValue } from "@effect/atom-react";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { AsyncResult } from "effect/reactivity";
import { CircleAlert, Layers, Pencil, Plus, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

import type { Account, Profile, SyncState } from "../../../../shared/api";
import {
  accountName,
  accountColorClass,
  accountColorStyle,
  displayName,
  PROFILE_BG,
  shortDate,
} from "../../lib/format";
import { syncNow, useRunMail } from "../../state/mail";
import { unreadInboxAtom } from "../../state/queries";
import { ALL, type SpaceId } from "../../lib/view";
import { Tip } from "../../ui/Tip";

interface Group {
  space: SpaceId;
  profile?: Profile;
  title: string;
  accounts: Account[];
}

interface Props {
  accounts: readonly Account[];
  profiles: readonly Profile[];
  unread: Record<string, number>;
  syncState: SyncState;
  onOpen: (space: SpaceId, messageId?: string) => void;
  onEditProfile: (profile: Profile | "new") => void;
  /** Controls before the title when the overview is the leftmost pane. */
  leading?: ReactNode;
  /** Left padding that clears the traffic lights when the header sits under them. */
  inset?: string | undefined;
}

/**
 * Every space on one screen: unread counts, sync health per account, and the
 * newest unread conversations. Accounts outside any profile form their own group.
 */
export function Overview({
  accounts,
  profiles,
  unread,
  syncState,
  onOpen,
  onEditProfile,
  leading,
  inset,
}: Props) {
  accounts = accounts.filter((a) => a.enabled !== false);
  const { t, i18n } = useLingui();
  const run = useRunMail();
  const groups: Group[] = profiles.map((p) => ({
    space: p.id,
    profile: p,
    title: p.name,
    accounts: accounts.filter((a) => a.profileId === p.id),
  }));
  const ungrouped = accounts.filter((a) => !a.profileId);
  if (ungrouped.length) {
    groups.push({
      space: ALL,
      title: profiles.length ? t`Ungrouped` : t`All accounts`,
      accounts: ungrouped,
    });
  }
  const total = i18n.number(accounts.reduce((n, a) => n + (unread[a.id] ?? 0), 0));
  const accountCount = accounts.length;

  return (
    <main className="flex h-full w-full min-w-0 flex-col bg-surface">
      <header
        className={`drag flex h-13 shrink-0 items-center gap-3 pr-4 sm:pr-7 ${inset ?? "pl-4 sm:pl-7"}`}
      >
        {leading}
        <h1 className="shrink-0 text-title font-bold">
          <Trans>Overview</Trans>
        </h1>
        <span className="min-w-0 truncate text-body text-a11y-muted">
          {t`${plural(accountCount, { one: "# account", other: "# accounts" })}, ${total} unread`}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => run(syncNow)}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-control border border-edge px-2.5 text-body hover:bg-fill-hover"
        >
          <RefreshCw className={`size-3.5 ${syncState.running ? "animate-spin" : ""}`} />
          <span className="max-sm:sr-only">
            <Trans>Sync All</Trans>
          </span>
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 pb-10 sm:px-7">
        {profiles.length === 0 && (
          <div className="mb-6 flex items-center gap-4 rounded-sheet border border-dashed border-edge p-4">
            <p className="flex-1 text-body leading-relaxed text-neutral-600 dark:text-neutral-300">
              <Trans>
                Group accounts into spaces, like “Work” and “Personal”. Each space has its own
                inbox. Switch with ⌃1 to ⌃9.
              </Trans>
            </p>
            <button
              type="button"
              onClick={() => onEditProfile("new")}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-control bg-blue-600 px-3 text-body font-medium text-white"
            >
              <Plus className="size-4" />
              <Trans>New space</Trans>
            </button>
          </div>
        )}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(320px,100%),1fr))] gap-4">
          {groups.map((g) => (
            <GroupCard
              key={g.profile?.id ?? "ungrouped"}
              group={g}
              unread={unread}
              onOpen={onOpen}
              onEdit={g.profile ? () => onEditProfile(g.profile!) : undefined}
            />
          ))}
        </div>
      </div>
    </main>
  );
}

function GroupCard({
  group,
  unread,
  onOpen,
  onEdit,
}: {
  group: Group;
  unread: Record<string, number>;
  onOpen: Props["onOpen"];
  onEdit?: () => void;
}) {
  const { t, i18n } = useLingui();
  const ids = group.accounts.map((a) => a.id);
  const threads = AsyncResult.getOrElse(useAtomValue(unreadInboxAtom(ids)), () => null);
  const unreadCount = group.accounts.reduce((n, a) => n + (unread[a.id] ?? 0), 0);
  const count = i18n.number(unreadCount);

  return (
    <section className="flex flex-col rounded-sheet border border-separator">
      <header className="flex items-center gap-2.5 px-4 pt-3.5 pb-2">
        {group.profile ? (
          <span
            className={`flex size-7 items-center justify-center rounded-full text-headline ${PROFILE_BG[group.profile.color]}`}
          >
            {group.profile.icon}
          </span>
        ) : (
          <span className="flex size-7 items-center justify-center rounded-full bg-neutral-500 text-white">
            <Layers className="size-4" />
          </span>
        )}
        <button
          type="button"
          onClick={() => onOpen(group.space)}
          className="min-w-0 flex-1 truncate text-left text-headline font-semibold hover:underline"
        >
          {group.title}
        </button>
        {unreadCount > 0 && (
          <span className="text-body text-a11y-muted tabular-nums">
            <Trans>{count} unread</Trans>
          </span>
        )}
        {onEdit && (
          <Tip label={t`Edit space`}>
            <button
              type="button"
              aria-label={t`Edit space`}
              onClick={onEdit}
              className="rounded p-1 text-a11y-muted hover:bg-fill-hover"
            >
              <Pencil className="size-3.5" />
            </button>
          </Tip>
        )}
      </header>

      <ul className="px-4 pb-2">
        {group.accounts.length === 0 && (
          <li className="py-1 text-body text-a11y-muted">
            <Trans>No accounts yet</Trans>
          </li>
        )}
        {group.accounts.map((a) => (
          <li key={a.id} className="flex items-center gap-2 py-1 text-body">
            <span
              className={`size-2 shrink-0 rounded-full ${accountColorClass(a)}`}
              style={accountColorStyle(a)}
            />
            <span className="min-w-0 flex-1 truncate">{accountName(a)}</span>
            {a.lastSyncError ? (
              <span
                className="flex shrink-0 items-center gap-1 text-a11y-danger"
                title={a.lastSyncError}
              >
                <CircleAlert className="size-3.5" />
                <Trans>Sync failed</Trans>
              </span>
            ) : (
              <span className="shrink-0 text-footnote text-a11y-muted">
                {a.lastSyncedAt ? shortDate(a.lastSyncedAt, i18n) : t`Not synced`}
              </span>
            )}
            <span className="w-6 shrink-0 text-right text-a11y-muted tabular-nums">
              {unread[a.id] ? i18n.number(unread[a.id] ?? 0) : ""}
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-auto border-t border-separator px-2 py-1.5">
        {threads?.length === 0 && (
          <p className="px-2 py-2 text-body text-a11y-muted">
            <Trans>No unread mail in the inbox</Trans>
          </p>
        )}
        {threads?.map((thread) => (
          <button
            key={thread.id}
            type="button"
            onClick={() => onOpen(group.space, thread.id)}
            className="flex w-full items-baseline gap-2 rounded-control px-2 py-1.5 text-left text-body hover:bg-fill-hover"
          >
            <span className="w-24 shrink-0 truncate font-semibold">{displayName(thread.from)}</span>
            <span className="min-w-0 flex-1 truncate">{thread.subject || t`(No subject)`}</span>
            <span className="shrink-0 text-footnote text-a11y-muted tabular-nums">
              {shortDate(thread.date, i18n)}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

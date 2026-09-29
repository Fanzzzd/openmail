import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { CircleAlert, Layers, Pencil, Plus, RefreshCw } from "lucide-react";

import type { Account, Profile, SyncState } from "../../../shared/api";
import { avatarColor, displayName, PROFILE_BG, shortDate } from "../format";
import { syncNow, useRunMail } from "../state/mail";
import { unreadInboxAtom } from "../state/queries";
import { ALL, type SpaceId } from "../view";

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
}

/**
 * Every space on one screen: unread counts, sync health per account, and the
 * newest unread conversations. Accounts outside any profile form their own group.
 */
export function Overview({ accounts, profiles, unread, syncState, onOpen, onEditProfile }: Props) {
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
      title: profiles.length ? "未分组" : "全部账户",
      accounts: ungrouped,
    });
  }
  const total = accounts.reduce((n, a) => n + (unread[a.id] ?? 0), 0);

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-white dark:bg-neutral-900">
      <header className="drag flex h-13 shrink-0 items-center gap-3 px-7">
        <h1 className="text-[17px] font-bold">总览</h1>
        <span className="text-[13px] text-neutral-500">
          {accounts.length} 个账户，{total} 封未读
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => run(syncNow)}
          className="flex h-7 items-center gap-1.5 rounded-md border border-black/10 px-2.5 text-[13px] hover:bg-black/[0.03] dark:border-white/10 dark:hover:bg-white/5"
        >
          <RefreshCw className={`size-3.5 ${syncState.running ? "animate-spin" : ""}`} />
          同步全部
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-7 pb-10">
        {profiles.length === 0 && (
          <div className="mb-6 flex items-center gap-4 rounded-xl border border-dashed border-black/15 p-4 dark:border-white/15">
            <p className="flex-1 text-[13px] leading-relaxed text-neutral-600 dark:text-neutral-300">
              把账户分进空间，比如「工作」和「个人」。每个空间有自己的收件箱，用 ⌃1 到 ⌃9 切换。
            </p>
            <button
              type="button"
              onClick={() => onEditProfile("new")}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-blue-600 px-3 text-[13px] font-medium text-white"
            >
              <Plus className="size-4" />
              新建空间
            </button>
          </div>
        )}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-4">
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
  const ids = group.accounts.map((a) => a.id);
  const threads = AsyncResult.getOrElse(useAtomValue(unreadInboxAtom(ids)), () => null);
  const count = group.accounts.reduce((n, a) => n + (unread[a.id] ?? 0), 0);

  return (
    <section className="flex flex-col rounded-xl border border-black/[0.08] dark:border-white/10">
      <header className="flex items-center gap-2.5 px-4 pt-3.5 pb-2">
        {group.profile ? (
          <span
            className={`flex size-7 items-center justify-center rounded-full text-[15px] ${PROFILE_BG[group.profile.color]}`}
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
          className="min-w-0 flex-1 truncate text-left text-[15px] font-semibold hover:underline"
        >
          {group.title}
        </button>
        {count > 0 && (
          <span className="text-[13px] text-neutral-500 tabular-nums">{count} 未读</span>
        )}
        {onEdit && (
          <button
            type="button"
            title="编辑空间"
            onClick={onEdit}
            className="rounded p-1 text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10"
          >
            <Pencil className="size-3.5" />
          </button>
        )}
      </header>

      <ul className="px-4 pb-2">
        {group.accounts.length === 0 && (
          <li className="py-1 text-[13px] text-neutral-400">还没有账户</li>
        )}
        {group.accounts.map((a) => (
          <li key={a.id} className="flex items-center gap-2 py-1 text-[13px]">
            <span className={`size-2 shrink-0 rounded-full ${avatarColor(a.email)}`} />
            <span className="min-w-0 flex-1 truncate">{a.email}</span>
            {a.lastSyncError ? (
              <span
                className="flex shrink-0 items-center gap-1 text-red-500"
                title={a.lastSyncError}
              >
                <CircleAlert className="size-3.5" />
                同步失败
              </span>
            ) : (
              <span className="shrink-0 text-[12px] text-neutral-400">
                {a.lastSyncedAt ? shortDate(a.lastSyncedAt) : "未同步"}
              </span>
            )}
            <span className="w-6 shrink-0 text-right text-neutral-500 tabular-nums">
              {unread[a.id] || ""}
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-auto border-t border-black/[0.06] px-2 py-1.5 dark:border-white/[0.08]">
        {threads?.length === 0 && (
          <p className="px-2 py-2 text-[13px] text-neutral-400">收件箱没有未读</p>
        )}
        {threads?.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onOpen(group.space, t.id)}
            className="flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-black/[0.04] dark:hover:bg-white/5"
          >
            <span className="w-24 shrink-0 truncate font-semibold">{displayName(t.from)}</span>
            <span className="min-w-0 flex-1 truncate">{t.subject || "（无主题）"}</span>
            <span className="shrink-0 text-[12px] text-neutral-400 tabular-nums">
              {shortDate(t.date)}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

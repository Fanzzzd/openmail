import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";

import type { Account, AgentWriteMode } from "../../../shared/api";
import { resultError } from "../errors";
import { Keys } from "../state/keys";
import { reauthAtom, removeAccountAtom, setAgentModeAtom } from "../state/mutations";
import { agentModeAtom, auditAtom } from "../state/queries";
import { ProviderIcon } from "./ProviderIcon";

type Tab = "accounts" | "ai" | "log";

const TABS: { id: Tab; label: string }[] = [
  { id: "accounts", label: "账户" },
  { id: "ai", label: "AI 权限" },
  { id: "log", label: "操作记录" },
];

interface Props {
  accounts: readonly Account[];
  initialTab?: Tab;
  onClose: () => void;
  onAddAccount: () => void;
}

export function Settings({ accounts, initialTab = "accounts", onClose, onAddAccount }: Props) {
  const [tab, setTab] = useState<Tab>(initialTab);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        aria-label="设置"
        className="flex h-[520px] w-[640px] flex-col overflow-hidden rounded-xl bg-white text-[13px] shadow-2xl dark:bg-neutral-800"
      >
        <nav className="flex shrink-0 justify-center gap-1 border-b border-black/[0.07] py-2 dark:border-white/[0.08]">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`h-7 rounded-md px-3 font-medium ${
                tab === t.id
                  ? "bg-black/[0.07] dark:bg-white/10"
                  : "text-neutral-500 hover:bg-black/[0.04] dark:text-neutral-400 dark:hover:bg-white/5"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {tab === "accounts" && <Accounts accounts={accounts} onAddAccount={onAddAccount} />}
          {tab === "ai" && <AgentPolicy />}
          {tab === "log" && <AuditLog accounts={accounts} />}
        </div>
      </section>
    </div>
  );
}

function Accounts({
  accounts,
  onAddAccount,
}: {
  accounts: readonly Account[];
  onAddAccount: () => void;
}) {
  return (
    <div>
      <ul className="divide-y divide-black/[0.07] rounded-lg border border-black/10 dark:divide-white/[0.08] dark:border-white/10">
        {accounts.map((a) => (
          <AccountRow key={a.id} account={a} onAddAccount={onAddAccount} />
        ))}
      </ul>
      <button
        type="button"
        onClick={onAddAccount}
        className="mt-3 h-7 rounded-md border border-black/10 px-3 font-medium hover:bg-black/[0.04] dark:border-white/15 dark:hover:bg-white/5"
      >
        添加邮箱
      </button>
    </div>
  );
}

function AccountRow({ account: a, onAddAccount }: { account: Account; onAddAccount: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [reauth, runReauth] = useAtom(reauthAtom(a.id));
  const [remove, runRemove] = useAtom(removeAccountAtom(a.id));

  const status = a.needsReauth
    ? { text: "需要重新登录", className: "text-red-500" }
    : a.lastSyncError
      ? { text: "上次同步失败", className: "text-orange-500" }
      : { text: "正常", className: "text-neutral-400" };

  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <ProviderIcon provider={a.imap?.preset ?? a.provider} className="size-5 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{a.email}</span>
        <span
          className={`block truncate text-[12px] ${status.className}`}
          title={a.lastSyncError ?? undefined}
        >
          {reauth.waiting ? "请在浏览器里完成授权" : (resultError(reauth) ?? status.text)}
        </span>
      </span>
      <button
        type="button"
        disabled={reauth.waiting}
        // IMAP signs in again by adding the same address with a new password.
        onClick={() => (a.provider === "imap" ? onAddAccount() : runReauth())}
        className="h-7 shrink-0 rounded-md px-2.5 text-blue-600 hover:bg-blue-500/10 disabled:opacity-50 dark:text-blue-400"
      >
        重新登录
      </button>
      {confirming ? (
        <button
          type="button"
          disabled={remove.waiting}
          onClick={() => runRemove()}
          onBlur={() => setConfirming(false)}
          className="h-7 shrink-0 rounded-md bg-red-600 px-2.5 font-medium text-white hover:bg-red-700"
        >
          确认移除
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          title="从 openmail 移除这个账户和它的本地邮件。服务器上的邮件不受影响。"
          className="h-7 shrink-0 rounded-md px-2.5 text-red-600 hover:bg-red-500/10 dark:text-red-400"
        >
          移除
        </button>
      )}
    </li>
  );
}

const MODES: { id: AgentWriteMode; label: string; detail: string }[] = [
  {
    id: "off",
    label: "只读",
    detail: "AI 能读邮件、搜索，不能改动任何东西。",
  },
  {
    id: "propose",
    label: "先问我",
    detail: "AI 想归档、打标签、标已读时，先放进「AI 建议」，你确认后才执行。",
  },
  {
    id: "allow",
    label: "直接整理",
    detail: "AI 可以直接归档、打标签、标已读。每次改动都记在操作记录里，可以撤销。",
  },
];

function AgentPolicy() {
  const mode = AsyncResult.getOrElse(useAtomValue(agentModeAtom), () => null);
  const setMode = useAtomSet(setAgentModeAtom);

  return (
    <div>
      <p className="text-neutral-500 dark:text-neutral-400">
        AI 通过 MCP 连接 openmail，比如 Claude Code。这里决定它能不能改动邮件。
      </p>
      <fieldset className="mt-4 space-y-2">
        <legend className="sr-only">AI 改动邮件的权限</legend>
        {MODES.map((m) => (
          <label
            key={m.id}
            aria-label={m.label}
            className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${
              mode === m.id
                ? "border-blue-500 bg-blue-500/5"
                : "border-black/10 dark:border-white/10"
            }`}
          >
            <input
              type="radio"
              name="agent-mode"
              checked={mode === m.id}
              onChange={() =>
                setMode({ payload: { mode: m.id }, reactivityKeys: [Keys.agentMode, Keys.audit] })
              }
              className="mt-0.5 accent-blue-600"
            />
            <span>
              <span className="block font-medium">{m.label}</span>
              <span className="block text-neutral-500 dark:text-neutral-400">{m.detail}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <p className="mt-4 text-neutral-500 dark:text-neutral-400">
        发信不受这个设置影响。AI 写的邮件都会进「AI 建议」，由你在写信窗口里检查后发出。
      </p>
    </div>
  );
}

const ACTION_NAMES: Record<string, string> = {
  read: "标记已读/未读",
  star: "星标",
  important: "重要",
  archive: "归档",
  inbox: "移回收件箱",
  trash: "删除",
  spam: "报告垃圾邮件",
  label: "标签",
  send: "发送",
  send_failed: "发送失败",
  proposed: "提出建议",
  approve: "确认建议",
  reject: "拒绝建议",
  denied: "被拒绝",
  removeAccount: "移除账户",
};

function actorName(actor: string): string {
  if (actor.startsWith("user:")) return actor === "user:cli" ? "你（命令行）" : "你";
  return `AI（${actor.split(":").slice(2).join(":") || "未知"}）`;
}

function AuditLog({ accounts }: { accounts: readonly Account[] }) {
  const log = AsyncResult.getOrElse(useAtomValue(auditAtom), () => []);
  const email = (id: string | null) => accounts.find((a) => a.id === id)?.email ?? "";
  if (!log.length) return <p className="text-neutral-400">还没有操作记录。</p>;
  return (
    <table className="w-full text-left">
      <thead className="text-[12px] text-neutral-400">
        <tr>
          <th className="pb-2 font-medium">时间</th>
          <th className="pb-2 font-medium">谁</th>
          <th className="pb-2 font-medium">操作</th>
          <th className="pb-2 font-medium">账户</th>
        </tr>
      </thead>
      <tbody>
        {log.map((e, i) => (
          <tr key={i} className="border-t border-black/[0.06] dark:border-white/[0.06]">
            <td className="py-1.5 pr-3 whitespace-nowrap text-neutral-500 tabular-nums">
              {new Date(e.at).toLocaleString("zh-CN", {
                month: "numeric",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </td>
            <td className="py-1.5 pr-3 whitespace-nowrap">{actorName(e.actor)}</td>
            <td className="py-1.5 pr-3">{ACTION_NAMES[e.action] ?? e.action}</td>
            <td className="max-w-40 truncate py-1.5 text-neutral-500">{email(e.accountId)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

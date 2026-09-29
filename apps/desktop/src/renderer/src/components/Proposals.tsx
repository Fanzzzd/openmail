import { useAtom, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Sparkles, X } from "lucide-react";
import { useEffect } from "react";

import type { Account, MailOp, Proposal } from "../../../shared/api";
import { formatAddress } from "../draft";
import { resultError } from "../errors";
import { decideAtom } from "../state/mutations";
import { threadAtom } from "../state/queries";

const OP_NAMES: Record<MailOp["kind"], (op: MailOp) => string> = {
  read: (op) => (op.kind === "read" && op.value ? "标为已读" : "标为未读"),
  star: (op) => (op.kind === "star" && op.value ? "加星标" : "去掉星标"),
  important: (op) => (op.kind === "important" && op.value ? "标为重要" : "取消重要"),
  archive: () => "归档",
  inbox: () => "移回收件箱",
  trash: () => "删除",
  spam: () => "报告垃圾邮件",
  label: (op) => (op.kind === "label" && op.value ? "加标签" : "去掉标签"),
};

interface Props {
  proposals: readonly Proposal[];
  accounts: readonly Account[];
  onClose: () => void;
  /** Opens a proposed message in the compose window; sending it approves the proposal. */
  onOpenDraft: (proposal: Proposal) => void;
}

/** Changes and messages agents asked for. Nothing here runs until a person approves it. */
export function Proposals({ proposals, accounts, onClose, onOpenDraft }: Props) {
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
        aria-label="AI 建议"
        className="flex max-h-[600px] w-[600px] flex-col overflow-hidden rounded-xl bg-white text-[13px] shadow-2xl dark:bg-neutral-800"
      >
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-black/[0.07] px-5 dark:border-white/[0.08]">
          <Sparkles className="size-4 text-violet-500" />
          <h2 className="flex-1 text-[15px] font-semibold">AI 建议</h2>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="rounded p-1 text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10"
          >
            <X className="size-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {proposals.length === 0 ? (
            <p className="p-8 text-center text-neutral-400">没有待确认的建议。</p>
          ) : (
            <ul className="divide-y divide-black/[0.07] dark:divide-white/[0.08]">
              {proposals.map((p) => (
                <Item key={p.id} proposal={p} accounts={accounts} onOpenDraft={onOpenDraft} />
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

function Item({
  proposal: p,
  accounts,
  onOpenDraft,
}: {
  proposal: Proposal;
  accounts: readonly Account[];
  onOpenDraft: (proposal: Proposal) => void;
}) {
  const [decide, runDecide] = useAtom(decideAtom(p.id));
  const error = resultError(decide);
  const { command } = p;
  const threadIds = command.kind === "modify" ? command.threads.slice(0, 5) : [];
  const agent = p.actor.kind === "agent" ? p.actor : null;
  const email = (id: string) => accounts.find((a) => a.id === id)?.email ?? id;

  return (
    <li className="px-5 py-4">
      <p className="text-[12px] text-neutral-500 dark:text-neutral-400">
        {agent?.name ?? "AI"} ·{" "}
        {new Date(p.createdAt).toLocaleString("zh-CN", {
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })}
      </p>
      {command.kind === "modify" && (
        <>
          <p className="mt-1 font-medium">
            {OP_NAMES[command.op.kind](command.op)} {command.threads.length} 个会话
          </p>
          <ul className="mt-1 space-y-0.5 text-neutral-600 dark:text-neutral-300">
            {threadIds.map((id) => (
              <ThreadSubject key={id} id={id} />
            ))}
            {command.threads.length > threadIds.length && (
              <li className="text-neutral-400">
                还有 {command.threads.length - threadIds.length} 个
              </li>
            )}
          </ul>
        </>
      )}
      {(command.kind === "send" || command.kind === "draft") && (
        <>
          <p className="mt-1 font-medium">
            从 {email(command.accountId)} 发给{" "}
            {command.message.to.map(formatAddress).join(", ") || "（未填收件人）"}
          </p>
          <p className="mt-0.5 truncate">{command.message.subject || "（无主题）"}</p>
          <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-neutral-500 dark:text-neutral-400">
            {command.message.text}
          </p>
        </>
      )}
      {agent?.rationale && (
        <p className="mt-2 rounded-md bg-violet-500/[0.07] px-2.5 py-1.5 text-violet-700 dark:text-violet-300">
          {agent.rationale}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        {command.kind === "modify" ? (
          <button
            type="button"
            disabled={decide.waiting}
            onClick={() => runDecide(true)}
            className="h-7 rounded-md bg-blue-600 px-3 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            执行
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onOpenDraft(p)}
            className="h-7 rounded-md bg-blue-600 px-3 font-medium text-white hover:bg-blue-700"
          >
            检查并发送
          </button>
        )}
        <button
          type="button"
          disabled={decide.waiting}
          onClick={() => runDecide(false)}
          className="h-7 rounded-md px-3 text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/10"
        >
          拒绝
        </button>
        {error && <span className="self-center text-red-500">{error}</span>}
      </div>
    </li>
  );
}

function ThreadSubject({ id }: { id: string }) {
  const thread = AsyncResult.getOrElse(useAtomValue(threadAtom(id)), () => []);
  return <li className="truncate">{thread.at(-1)?.subject || "（无主题）"}</li>;
}

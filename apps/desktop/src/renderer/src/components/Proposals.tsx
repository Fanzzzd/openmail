import { useAtom, useAtomValue } from "@effect/atom-react";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { AsyncResult } from "effect/reactivity";
import { Sparkles, X } from "lucide-react";
import { useEffect } from "react";

import type { Account, MailOp, Proposal } from "../../../shared/api";
import { formatAddress } from "../draft";
import { resultError } from "../errors";
import { decideAtom } from "../state/mutations";
import { threadAtom } from "../state/queries";

const OP_NAMES: Record<MailOp["kind"], (op: MailOp) => MessageDescriptor> = {
  read: (op) => (op.kind === "read" && op.value ? msg`Mark as read` : msg`Mark as unread`),
  star: (op) => (op.kind === "star" && op.value ? msg`Add star` : msg`Remove star`),
  important: (op) =>
    op.kind === "important" && op.value ? msg`Mark as important` : msg`Mark as not important`,
  archive: () => msg`Archive`,
  inbox: () => msg`Move to Inbox`,
  trash: () => msg`Delete`,
  spam: () => msg`Report spam`,
  label: (op) => (op.kind === "label" && op.value ? msg`Add label` : msg`Remove label`),
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
  const { t } = useLingui();
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
      className="no-drag fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        aria-label={t`AI suggestions`}
        className="flex max-h-[600px] w-[600px] flex-col overflow-hidden rounded-xl bg-white text-[13px] shadow-2xl dark:bg-neutral-800"
      >
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-black/[0.07] px-5 dark:border-white/[0.08]">
          <Sparkles className="size-4 text-violet-500" />
          <h2 className="flex-1 text-[15px] font-semibold">
            <Trans>AI suggestions</Trans>
          </h2>
          <button
            type="button"
            aria-label={t`Close`}
            onClick={onClose}
            className="rounded p-1 text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10"
          >
            <X className="size-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {proposals.length === 0 ? (
            <p className="p-8 text-center text-neutral-400">
              <Trans>No suggestions waiting for review.</Trans>
            </p>
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
  const { t, i18n } = useLingui();
  const [decide, runDecide] = useAtom(decideAtom(p.id));
  const error = resultError(i18n, decide);
  const { command } = p;
  const threadIds = command.kind === "modify" ? command.threads.slice(0, 5) : [];
  const agent = p.actor.kind === "agent" ? p.actor : null;
  const email = (id: string) => accounts.find((a) => a.id === id)?.email ?? id;
  const count = command.kind === "modify" ? command.threads.length : 0;
  const op = command.kind === "modify" ? i18n._(OP_NAMES[command.op.kind](command.op)) : "";
  const more = count - threadIds.length;
  const outgoing = command.kind === "send" || command.kind === "draft" ? command : null;
  const from = outgoing ? email(outgoing.accountId) : "";
  const to = outgoing
    ? outgoing.message.to.map(formatAddress).join(", ") || t`(no recipients)`
    : "";

  return (
    <li className="px-5 py-4">
      <p className="text-[12px] text-neutral-500 dark:text-neutral-400">
        {agent?.name ?? "AI"} ·{" "}
        {new Date(p.createdAt).toLocaleString(i18n.locale, {
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })}
      </p>
      {command.kind === "modify" && (
        <>
          <p className="mt-1 font-medium">
            {t`${op} ${plural(count, { one: "# conversation", other: "# conversations" })}`}
          </p>
          <ul className="mt-1 space-y-0.5 text-neutral-600 dark:text-neutral-300">
            {threadIds.map((id) => (
              <ThreadSubject key={id} id={id} />
            ))}
            {more > 0 && (
              <li className="text-neutral-400">
                <Trans>{more} more</Trans>
              </li>
            )}
          </ul>
        </>
      )}
      {(command.kind === "send" || command.kind === "draft") && (
        <>
          <p className="mt-1 font-medium">
            <Trans>
              From {from} to {to}
            </Trans>
          </p>
          <p className="mt-0.5 truncate">{command.message.subject || t`(No subject)`}</p>
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
            <Trans>Run</Trans>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onOpenDraft(p)}
            className="h-7 rounded-md bg-blue-600 px-3 font-medium text-white hover:bg-blue-700"
          >
            <Trans>Review and Send</Trans>
          </button>
        )}
        <button
          type="button"
          disabled={decide.waiting}
          onClick={() => runDecide(false)}
          className="h-7 rounded-md px-3 text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/10"
        >
          <Trans>Reject</Trans>
        </button>
        {error && <span className="self-center text-red-500">{error}</span>}
      </div>
    </li>
  );
}

function ThreadSubject({ id }: { id: string }) {
  const { t } = useLingui();
  const thread = AsyncResult.getOrElse(useAtomValue(threadAtom(id)), () => []);
  return <li className="truncate">{thread.at(-1)?.subject || t`(No subject)`}</li>;
}

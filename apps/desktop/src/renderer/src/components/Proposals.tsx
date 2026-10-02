import { Effect } from "effect";
import { useRunMail, withMail } from "../state/mail";
import { useAtom, useAtomValue } from "@effect/atom-react";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { AsyncResult } from "effect/reactivity";
import { Sparkles, X } from "lucide-react";

import type { Account, MailOp, OutgoingMessage, Proposal } from "../../../shared/api";
import { formatAddress } from "../draft";
import { resultError } from "../errors";
import { decideAtom } from "../state/mutations";
import { labelsAtom, threadAtom } from "../state/queries";
import { Dialog } from "./ui/Dialog";

const OP_NAMES: Record<MailOp["kind"], (op: MailOp) => MessageDescriptor> = {
  read: (op) => (op.kind === "read" && op.value ? msg`Mark as read` : msg`Mark as unread`),
  star: (op) => (op.kind === "star" && op.value ? msg`Add star` : msg`Remove star`),
  important: (op) =>
    op.kind === "important" && op.value ? msg`Mark as important` : msg`Mark as not important`,
  archive: () => msg`Archive`,
  inbox: () => msg`Move to Inbox`,
  trash: () => msg`Delete`,
  spam: () => msg`Report spam`,
  move: () => msg`Moved`,
  categories: () => msg`Categories updated`,
  copy: () => msg`Copied to folders`,
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
  return (
    <Dialog
      aria-label={t`AI suggestions`}
      onClose={onClose}
      className="flex max-h-[min(600px,calc(100vh-40px))] w-[600px] flex-col overflow-hidden"
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
    </Dialog>
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
  const run = useRunMail();
  const builtIn =
    p.actor.kind === "agent" && p.actor.surface === "rule" && p.actor.name === "openmail-assistant";
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
  const from = outgoing
    ? outgoing.message.from
      ? formatAddress(outgoing.message.from)
      : email(outgoing.accountId)
    : "";
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
              <ThreadSubject
                key={id}
                id={id}
                labelId={command.op.kind === "label" ? command.op.labelId : undefined}
              />
            ))}
            {more > 0 && (
              <li className="text-neutral-400">
                <Trans>{more} more</Trans>
              </li>
            )}
          </ul>
        </>
      )}
      {outgoing && (
        <>
          <p className="mt-1 font-medium">
            <Trans>
              From {from} to {to}
            </Trans>
          </p>
          <DraftDetails message={outgoing.message} />
          <p className="mt-0.5 whitespace-pre-wrap break-words">
            {outgoing.message.subject || t`(No subject)`}
          </p>
          <textarea
            aria-label={t({
              message: "Draft body",
              context: "message text",
              comment: "Text of a draft email, never an anatomical body.",
            })}
            readOnly
            rows={8}
            value={outgoing.message.text}
            className="mt-1 block max-h-64 w-full resize-y overflow-y-auto rounded border border-black/10 bg-transparent p-2 whitespace-pre-wrap break-words text-neutral-500 dark:border-white/10 dark:text-neutral-400"
          />
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
            <Trans>Approve</Trans>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              if (builtIn)
                run(
                  withMail((call) => call("DecideProposal", { id: p.id, approve: true })).pipe(
                    Effect.tap(() => Effect.sync(() => onOpenDraft(p))),
                    Effect.catchCause(() => Effect.void),
                  ),
                );
              else onOpenDraft(p);
            }}
            className="h-7 rounded-md bg-blue-600 px-3 font-medium text-white hover:bg-blue-700"
          >
            {builtIn ? <Trans>Approve and edit</Trans> : <Trans>Review and Send</Trans>}
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

function ThreadSubject({ id, labelId }: { id: string; labelId?: string }) {
  const { t } = useLingui();
  const thread = AsyncResult.getOrElse(useAtomValue(threadAtom(id)), () => []);
  const labels = AsyncResult.getOrElse(useAtomValue(labelsAtom()), () => []);
  const label = labels.find(
    (item) => item.id === labelId && item.accountId === thread[0]?.accountId,
  );
  const name = label?.name ?? labelId;
  return (
    <li className="break-words">
      {thread.at(-1)?.subject || t`(No subject)`}
      {labelId && <span className="ml-2 text-neutral-500">{t`Label: ${name}`}</span>}
    </li>
  );
}

const COMPOSE_MODES = {
  new: msg`New message`,
  reply: msg`Reply`,
  replyAll: msg`Reply all`,
  forward: msg`Forward`,
};
function DraftDetails({ message }: { message: OutgoingMessage }) {
  const { t, i18n } = useLingui();
  const target = AsyncResult.getOrElse(
    useAtomValue(threadAtom(message.inReplyTo ?? null)),
    () => [],
  );
  const subject =
    target.find((item) => item.id === message.inReplyTo)?.subject ??
    t`Original message unavailable`;
  const mode = message.mode ?? (message.inReplyTo ? "reply" : "new");
  return (
    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 break-words">
      <dt>
        <Trans>Cc</Trans>
      </dt>
      <dd>{message.cc.map(formatAddress).join(", ") || t`None`}</dd>
      <dt>
        <Trans>Bcc</Trans>
      </dt>
      <dd>{message.bcc.map(formatAddress).join(", ") || t`None`}</dd>
      <dt>
        <Trans>Mode</Trans>
      </dt>
      <dd>{i18n._(COMPOSE_MODES[mode])}</dd>
      {message.inReplyTo && (
        <>
          <dt>
            <Trans>Original message</Trans>
          </dt>
          <dd>
            {subject} [{message.inReplyTo}]
          </dd>
        </>
      )}
    </dl>
  );
}

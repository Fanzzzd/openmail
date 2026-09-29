import { useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { AsyncResult } from "effect/reactivity";
import { Mail, Paperclip, Search, Star } from "lucide-react";
import { type ReactNode, type RefObject, useState } from "react";

import type { Message } from "../../../shared/api";
import { avatarColor, displayName, formatBytes, threadDate } from "../format";
import { threadAtom } from "../state/queries";
import { EmailFrame } from "./EmailFrame";

interface Props {
  messageId: string | null;
  query: string;
  onQuery: (q: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  /** Actions for the open thread, left of the search field. */
  toolbar?: ReactNode;
  /** Opens a draft of the thread in the compose window, by local draft id or message id. */
  onEditDraft: (messageId: string) => void;
}

export function Reader({ messageId, query, onQuery, searchRef, toolbar, onEditDraft }: Props) {
  const { t } = useLingui();
  const thread = AsyncResult.value(useAtomValue(threadAtom(messageId)));
  const messages = thread._tag === "Some" ? thread.value : undefined;

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-white dark:bg-neutral-900">
      <header className="drag flex h-13 shrink-0 items-center gap-3 px-4">
        <div className="min-w-0 flex-1">{messageId && messages ? toolbar : null}</div>
        <label className="flex h-7 w-60 items-center gap-1.5 rounded-md border border-black/10 px-2 dark:border-white/10">
          <Search className="size-3.5 shrink-0 text-neutral-400" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder={t`Search  /`}
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-neutral-400"
          />
        </label>
      </header>
      {!messageId || !messages ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-neutral-300 dark:text-neutral-600">
          <Mail className="size-10 stroke-1" />
          <p className="text-neutral-400">
            <Trans>Select a message</Trans>
          </p>
        </div>
      ) : (
        // Keyed by message so expansion state resets when the selection changes.
        <Thread
          key={messageId}
          messages={messages}
          selectedId={messageId}
          onEditDraft={onEditDraft}
        />
      )}
    </main>
  );
}

/**
 * Mimestream-style thread: one stacked column, avatars on the left, a hairline
 * between messages. Collapsed messages show one line of snippet.
 */
function Thread({
  messages,
  selectedId,
  onEditDraft,
}: {
  messages: readonly Message[];
  selectedId: string;
  onEditDraft: (messageId: string) => void;
}) {
  const { t } = useLingui();
  const last = messages.at(-1);
  const [open, setOpen] = useState(() => new Set([selectedId, last?.id ?? selectedId]));
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="selectable flex-1 overflow-y-auto px-7 pb-10">
      <h2 className="pt-2 pb-4 text-[24px] leading-tight font-bold">
        {last?.subject || t`(No subject)`}
      </h2>
      <div className="divide-y divide-black/[0.07] dark:divide-white/[0.08]">
        {messages.map((m) =>
          open.has(m.id) ? (
            <Expanded
              key={m.id}
              message={m}
              onCollapse={messages.length > 1 ? () => toggle(m.id) : undefined}
              onEditDraft={
                m.labels.includes("DRAFT")
                  ? // The local draft id survives the provider replacing this message on save.
                    () => onEditDraft(m.draftId ?? m.id)
                  : undefined
              }
            />
          ) : (
            <button
              key={m.id}
              type="button"
              onClick={() => toggle(m.id)}
              className="flex w-full gap-3 py-3 text-left"
            >
              <Avatar message={m} />
              <span className="min-w-0 flex-1">
                <MessageHead message={m} />
                <span className="mt-0.5 block truncate text-[13px] text-neutral-500 dark:text-neutral-400">
                  {m.snippet}
                </span>
              </span>
            </button>
          ),
        )}
      </div>
    </div>
  );
}

function Avatar({ message: m }: { message: Message }) {
  return (
    <span
      className={`flex size-10 shrink-0 items-center justify-center rounded-full text-[15px] font-semibold text-white ${avatarColor(m.from.address)}`}
    >
      {displayName(m.from).slice(0, 1).toUpperCase()}
    </span>
  );
}

function MessageHead({ message: m }: { message: Message }) {
  const { i18n } = useLingui();
  return (
    <span className="flex items-baseline gap-2">
      <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">
        {displayName(m.from)}
      </span>
      {m.isStarred && (
        <Star className="size-3.5 shrink-0 self-center fill-amber-400 text-amber-400" />
      )}
      <span className="shrink-0 text-[12px] text-neutral-500 dark:text-neutral-400">
        {threadDate(m.date, i18n)}
      </span>
    </span>
  );
}

function Expanded({
  message: m,
  onCollapse,
  onEditDraft,
}: {
  message: Message;
  onCollapse?: (() => void) | undefined;
  onEditDraft?: (() => void) | undefined;
}) {
  const { t } = useLingui();
  const separator = t({ message: ", ", comment: "Separator between list items" });
  const to = m.to.map(displayName).join(separator) || "—";
  const cc = m.cc.map(displayName).join(separator);
  return (
    <article className="py-3">
      {onEditDraft && (
        <div className="mb-2 flex items-center gap-2 rounded-md bg-red-500/[0.06] px-3 py-1.5 text-[13px]">
          <span className="flex-1 text-red-600 dark:text-red-400">
            <Trans>Draft</Trans>
          </span>
          <button
            type="button"
            onClick={onEditDraft}
            className="h-6 rounded px-2 font-medium text-blue-600 hover:bg-blue-500/10 dark:text-blue-400"
          >
            <Trans>Continue editing</Trans>
          </button>
        </div>
      )}
      <button
        type="button"
        disabled={!onCollapse}
        onClick={onCollapse}
        className="flex w-full gap-3 text-left select-text"
      >
        <Avatar message={m} />
        <span className="min-w-0 flex-1">
          <MessageHead message={m} />
          <span
            className="mt-0.5 block truncate text-[13px] text-neutral-500 dark:text-neutral-400"
            title={m.from.address}
          >
            <Trans>To: {to}</Trans>
            {m.cc.length > 0 && (
              <>
                {"\u3000"}
                <Trans>Cc: {cc}</Trans>
              </>
            )}
          </span>
        </span>
      </button>

      {m.attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 pt-3">
          {m.attachments.map((a, i) => (
            <span
              key={`${a.filename}-${i}`}
              className="flex items-center gap-1.5 rounded-md border border-black/10 px-2 py-1 text-[13px] dark:border-white/10"
            >
              <Paperclip className="size-3.5 text-neutral-400" />
              {a.filename}
              <span className="text-neutral-400">{formatBytes(a.size)}</span>
            </span>
          ))}
        </div>
      )}

      <div className="pt-4">
        {m.bodyHtml ? (
          <EmailFrame html={m.bodyHtml} />
        ) : (
          <pre className="font-sans text-[14px] leading-relaxed whitespace-pre-wrap">
            {m.bodyText}
          </pre>
        )}
      </div>
    </article>
  );
}

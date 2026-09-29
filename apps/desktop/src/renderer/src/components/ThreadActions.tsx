import { useLingui } from "@lingui/react/macro";
import {
  Archive,
  Bookmark,
  Forward,
  Inbox,
  MailPlus,
  MailOpen,
  Mail,
  Reply,
  ReplyAll,
  ShieldAlert,
  Star,
  Tag,
  Trash2,
} from "lucide-react";
import { type ComponentType, useState } from "react";

import type { Label, MailOp, Mailbox, Provider } from "../../../shared/api";

type Icon = ComponentType<{ className?: string }>;

export interface ThreadState {
  provider: Provider;
  isUnread: boolean;
  isStarred: boolean;
  isImportant: boolean;
  labels: string[];
}

interface Props {
  state: ThreadState;
  mailbox: Mailbox;
  /** User labels or folders of the thread's account. */
  labels: Label[];
  onOp: (op: MailOp) => void;
  /** `asAttachment` forwards the original as an .eml file. */
  onCompose: (mode: "reply" | "replyAll" | "forward", asAttachment?: boolean) => void;
}

/** Mimestream-style toolbar above the reader. Titles carry the keyboard shortcut. */
export function ThreadActions({ state, mailbox, labels, onOp, onCompose }: Props) {
  const { t } = useLingui();
  const [labelMenu, setLabelMenu] = useState(false);
  const out = mailbox === "trash" || mailbox === "spam" || !state.labels.includes("INBOX");
  const folders = state.provider !== "gmail";

  return (
    <div className="flex items-center gap-0.5">
      {out && (mailbox === "trash" || mailbox === "spam" || folders) ? (
        <Button
          icon={Inbox}
          title={t`Move to Inbox (⇧⌘I)`}
          onClick={() => onOp({ kind: "inbox" })}
        />
      ) : (
        <Button icon={Archive} title={t`Archive (E)`} onClick={() => onOp({ kind: "archive" })} />
      )}
      <Button icon={Trash2} title={t`Delete (#)`} onClick={() => onOp({ kind: "trash" })} />
      {mailbox !== "spam" && (
        <Button
          icon={ShieldAlert}
          title={t`Report spam (!)`}
          onClick={() => onOp({ kind: "spam" })}
        />
      )}
      <Divider />
      <Button
        icon={state.isUnread ? MailOpen : Mail}
        title={state.isUnread ? t`Mark as read (U)` : t`Mark as unread (U)`}
        onClick={() => onOp({ kind: "read", value: state.isUnread })}
      />
      <Button
        icon={Star}
        active={state.isStarred}
        activeClass="fill-amber-400 text-amber-400"
        title={state.isStarred ? t`Unstar (S)` : t`Star (S)`}
        onClick={() => onOp({ kind: "star", value: !state.isStarred })}
      />
      {state.provider === "gmail" && (
        <Button
          icon={Bookmark}
          active={state.isImportant}
          activeClass="fill-orange-400 text-orange-400"
          title={state.isImportant ? t`Mark as not important (=)` : t`Mark as important (=)`}
          onClick={() => onOp({ kind: "important", value: !state.isImportant })}
        />
      )}
      {labels.length > 0 && (
        <span className="relative">
          <Button
            icon={Tag}
            title={folders ? t`Move to folder (V)` : t`Labels (L)`}
            onClick={() => setLabelMenu((v) => !v)}
          />
          {labelMenu && (
            <LabelMenu
              labels={labels}
              current={state.labels}
              folders={folders}
              onPick={(label, value) => {
                setLabelMenu(false);
                onOp({ kind: "label", labelId: label.id, value });
              }}
              onClose={() => setLabelMenu(false)}
            />
          )}
        </span>
      )}
      <Divider />
      <Button icon={Reply} title={t`Reply (R)`} onClick={() => onCompose("reply")} />
      <Button icon={ReplyAll} title={t`Reply all (A)`} onClick={() => onCompose("replyAll")} />
      <Button icon={Forward} title={t`Forward (F)`} onClick={() => onCompose("forward")} />
      <Button
        icon={MailPlus}
        title={t`Forward as attachment (⇧F)`}
        onClick={() => onCompose("forward", true)}
      />
    </div>
  );
}

function LabelMenu({
  labels,
  current,
  folders,
  onPick,
  onClose,
}: {
  labels: Label[];
  current: string[];
  folders: boolean;
  onPick: (label: Label, value: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [filter, setFilter] = useState("");
  const shown = labels.filter((l) => l.name.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="absolute top-8 left-0 z-20 w-60 overflow-hidden rounded-lg border border-black/10 bg-white shadow-xl dark:border-white/10 dark:bg-neutral-800">
      <input
        autoFocus
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          } else if (e.key === "Enter" && shown[0]) {
            onPick(shown[0], !current.includes(shown[0].id));
          }
        }}
        placeholder={folders ? t`Move to folder…` : t`Labels…`}
        className="h-8 w-full border-b border-black/[0.07] bg-transparent px-3 text-[13px] outline-none dark:border-white/[0.08]"
      />
      <ul className="max-h-64 overflow-y-auto py-1">
        {shown.map((l) => {
          const on = current.includes(l.id);
          return (
            <li key={l.id}>
              <button
                type="button"
                onClick={() => onPick(l, !on)}
                className="flex h-7 w-full items-center gap-2 px-3 text-left text-[13px] hover:bg-black/5 dark:hover:bg-white/10"
              >
                <span
                  className="size-2.5 shrink-0 rounded-full bg-neutral-300 dark:bg-neutral-600"
                  style={l.color ? { backgroundColor: l.color } : undefined}
                />
                <span className="min-w-0 flex-1 truncate">{l.name}</span>
                {on && <span className="text-blue-600 dark:text-blue-400">✓</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Divider() {
  return <span className="mx-1.5 h-4 w-px bg-black/10 dark:bg-white/10" />;
}

function Button({
  icon: Icon,
  title,
  onClick,
  active,
  activeClass,
}: {
  icon: Icon;
  title: string;
  onClick: () => void;
  active?: boolean;
  activeClass?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
      className="rounded-md p-1.5 text-neutral-500 hover:bg-black/5 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-neutral-100"
    >
      <Icon className={`size-4 ${active ? activeClass : ""}`} />
    </button>
  );
}

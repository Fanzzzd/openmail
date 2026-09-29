import {
  Archive,
  Bookmark,
  Forward,
  Inbox,
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
  onCompose: (mode: "reply" | "replyAll" | "forward") => void;
}

/** Mimestream-style toolbar above the reader. Titles carry the keyboard shortcut. */
export function ThreadActions({ state, mailbox, labels, onOp, onCompose }: Props) {
  const [labelMenu, setLabelMenu] = useState(false);
  const out = mailbox === "trash" || mailbox === "spam" || !state.labels.includes("INBOX");
  const folders = state.provider !== "gmail";

  return (
    <div className="flex items-center gap-0.5">
      {out && (mailbox === "trash" || mailbox === "spam" || folders) ? (
        <Button icon={Inbox} title="移回收件箱 (⇧⌘I)" onClick={() => onOp({ kind: "inbox" })} />
      ) : (
        <Button icon={Archive} title="归档 (E)" onClick={() => onOp({ kind: "archive" })} />
      )}
      <Button icon={Trash2} title="删除 (#)" onClick={() => onOp({ kind: "trash" })} />
      {mailbox !== "spam" && (
        <Button
          icon={ShieldAlert}
          title="报告垃圾邮件 (!)"
          onClick={() => onOp({ kind: "spam" })}
        />
      )}
      <Divider />
      <Button
        icon={state.isUnread ? MailOpen : Mail}
        title={state.isUnread ? "标为已读 (U)" : "标为未读 (U)"}
        onClick={() => onOp({ kind: "read", value: state.isUnread })}
      />
      <Button
        icon={Star}
        active={state.isStarred}
        activeClass="fill-amber-400 text-amber-400"
        title={state.isStarred ? "去掉星标 (S)" : "加星标 (S)"}
        onClick={() => onOp({ kind: "star", value: !state.isStarred })}
      />
      {state.provider === "gmail" && (
        <Button
          icon={Bookmark}
          active={state.isImportant}
          activeClass="fill-orange-400 text-orange-400"
          title={state.isImportant ? "取消重要 (=)" : "标为重要 (=)"}
          onClick={() => onOp({ kind: "important", value: !state.isImportant })}
        />
      )}
      {labels.length > 0 && (
        <span className="relative">
          <Button
            icon={Tag}
            title={folders ? "移到文件夹 (V)" : "标签 (L)"}
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
      <Button icon={Reply} title="回复 (R)" onClick={() => onCompose("reply")} />
      <Button icon={ReplyAll} title="回复全部 (A)" onClick={() => onCompose("replyAll")} />
      <Button icon={Forward} title="转发 (F)" onClick={() => onCompose("forward")} />
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
        placeholder={folders ? "移到文件夹…" : "标签…"}
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

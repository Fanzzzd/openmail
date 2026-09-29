import { Paperclip, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { Account, OutgoingMessage } from "../../../shared/api";
import { type Draft, isEmpty, parseAddresses } from "../draft";
import { formatBytes } from "../format";
import { ProviderIcon } from "./ProviderIcon";

const TITLES: Record<Draft["mode"], string> = {
  new: "新邮件",
  reply: "回复",
  replyAll: "回复全部",
  forward: "转发",
};

interface Props {
  draft: Draft;
  accounts: readonly Account[];
  onClose: () => void;
  /** Called with the message once the form is valid; the caller runs the undo window. */
  onSend: (draft: Draft, message: OutgoingMessage) => void;
}

export function Composer({ draft: initial, accounts, onClose, onSend }: Props) {
  const [draft, setDraft] = useState(initial);
  const [showBcc, setShowBcc] = useState(Boolean(initial.bcc || initial.cc));
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const account = accounts.find((a) => a.id === draft.accountId);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  // Replies start typing above the quote.
  useEffect(() => {
    if (initial.mode !== "new") {
      bodyRef.current?.focus();
      bodyRef.current?.setSelectionRange(0, 0);
    }
  }, [initial.mode]);

  const submit = () => {
    const to = parseAddresses(draft.to);
    const cc = parseAddresses(draft.cc);
    const bcc = parseAddresses(draft.bcc);
    const invalid = [...to.invalid, ...cc.invalid, ...bcc.invalid];
    if (invalid.length) {
      setError(`这些不是邮件地址：${invalid.join("、")}`);
      return;
    }
    if (to.addresses.length + cc.addresses.length + bcc.addresses.length === 0) {
      setError("至少填一个收件人");
      return;
    }
    onSend(draft, {
      to: to.addresses,
      cc: cc.addresses,
      bcc: bcc.addresses,
      subject: draft.subject,
      text: draft.body,
      attachments: draft.attachments,
      mode: draft.mode,
      ...(draft.inReplyTo ? { inReplyTo: draft.inReplyTo } : {}),
    });
  };

  const close = () => {
    // A filled-in draft only closes through 丢弃, so a stray Escape loses nothing.
    if (isEmpty(draft)) onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submit();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    const added = await Promise.all(
      [...files].map(async (f) => ({
        filename: f.name,
        mimeType: f.type || "application/octet-stream",
        content: await toBase64(f),
      })),
    );
    set({ attachments: [...draft.attachments, ...added] });
  };

  const field =
    "h-9 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-neutral-400";
  const row = "flex items-center gap-2 border-b border-black/[0.07] px-4 dark:border-white/[0.08]";
  const label = "w-14 shrink-0 text-neutral-500 dark:text-neutral-400";

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-end bg-black/10 p-5 dark:bg-black/30">
      <form
        aria-label={TITLES[draft.mode]}
        className="flex h-[min(640px,100%)] w-[min(640px,100%)] flex-col overflow-hidden rounded-xl bg-white text-[13px] shadow-2xl ring-1 ring-black/10 dark:bg-neutral-800 dark:ring-white/10"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-black/[0.07] px-4 dark:border-white/[0.08]">
          <h2 className="flex-1 text-[14px] font-semibold">{TITLES[draft.mode]}</h2>
          <button
            type="button"
            title="丢弃"
            onClick={onClose}
            className="rounded p-1 text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className={row}>
          <span className={label}>发件人</span>
          {account && <ProviderIcon provider={account.imap?.preset ?? account.provider} />}
          <select
            value={draft.accountId}
            // Replies stay on the account that received the message.
            disabled={draft.mode !== "new"}
            onChange={(e) => set({ accountId: e.target.value })}
            className={`${field} appearance-none disabled:opacity-100`}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.email}
              </option>
            ))}
          </select>
        </div>
        <div className={row}>
          <span className={label}>收件人</span>
          <input
            autoFocus={initial.mode === "new" || initial.mode === "forward"}
            value={draft.to}
            onChange={(e) => set({ to: e.target.value })}
            className={field}
          />
          {!showBcc && (
            <button
              type="button"
              onClick={() => setShowBcc(true)}
              className="shrink-0 text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
            >
              抄送/密送
            </button>
          )}
        </div>
        {showBcc && (
          <>
            <div className={row}>
              <span className={label}>抄送</span>
              <input
                value={draft.cc}
                onChange={(e) => set({ cc: e.target.value })}
                className={field}
              />
            </div>
            <div className={row}>
              <span className={label}>密送</span>
              <input
                value={draft.bcc}
                onChange={(e) => set({ bcc: e.target.value })}
                className={field}
              />
            </div>
          </>
        )}
        <div className={row}>
          <span className={label}>主题</span>
          <input
            value={draft.subject}
            onChange={(e) => set({ subject: e.target.value })}
            className={field}
          />
        </div>

        <textarea
          ref={bodyRef}
          value={draft.body}
          onChange={(e) => set({ body: e.target.value })}
          aria-label="正文"
          className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3 text-[14px] leading-relaxed outline-none"
        />

        {draft.attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-4 pb-2">
            {draft.attachments.map((a, i) => (
              <span
                key={`${a.filename}-${i}`}
                className="flex items-center gap-1.5 rounded-md border border-black/10 px-2 py-1 dark:border-white/10"
              >
                <Paperclip className="size-3.5 text-neutral-400" />
                {a.filename}
                <span className="text-neutral-400">{formatBytes((a.content.length * 3) / 4)}</span>
                <button
                  type="button"
                  aria-label={`移除 ${a.filename}`}
                  onClick={() => set({ attachments: draft.attachments.filter((_, j) => j !== i) })}
                  className="text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
                >
                  <X className="size-3.5" />
                </button>
              </span>
            ))}
          </div>
        )}

        <footer className="flex shrink-0 items-center gap-3 border-t border-black/[0.07] px-4 py-2.5 dark:border-white/[0.08]">
          <button
            type="submit"
            className="h-7 rounded-md bg-blue-600 px-3.5 font-medium text-white hover:bg-blue-700"
          >
            发送
          </button>
          <span className="text-[12px] text-neutral-400">⌘↩</span>
          <button
            type="button"
            title="添加附件"
            onClick={() => fileRef.current?.click()}
            className="rounded p-1 text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10"
          >
            <Paperclip className="size-4" />
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <span className="min-w-0 flex-1 truncate text-[12px] text-red-500">{error}</span>
          {draft.mode === "forward" && account?.provider !== "outlook" && !error && (
            <span className="shrink-0 text-[12px] text-neutral-400">原邮件的附件不会一起转发</span>
          )}
        </footer>
      </form>
    </div>
  );
}

async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  // Chunked: String.fromCharCode takes its arguments on the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { applySignature, fillTemplate, mentionsAttachment, ownText } from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import { FileText, Paperclip, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { Account, OutgoingMessage, Template } from "../../../shared/api";
import {
  type ComposeMode,
  type Draft,
  formatAddress,
  isEmpty,
  parseAddresses,
  toDraftInput,
  toMessage,
} from "../draft";
import { formatBytes } from "../format";
import { Keys } from "../state/keys";
import { saveDraftAtom, saveTemplateAtom } from "../state/mutations";
import { templatesAtom } from "../state/queries";
import { ProviderIcon } from "./ProviderIcon";
import { RecipientField } from "./RecipientField";

const TITLES: Record<Draft["mode"], MessageDescriptor> = {
  new: msg`New Message`,
  reply: msg`Reply`,
  replyAll: msg`Reply All`,
  forward: msg`Forward`,
};

/** Autosave runs this long after the last keystroke. */
const AUTOSAVE_MS = 2000;

interface Props {
  draft: Draft;
  accounts: readonly Account[];
  /** The local signature for an account and compose mode, if the person set one. */
  signatureFor: (accountId: string, mode: ComposeMode) => string | undefined;
  /** `changed` is false when the person closed without touching the draft. */
  onClose: (draft: Draft, changed: boolean) => void;
  onDiscard: (draft: Draft) => void;
  /** Called with the message once the form is valid; the caller runs the undo window. */
  onSend: (draft: Draft, message: OutgoingMessage, options: { archive: boolean }) => void;
}

export function Composer({
  draft: initial,
  accounts,
  signatureFor,
  onClose,
  onDiscard,
  onSend,
}: Props) {
  const { t, i18n } = useLingui();
  const [draft, setDraft] = useState(initial);
  const [showBcc, setShowBcc] = useState(Boolean(initial.bcc || initial.cc));
  const [error, setError] = useState<string | null>(null);
  /** Sending waits for a yes: the body talks about an attachment and there is none. */
  const [asking, setAsking] = useState<{ archive: boolean } | null>(null);
  const [picker, setPicker] = useState(false);
  const [saveState, save] = useAtom(saveDraftAtom(initial.id));
  const fileRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const account = accounts.find((a) => a.id === draft.accountId);
  const replying = draft.mode === "reply" || draft.mode === "replyAll";
  const set = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setAsking(null);
  };

  // Replies start typing above the quote.
  useEffect(() => {
    if (initial.mode !== "new") {
      bodyRef.current?.focus();
      bodyRef.current?.setSelectionRange(0, 0);
    }
  }, [initial.mode]);

  // Autosave: locally at once, then to the provider through the queue.
  const saved = useRef(initial);
  useEffect(() => {
    const due = draft !== saved.current && !isEmpty(draft);
    const timer = due
      ? setTimeout(() => {
          saved.current = draft;
          save(toDraftInput(draft));
        }, AUTOSAVE_MS)
      : undefined;
    return () => clearTimeout(timer);
  }, [draft, save]);

  const submit = (archive: boolean, confirmed = false) => {
    const { message, invalid } = toMessage(draft);
    if (invalid.length) {
      const list = invalid.join(t({ message: ", ", comment: "Separator between list items" }));
      setError(t`These are not email addresses: ${list}`);
      return;
    }
    if (message.to.length + message.cc.length + message.bcc.length === 0) {
      setError(t`Add at least one recipient`);
      return;
    }
    const noFiles = message.attachments.length === 0 && !draft.forwardAsAttachment;
    if (!confirmed && noFiles && mentionsAttachment(draft.body)) {
      setAsking({ archive });
      return;
    }
    onSend(draft, message, { archive: archive && replying });
  };

  const close = () => onClose(draft, draft !== initial);

  useEffect(() => {
    // Bubble phase: fields that handle a key themselves (suggestions) mark it handled first.
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const cmd = e.metaKey || e.ctrlKey;
      if (e.key === "Escape") {
        e.stopPropagation();
        if (picker) setPicker(false);
        else if (asking) setAsking(null);
        else close();
      } else if (e.key === "Enter" && cmd) {
        e.preventDefault();
        submit(e.shiftKey);
      } else if (e.key === "/" && cmd) {
        e.preventDefault();
        setPicker((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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

  const changeAccount = (accountId: string) =>
    set({
      accountId,
      body: applySignature(
        draft.body,
        signatureFor(draft.accountId, draft.mode),
        signatureFor(accountId, draft.mode),
      ),
    });

  const insertTemplate = (template: Template) => {
    const to = merge(draft.to, template.to);
    const cc = merge(draft.cc, template.cc);
    const first = parseAddresses(to).addresses[0];
    const at = bodyRef.current?.selectionStart ?? 0;
    const text = fillTemplate(template.body, first);
    set({
      to,
      cc,
      subject: template.subject ? fillTemplate(template.subject, first) : draft.subject,
      body: draft.body.slice(0, at) + text + draft.body.slice(at),
    });
    if (cc) setShowBcc(true);
    setPicker(false);
    requestAnimationFrame(() => {
      bodyRef.current?.focus();
      bodyRef.current?.setSelectionRange(at + text.length, at + text.length);
    });
  };

  const status = saveState.waiting
    ? t`Saving…`
    : saveState._tag === "Success"
      ? saveState.value.synced
        ? t`Saved`
        : t`Saved on this Mac. Syncs when online.`
      : saveState._tag === "Failure"
        ? t`Couldn't save`
        : "";

  const field =
    "h-9 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-neutral-400";
  const row = "flex items-center gap-2 border-b border-black/[0.07] px-4 dark:border-white/[0.08]";
  const label = "w-14 shrink-0 text-neutral-500 dark:text-neutral-400";
  const quiet =
    "rounded p-1 text-neutral-500 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/10";

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-end bg-black/10 p-5 dark:bg-black/30">
      {/* no-drag: on a short window the header sits over the titlebar strips,
          whose drag region would swallow clicks on the close button. */}
      <form
        aria-label={i18n._(TITLES[draft.mode])}
        className="no-drag flex h-[min(680px,100%)] w-[min(680px,100%)] flex-col overflow-hidden rounded-xl bg-white text-[13px] shadow-2xl ring-1 ring-black/10 dark:bg-neutral-800 dark:ring-white/10"
        onSubmit={(e) => {
          e.preventDefault();
          submit(false);
        }}
      >
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-black/[0.07] px-4 dark:border-white/[0.08]">
          <h2 className="text-[14px] font-semibold">{i18n._(TITLES[draft.mode])}</h2>
          {draft.proposalId !== undefined && (
            <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[11px] text-violet-700 dark:text-violet-300">
              <Trans>AI draft</Trans>
            </span>
          )}
          <span className="flex-1 truncate text-[12px] text-neutral-400">{status}</span>
          <button
            type="button"
            title={t`Close. The draft is saved.`}
            onClick={close}
            className={quiet}
          >
            <X className="size-4" />
          </button>
        </header>

        <div className={row}>
          <span className={label}>
            <Trans>From</Trans>
          </span>
          {account && <ProviderIcon provider={account.imap?.preset ?? account.provider} />}
          <select
            value={draft.accountId}
            // Replies stay on the account that received the message.
            disabled={draft.mode !== "new"}
            onChange={(e) => changeAccount(e.target.value)}
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
          <span className={label}>
            <Trans>To</Trans>
          </span>
          <RecipientField
            label={t`To`}
            autoFocus={initial.mode === "new" || initial.mode === "forward"}
            value={draft.to}
            onChange={(to) => set({ to })}
            className={field}
            from={account?.email}
          />
          {!showBcc && (
            <button
              type="button"
              onClick={() => setShowBcc(true)}
              className="shrink-0 text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
            >
              <Trans>Cc/Bcc</Trans>
            </button>
          )}
        </div>
        {showBcc && (
          <>
            <div className={row}>
              <span className={label}>
                <Trans>Cc</Trans>
              </span>
              <RecipientField
                label={t`Cc`}
                value={draft.cc}
                onChange={(cc) => set({ cc })}
                className={field}
                from={account?.email}
              />
            </div>
            <div className={row}>
              <span className={label}>
                <Trans>Bcc</Trans>
              </span>
              <RecipientField
                label={t`Bcc`}
                value={draft.bcc}
                onChange={(bcc) => set({ bcc })}
                className={field}
                from={account?.email}
              />
            </div>
          </>
        )}
        <div className={row}>
          <span className={label}>
            <Trans>Subject</Trans>
          </span>
          <input
            aria-label={t`Subject`}
            value={draft.subject}
            onChange={(e) => set({ subject: e.target.value })}
            className={field}
          />
        </div>

        <div className="relative flex min-h-0 flex-1 flex-col">
          <textarea
            ref={bodyRef}
            value={draft.body}
            onChange={(e) => set({ body: e.target.value })}
            aria-label={t`Body`}
            placeholder={
              draft.markdown
                ? t`Markdown works: **bold**, \`code\`, \`\`\`code block\`\`\``
                : undefined
            }
            className={`min-h-0 flex-1 resize-none bg-transparent px-4 py-3 text-[14px] leading-relaxed outline-none placeholder:text-neutral-400 ${
              draft.markdown ? "font-mono text-[13px]" : ""
            }`}
          />
          {picker && (
            <TemplatePicker
              draft={draft}
              onInsert={insertTemplate}
              onClose={() => {
                setPicker(false);
                bodyRef.current?.focus();
              }}
            />
          )}
        </div>

        {(draft.attachments.length > 0 || draft.forwardAsAttachment) && (
          <div className="flex flex-wrap gap-2 px-4 pb-2">
            {draft.forwardAsAttachment && (
              <span className="flex items-center gap-1.5 rounded-md border border-black/10 px-2 py-1 dark:border-white/10">
                <Paperclip className="size-3.5 text-neutral-400" />
                <Trans>Original message (.eml)</Trans>
                <button
                  type="button"
                  aria-label={t`Don't attach the original message`}
                  onClick={() => set({ forwardAsAttachment: false })}
                  className="text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
                >
                  <X className="size-3.5" />
                </button>
              </span>
            )}
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
                  aria-label={t`Remove ${a.filename}`}
                  onClick={() => set({ attachments: draft.attachments.filter((_, j) => j !== i) })}
                  className="text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
                >
                  <X className="size-3.5" />
                </button>
              </span>
            ))}
          </div>
        )}

        {asking ? (
          <footer
            role="alert"
            className="flex shrink-0 items-center gap-2 border-t border-black/[0.07] bg-amber-500/10 px-4 py-2.5 dark:border-white/[0.08]"
          >
            <span className="min-w-0 flex-1">
              <Trans>The message mentions an attachment, but none is added.</Trans>
            </span>
            <button
              type="button"
              autoFocus
              // Nothing is sent: the prompt closes and the file picker opens.
              onClick={() => {
                setAsking(null);
                fileRef.current?.click();
              }}
              className="h-7 rounded-md border border-black/10 px-3 font-medium hover:bg-black/[0.04] dark:border-white/15 dark:hover:bg-white/5"
            >
              <Trans>Add attachment</Trans>
            </button>
            <button
              type="button"
              onClick={() => submit(asking.archive, true)}
              className="h-7 rounded-md bg-blue-600 px-3 font-medium text-white hover:bg-blue-700"
            >
              <Trans>Send anyway</Trans>
            </button>
          </footer>
        ) : (
          <footer className="flex shrink-0 items-center gap-2 border-t border-black/[0.07] px-4 py-2.5 dark:border-white/[0.08]">
            <button
              type="submit"
              title={t`Send (⌘↩)`}
              className="h-7 rounded-md bg-blue-600 px-3.5 font-medium text-white hover:bg-blue-700"
            >
              <Trans>Send</Trans>
            </button>
            {replying && (
              <button
                type="button"
                title={t`Send and archive (⇧⌘↩)`}
                onClick={() => submit(true)}
                className="h-7 rounded-md border border-black/10 px-3 font-medium hover:bg-black/[0.04] dark:border-white/15 dark:hover:bg-white/5"
              >
                <Trans>Send and archive</Trans>
              </button>
            )}
            <button
              type="button"
              title={t`Attach files`}
              onClick={() => fileRef.current?.click()}
              className={quiet}
            >
              <Paperclip className="size-4" />
            </button>
            <button
              type="button"
              title={t`Templates (⌘/)`}
              onClick={() => setPicker((v) => !v)}
              className={quiet}
            >
              <FileText className="size-4" />
            </button>
            <button
              type="button"
              title={t`Write in Markdown`}
              aria-pressed={draft.markdown}
              onClick={() => set({ markdown: !draft.markdown })}
              className={`h-6 rounded px-1.5 text-[11px] font-semibold ${
                draft.markdown
                  ? "bg-blue-600 text-white"
                  : "text-neutral-500 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/10"
              }`}
            >
              M↓
            </button>
            <span className="min-w-0 flex-1 truncate text-[12px] text-red-500">{error}</span>
            {!error &&
              draft.mode === "forward" &&
              !draft.forwardAsAttachment &&
              account?.provider !== "outlook" && (
                <span className="shrink-0 text-[12px] text-neutral-400">
                  <Trans>Attachments of the original message are not forwarded</Trans>
                </span>
              )}
            <button
              type="button"
              title={t`Discard draft`}
              onClick={() => onDiscard(draft)}
              className={quiet}
            >
              <Trash2 className="size-4" />
            </button>
          </footer>
        )}
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
      </form>
    </div>
  );
}

/** Adds a template's preset addresses to what is typed, skipping ones already there. */
const merge = (typed: string, preset: readonly { name: string; address: string }[]) => {
  const have = new Set(parseAddresses(typed).addresses.map((a) => a.address.toLowerCase()));
  const extra = preset.filter((a) => !have.has(a.address.toLowerCase())).map(formatAddress);
  return [typed.trim().replace(/[,;，；]$/, ""), ...extra].filter(Boolean).join(", ");
};

/** ⌘/ in the compose window: pick a template to insert, or keep this message as one. */
function TemplatePicker({
  draft,
  onInsert,
  onClose,
}: {
  draft: Draft;
  onInsert: (t: Template) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const templates = AsyncResult.getOrElse(useAtomValue(templatesAtom), () => []);
  const saveTemplate = useAtomSet(saveTemplateAtom);
  const [filter, setFilter] = useState("");
  const [naming, setNaming] = useState(false);
  const [active, setActive] = useState(0);
  const shown = templates.filter((tpl) => tpl.name.toLowerCase().includes(filter.toLowerCase()));
  // A template placeholder, shown as is.
  const token = "{first_name}";
  const current = Math.min(active, Math.max(shown.length - 1, 0));

  const keep = () => {
    const name = filter.trim();
    if (!name) return;
    saveTemplate({
      payload: {
        input: {
          name,
          subject: draft.subject,
          to: parseAddresses(draft.to).addresses,
          cc: parseAddresses(draft.cc).addresses,
          body: ownText(draft.body),
        },
      },
      reactivityKeys: [Keys.templates],
    });
    onClose();
  };

  return (
    <div className="absolute bottom-3 left-4 z-20 w-80 overflow-hidden rounded-lg border border-black/10 bg-white shadow-xl dark:border-white/10 dark:bg-neutral-800">
      <input
        autoFocus
        aria-label={naming ? t`Template name` : t`Search templates`}
        value={filter}
        onChange={(e) => {
          setFilter(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const step = e.key === "ArrowDown" ? 1 : -1;
            if (shown.length) setActive((current + step + shown.length) % shown.length);
          } else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            if (naming) keep();
            else if (shown[current]) onInsert(shown[current]);
          }
        }}
        placeholder={naming ? t`Name the template, then press Return` : t`Templates…`}
        className="h-8 w-full border-b border-black/[0.07] bg-transparent px-3 text-[13px] outline-none dark:border-white/[0.08]"
      />
      {!naming && (
        <ul className="max-h-56 overflow-y-auto py-1">
          {shown.map((tpl, i) => (
            <li key={tpl.id}>
              <button
                type="button"
                onClick={() => onInsert(tpl)}
                onMouseEnter={() => setActive(i)}
                className={`block w-full px-3 py-1.5 text-left ${i === current ? "bg-blue-500/10" : ""}`}
              >
                <span className="block truncate font-medium">{tpl.name}</span>
                <span className="block truncate text-[12px] text-neutral-500">
                  {tpl.subject || tpl.body.replace(/\s+/g, " ").slice(0, 60)}
                </span>
              </button>
            </li>
          ))}
          {templates.length === 0 && (
            <li className="px-3 py-1.5 text-neutral-400">
              <Trans>No templates yet. Use {token} for the first recipient's name.</Trans>
            </li>
          )}
        </ul>
      )}
      <button
        type="button"
        onClick={() => {
          if (naming) {
            keep();
          } else {
            setNaming(true);
            setFilter("");
          }
        }}
        className="block h-8 w-full border-t border-black/[0.07] px-3 text-left text-blue-600 hover:bg-black/[0.03] dark:border-white/[0.08] dark:text-blue-400 dark:hover:bg-white/5"
      >
        {naming ? <Trans>Save</Trans> : <Trans>Save this message as a template…</Trans>}
      </button>
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

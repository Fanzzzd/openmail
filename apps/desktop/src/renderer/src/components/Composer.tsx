import { Autocomplete } from "@base-ui/react/autocomplete";
import { Dialog } from "@base-ui/react/dialog";
import { Toggle } from "@base-ui/react/toggle";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { applySignature, fillTemplate, mentionsAttachment, ownText } from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import { FileText, Paperclip, Trash2, X } from "lucide-react";
import { type ReactElement, type RefObject, useEffect, useRef, useState } from "react";

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
import { Alert, AlertCancel, alertButton, alertPrimary } from "./ui/Dialog";
import { PickerPopover, pickerFooter, pickerInput, pickerItem, pickerList } from "./ui/Picker";
import { Select } from "./ui/Select";
import { Tip } from "./ui/Tip";

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
  const toRef = useRef<HTMLInputElement>(null);
  const account = accounts.find((a) => a.id === draft.accountId);
  const replying = draft.mode === "reply" || draft.mode === "replyAll";
  const set = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setAsking(null);
  };

  /** New messages and forwards start in To; replies start typing above the quote. */
  const initialFocus = () => {
    if (initial.mode === "new" || initial.mode === "forward") return toRef.current;
    bodyRef.current?.setSelectionRange(0, 0);
    return bodyRef.current;
  };

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
    // Escape belongs to the dialog: it closes the innermost popup, then the window.
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const cmd = e.metaKey || e.ctrlKey;
      if (e.key === "Enter" && cmd) {
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
  const row = "flex items-start gap-2 border-b border-black/[0.07] px-4 dark:border-white/[0.08]";
  const label = "flex h-9 w-14 shrink-0 items-center text-neutral-500 dark:text-neutral-400";
  const quiet =
    "rounded p-1 text-neutral-500 outline-offset-0 outline-blue-500/60 hover:bg-black/5 focus-visible:outline-[3px] data-popup-open:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/10 dark:data-popup-open:bg-white/10";
  const title = i18n._(TITLES[draft.mode]);

  return (
    // Non-modal: nothing is trapped or locked, but the backdrop keeps the mail
    // behind it out of reach, and only Escape or the buttons close it.
    <Dialog.Root
      open
      modal={false}
      disablePointerDismissal
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="no-drag fixed inset-0 z-50 bg-black/10 transition-opacity duration-150 data-starting-style:opacity-0 motion-reduce:transition-none dark:bg-black/30" />
        {/* no-drag: on a short window the header sits over the titlebar strips,
            whose drag region would swallow clicks on the close button. */}
        <Dialog.Popup
          aria-label={title}
          initialFocus={initialFocus}
          className="no-drag fixed right-5 bottom-5 z-50 flex h-[min(680px,calc(100%-40px))] w-[min(680px,calc(100%-40px))] flex-col overflow-hidden rounded-xl bg-white text-[13px] text-neutral-900 shadow-2xl ring-1 ring-black/10 outline-none transition-[opacity,translate] duration-150 ease-out data-starting-style:translate-y-2 data-starting-style:opacity-0 motion-reduce:transition-none dark:bg-neutral-800 dark:text-neutral-100 dark:ring-white/10"
        >
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(e) => {
              e.preventDefault();
              submit(false);
            }}
          >
            <header className="flex h-11 shrink-0 items-center gap-2 border-b border-black/[0.07] px-4 dark:border-white/[0.08]">
              <Dialog.Title className="text-[14px] font-semibold">{title}</Dialog.Title>
              {draft.proposalId !== undefined && (
                <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[11px] text-violet-700 dark:text-violet-300">
                  <Trans>AI draft</Trans>
                </span>
              )}
              <span className="flex-1 truncate text-[12px] text-neutral-400">{status}</span>
              <Tip label={t`Close. The draft is saved.`} shortcut="Esc">
                <button type="button" aria-label={t`Close`} onClick={close} className={quiet}>
                  <X className="size-4" />
                </button>
              </Tip>
            </header>

            <div className={`${row} items-center`}>
              <span className={label}>
                <Trans>From</Trans>
              </span>
              <Select
                aria-label={t`From`}
                value={draft.accountId}
                // Replies stay on the account that received the message.
                disabled={draft.mode !== "new"}
                onValueChange={changeAccount}
                options={accounts.map((a) => ({
                  value: a.id,
                  label: a.email,
                  icon: (
                    <ProviderIcon
                      provider={a.imap?.preset ?? a.provider}
                      className="size-4 shrink-0"
                    />
                  ),
                }))}
                className="max-w-full"
              />
            </div>
            <div className={row}>
              <span className={label}>
                <Trans>To</Trans>
              </span>
              <RecipientField
                label={t`To`}
                inputRef={toRef}
                value={draft.to}
                onChange={(to) => set({ to })}
                from={account?.email}
              />
              {!showBcc && (
                <button
                  type="button"
                  onClick={() => setShowBcc(true)}
                  className="h-9 shrink-0 text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
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
                    <span className="text-neutral-400">
                      {formatBytes((a.content.length * 3) / 4)}
                    </span>
                    <button
                      type="button"
                      aria-label={t`Remove ${a.filename}`}
                      onClick={() =>
                        set({ attachments: draft.attachments.filter((_, j) => j !== i) })
                      }
                      className="text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
                    >
                      <X className="size-3.5" />
                    </button>
                  </span>
                ))}
              </div>
            )}

            <footer className="flex shrink-0 items-center gap-2 border-t border-black/[0.07] px-4 py-2.5 dark:border-white/[0.08]">
              <Tip label={t`Send`} shortcut="⌘↩" side="top">
                <button
                  type="submit"
                  className="h-7 rounded-md bg-blue-600 px-3.5 font-medium text-white hover:bg-blue-700"
                >
                  <Trans>Send</Trans>
                </button>
              </Tip>
              {replying && (
                <Tip label={t`Send and archive`} shortcut="⇧⌘↩" side="top">
                  <button
                    type="button"
                    onClick={() => submit(true)}
                    className="h-7 rounded-md border border-black/10 px-3 font-medium hover:bg-black/[0.04] dark:border-white/15 dark:hover:bg-white/5"
                  >
                    <Trans>Send and archive</Trans>
                  </button>
                </Tip>
              )}
              <Tip label={t`Attach files`} side="top">
                <button
                  type="button"
                  aria-label={t`Attach files`}
                  onClick={() => fileRef.current?.click()}
                  className={quiet}
                >
                  <Paperclip className="size-4" />
                </button>
              </Tip>
              <TemplatePicker
                open={picker}
                onOpenChange={setPicker}
                draft={draft}
                onInsert={insertTemplate}
                bodyRef={bodyRef}
                tip={{ label: t`Templates`, shortcut: "⌘/" }}
                trigger={
                  <button type="button" aria-label={t`Templates`} className={quiet}>
                    <FileText className="size-4" />
                  </button>
                }
              />
              <Tip label={t`Write in Markdown`} side="top">
                <Toggle
                  aria-label={t`Write in Markdown`}
                  pressed={draft.markdown}
                  onPressedChange={(markdown) => set({ markdown })}
                  className="h-6 rounded px-1.5 text-[11px] font-semibold text-neutral-500 outline-offset-0 outline-blue-500/60 hover:bg-black/5 focus-visible:outline-[3px] data-pressed:bg-blue-600 data-pressed:text-white dark:text-neutral-400 dark:hover:bg-white/10 dark:data-pressed:text-white"
                >
                  M↓
                </Toggle>
              </Tip>
              <span className="min-w-0 flex-1 truncate text-[12px] text-red-500">{error}</span>
              {!error &&
                draft.mode === "forward" &&
                !draft.forwardAsAttachment &&
                account?.provider !== "outlook" && (
                  <span className="shrink-0 text-[12px] text-neutral-400">
                    <Trans>Attachments of the original message are not forwarded</Trans>
                  </span>
                )}
              <Tip label={t`Discard draft`} side="top">
                <button
                  type="button"
                  aria-label={t`Discard draft`}
                  onClick={() => onDiscard(draft)}
                  className={quiet}
                >
                  <Trash2 className="size-4" />
                </button>
              </Tip>
            </footer>
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

          <Alert
            open={asking !== null}
            onOpenChange={(open) => {
              if (!open) setAsking(null);
            }}
            title={t`The message mentions an attachment, but none is added.`}
          >
            <AlertCancel>
              <Trans>Cancel</Trans>
            </AlertCancel>
            <button
              type="button"
              autoFocus
              // Nothing is sent: the prompt closes and the file picker opens.
              onClick={() => {
                setAsking(null);
                fileRef.current?.click();
              }}
              className={alertButton}
            >
              <Trans>Add attachment</Trans>
            </button>
            <button
              type="button"
              onClick={() => {
                if (asking) submit(asking.archive, true);
              }}
              className={alertPrimary}
            >
              <Trans>Send anyway</Trans>
            </button>
          </Alert>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
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
  open,
  onOpenChange,
  trigger,
  tip,
  draft,
  onInsert,
  bodyRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactElement;
  tip: { label: string; shortcut: string };
  draft: Draft;
  onInsert: (t: Template) => void;
  bodyRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const { t } = useLingui();
  const templates = AsyncResult.getOrElse(useAtomValue(templatesAtom), () => []);
  const saveTemplate = useAtomSet(saveTemplateAtom);
  const [filter, setFilter] = useState("");
  const [naming, setNaming] = useState(false);
  // A template placeholder, shown as is.
  const token = "{first_name}";

  const reset = () => {
    setFilter("");
    setNaming(false);
  };

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
    onOpenChange(false);
    reset();
  };

  return (
    <PickerPopover
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
      trigger={trigger}
      tip={tip}
      side="top"
      finalFocus={bodyRef}
      className="w-80"
    >
      {naming ? (
        <input
          // The footer button switched modes; typing continues here.
          autoFocus
          aria-label={t`Template name`}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              keep();
            }
          }}
          placeholder={t`Name the template, then press Return`}
          className={pickerInput}
        />
      ) : (
        <Autocomplete.Root
          inline
          open
          items={templates}
          itemToStringValue={(tpl: Template) => tpl.name}
          value={filter}
          onValueChange={(v) => setFilter(v)}
          autoHighlight="always"
          keepHighlight
        >
          <Autocomplete.Input
            aria-label={t`Search templates`}
            placeholder={t`Templates…`}
            className={pickerInput}
          />
          {templates.length === 0 && (
            <p className="px-3 py-2 text-neutral-400">
              <Trans>No templates yet. Use {token} for the first recipient's name.</Trans>
            </p>
          )}
          <Autocomplete.List className={pickerList}>
            {(tpl: Template) => (
              <Autocomplete.Item
                key={tpl.id}
                value={tpl}
                onClick={() => {
                  onInsert(tpl);
                  reset();
                }}
                className={pickerItem}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{tpl.name}</span>
                  <span className="block truncate text-[12px] text-neutral-500 group-data-highlighted:text-white/80">
                    {tpl.subject || tpl.body.replace(/\s+/g, " ").slice(0, 60)}
                  </span>
                </span>
              </Autocomplete.Item>
            )}
          </Autocomplete.List>
        </Autocomplete.Root>
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
        className={pickerFooter}
      >
        {naming ? <Trans>Save</Trans> : <Trans>Save this message as a template…</Trans>}
      </button>
    </PickerPopover>
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

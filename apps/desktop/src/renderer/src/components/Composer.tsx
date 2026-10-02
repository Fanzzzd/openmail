import { matchesShortcut } from "../../../shared/shortcuts";
import { useShortcutText } from "./SystemSettings";
import { Autocomplete } from "@base-ui/react/autocomplete";
import { Dialog } from "@base-ui/react/dialog";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  DEFAULT_PREFS,
  applySignature,
  composeEditorText,
  fillTemplate,
  ownText,
} from "@openmail/core/schema";
import { Effect } from "effect";
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
  switchReplyMode,
  toDraftInput,
} from "../draft";
import { requestDraftClose } from "../draft-close";
import { submitDraft, type SendWarning } from "../send";
import { formatBytes } from "../format";
import { openDraft, useRunMail } from "../state/mail";
import { Keys } from "../state/keys";
import { saveDraftAtom, saveTemplateAtom } from "../state/mutations";
import { templatesAtom, sendAsAtom, prefsAtom, threadAtom } from "../state/queries";
import { RecipientField } from "./RecipientField";
import { ComposeEditor } from "./ComposeEditor";
import {
  editorBody,
  insertEditorText,
  replaceEditorText,
  type ComposeElement,
} from "../compose-editor-dom";
import { Alert, AlertCancel, alertButton, alertPrimary, alertDanger } from "./ui/Dialog";
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
  signatureFor: (accountId: string, mode: ComposeMode, from?: string) => string | undefined;
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
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  const shortcut = useShortcutText();
  const [draft, setDraft] = useState(initial);
  const [showBcc, setShowBcc] = useState(Boolean(initial.bcc || initial.cc));
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<{
    warning: SendWarning;
    archive: boolean;
    confirmed: readonly SendWarning[];
  } | null>(null);
  const run = useRunMail();
  const [closing, setClosing] = useState(false);
  const [checkingClose, setCheckingClose] = useState(false);
  const ccRef = useRef<HTMLInputElement>(null);
  const sourceThread = AsyncResult.getOrElse(
    useAtomValue(threadAtom(initial.inReplyTo ?? null)),
    () => [],
  );
  const original = sourceThread.find((m) => m.id === initial.inReplyTo);
  const [picker, setPicker] = useState(false);
  const [saveState, save] = useAtom(saveDraftAtom(initial.id));
  const fileRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<ComposeElement>(null);
  const selectionRef = useRef<Range>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const account = accounts.find((a) => a.id === draft.accountId);
  const aliases = AsyncResult.getOrElse(useAtomValue(sendAsAtom), () => []);
  const senders = accounts
    .filter((a) => a.enabled !== false)
    .flatMap((a) => [
      { accountId: a.id, address: a.email, name: a.description?.trim() || "" },
      ...aliases
        .filter(
          (alias) =>
            alias.accountId === a.id && alias.address.toLowerCase() !== a.email.toLowerCase(),
        )
        .map((alias) => ({ accountId: a.id, address: alias.address, name: alias.name })),
    ]);
  const availableSenders =
    draft.mode === "new" ? senders : senders.filter((s) => s.accountId === draft.accountId);
  const empty = isEmpty(draft, signatureFor(draft.accountId, draft.mode, draft.from?.address));
  const replying = draft.mode === "reply" || draft.mode === "replyAll";
  const set = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setAsking(null);
  };

  /** New messages and forwards start in To; replies start typing above the quote. */
  const initialFocus = () => {
    if (initial.mode === "new" || initial.mode === "forward") return toRef.current;
    if (bodyRef.current instanceof HTMLTextAreaElement) bodyRef.current.setSelectionRange(0, 0);
    else if (bodyRef.current) {
      const range = document.createRange();
      range.selectNodeContents(bodyRef.current);
      range.collapse(true);
      selectionRef.current = range;
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    }
    return bodyRef.current;
  };

  // Autosave: locally at once, then to the provider through the queue.
  const saved = useRef(initial);
  useEffect(() => {
    const due = !closing && !checkingClose && draft !== saved.current && !empty;
    const timer = due
      ? setTimeout(() => {
          saved.current = draft;
          save(toDraftInput(draft));
        }, AUTOSAVE_MS)
      : undefined;
    return () => clearTimeout(timer);
  }, [draft, save, closing, checkingClose, empty]);

  const submit = (archive: boolean, confirmed: readonly SendWarning[] = []) => {
    const result = submitDraft(draft, archive, confirmed, onSend);
    switch (result.kind) {
      case "invalid": {
        const list = result.addresses.join(
          t({ message: ", ", comment: "Separator between list items" }),
        );
        setError(t`These are not email addresses: ${list}`);
        break;
      }
      case "noRecipients":
        setError(t`Add at least one recipient`);
        break;
      case "confirm":
        setError(null);
        setAsking({ warning: result.warning, archive, confirmed });
        break;
      case "sent":
        setAsking(null);
        break;
    }
  };

  const close = () => {
    if (closing || checkingClose || saveState.waiting) return;
    setCheckingClose(true);
    run(
      requestDraftClose({ draft, initial, empty, lookup: openDraft(draft.id) }).pipe(
        Effect.matchCause({
          onSuccess: (action) => {
            setCheckingClose(false);
            if (action === "prompt") setClosing(true);
            else onClose(draft, false);
          },
          onFailure: () => {
            setCheckingClose(false);
            setClosing(true);
          },
        }),
      ),
    );
  };

  useEffect(() => {
    // Bubble phase: fields that handle a key themselves (suggestions) mark it handled first.
    // Escape belongs to the dialog: it closes the innermost popup, then the window.
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || asking || closing || checkingClose) return;
      if (matchesShortcut(prefs.shortcutSet, "sendArchive", e)) {
        e.preventDefault();
        submit(true);
      } else if (matchesShortcut(prefs.shortcutSet, "send", e)) {
        e.preventDefault();
        submit(false);
      } else if (matchesShortcut(prefs.shortcutSet, "attach", e)) {
        e.preventDefault();
        fileRef.current?.click();
      } else if (matchesShortcut(prefs.shortcutSet, "saveDraft", e)) {
        e.preventDefault();
        saved.current = draft;
        save(toDraftInput(draft));
      } else if (matchesShortcut(prefs.shortcutSet, "closeCompose", e) && e.key !== "Escape") {
        e.preventDefault();
        close();
      } else if (matchesShortcut(prefs.shortcutSet, "showCc", e)) {
        e.preventDefault();
        setShowBcc(true);
        requestAnimationFrame(() => ccRef.current?.focus());
      } else if (matchesShortcut(prefs.shortcutSet, "templates", e)) {
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

  const changeSender = (key: string) => {
    const sender = senders.find((s) => `${s.accountId}/${s.address}` === key);
    if (!sender) return;
    const text = applySignature(
      composeEditorText(draft.body),
      signatureFor(draft.accountId, draft.mode, draft.from?.address),
      signatureFor(sender.accountId, draft.mode, sender.address),
    );
    if (
      bodyRef.current &&
      text !== composeEditorText(draft.body) &&
      (bodyRef.current instanceof HTMLTextAreaElement || bodyRef.current.isContentEditable)
    )
      replaceEditorText(bodyRef.current, composeEditorText(draft.body), text);
    set({
      accountId: sender.accountId,
      from: { name: sender.name, address: sender.address },
      body: bodyRef.current ? editorBody(bodyRef.current, draft.body) : draft.body,
    });
  };

  const insertTemplate = (template: Template) => {
    if (bodyRef.current instanceof HTMLDivElement && !bodyRef.current.isContentEditable) {
      setError(t`Choose Edit body before inserting a template.`);
      return;
    }
    const to = merge(draft.to, template.to);
    const cc = merge(draft.cc, template.cc);
    const bcc = merge(draft.bcc, template.bcc ?? []);
    const first = parseAddresses(to).addresses[0];
    const text = fillTemplate(template.body, first);
    if (bodyRef.current) insertEditorText(bodyRef.current, text, selectionRef.current);
    set({
      to,
      cc,
      bcc,
      subject: template.subject ? fillTemplate(template.subject, first) : draft.subject,
      body: bodyRef.current ? editorBody(bodyRef.current, draft.body) : draft.body,
    });
    if (cc || bcc) setShowBcc(true);
    setPicker(false);
    requestAnimationFrame(() => bodyRef.current?.focus());
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
              {original && account && (
                <Select
                  aria-label={t`Reply mode`}
                  value={draft.mode}
                  options={[
                    { value: "reply", label: t`Reply` },
                    { value: "replyAll", label: t`Reply All` },
                    { value: "forward", label: t`Forward` },
                  ]}
                  onValueChange={(mode) => {
                    if (mode === "reply" || mode === "replyAll" || mode === "forward") {
                      setDraft(switchReplyMode(draft, mode, original, account, aliases));
                      if (mode === "replyAll") setShowBcc(true);
                    }
                  }}
                />
              )}

              {draft.proposalId !== undefined && (
                <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[11px] text-violet-700 dark:text-violet-300">
                  <Trans>AI draft</Trans>
                </span>
              )}
              <span className="flex-1 truncate text-[12px] text-neutral-400">{status}</span>
              <Tip label={t`Close`} shortcut={shortcut("closeCompose")}>
                <button
                  type="button"
                  aria-label={t`Close`}
                  disabled={checkingClose || saveState.waiting}
                  onClick={close}
                  className={quiet}
                >
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
                value={`${draft.accountId}/${draft.from?.address ?? account?.email ?? ""}`}
                onValueChange={changeSender}
                options={availableSenders.map((sender) => ({
                  value: `${sender.accountId}/${sender.address}`,
                  label: sender.name ? `${sender.name} (${sender.address})` : sender.address,
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
                showFullAddresses={prefs.showFullRecipientAddresses}
                from={draft.from?.address ?? account?.email}
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
                    inputRef={ccRef}
                    value={draft.cc}
                    onChange={(cc) => set({ cc })}
                    showFullAddresses={prefs.showFullRecipientAddresses}
                    from={draft.from?.address ?? account?.email}
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
                    showFullAddresses={prefs.showFullRecipientAddresses}
                    from={draft.from?.address ?? account?.email}
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

            <ComposeEditor
              body={draft.body}
              onChange={(body) => set({ body })}
              bodyRef={bodyRef}
              selectionRef={selectionRef}
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
              <Tip label={t`Send`} shortcut={shortcut("send")} side="top">
                <button
                  type="submit"
                  className="h-7 rounded-md bg-blue-600 px-3.5 font-medium text-white hover:bg-blue-700"
                >
                  <Trans>Send</Trans>
                </button>
              </Tip>
              {replying && (
                <Tip label={t`Send and archive`} shortcut={shortcut("sendArchive")} side="top">
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
                tip={{ label: t`Templates`, shortcut: shortcut("templates") }}
                trigger={
                  <button type="button" aria-label={t`Templates`} className={quiet}>
                    <FileText className="size-4" />
                  </button>
                }
              />
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
            open={closing}
            onOpenChange={setClosing}
            title={t`Save this draft before closing?`}
            description={t`This draft has unsaved changes or is waiting to sync.`}
          >
            <AlertCancel>
              <Trans>Cancel</Trans>
            </AlertCancel>
            <button type="button" onClick={() => onDiscard(draft)} className={alertDanger}>
              <Trans>Delete</Trans>
            </button>
            <button type="button" onClick={() => onClose(draft, true)} className={alertPrimary}>
              <Trans>Save</Trans>
            </button>
          </Alert>
          <Alert
            open={asking !== null}
            onOpenChange={(open) => {
              if (!open) setAsking(null);
            }}
            title={
              asking?.warning === "subject"
                ? t`Send this message without a subject?`
                : t`The message mentions an attachment, but none is added.`
            }
          >
            <AlertCancel>
              <Trans>Cancel</Trans>
            </AlertCancel>
            {asking?.warning === "attachment" && (
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
            )}
            <button
              type="button"
              onClick={() => {
                if (asking) submit(asking.archive, [...asking.confirmed, asking.warning]);
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
  bodyRef: RefObject<ComposeElement | null>;
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
          bcc: parseAddresses(draft.bcc).addresses,
          body: ownText(draft.body.text),
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

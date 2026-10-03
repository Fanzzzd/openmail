import { ServiceHint } from "./OptionalServices";
import { DropdownMenu, MenuItem } from "./ui/Menu";
import { Autocomplete } from "@base-ui/react/autocomplete";
import { Dialog } from "@base-ui/react/dialog";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { customTemplateVariables, ownText, reorderAttachments } from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import { FileText, Paperclip, Trash2, X } from "lucide-react";
import { useId, useRef, useState, type ReactElement, type RefObject } from "react";
import type { Account, OutgoingMessage, Template } from "../../../shared/api";
import { type ComposeElement } from "../compose-editor-dom";
import { inheritsOriginals } from "../compose-originals";
import { useComposeDraft } from "../compose/use-compose-draft";
import { useComposeEditor } from "../compose/use-compose-editor";
import { useComposeRecipients } from "../compose/use-compose-recipients";
import { useComposeSend } from "../compose/use-compose-send";
import { useComposeShortcuts } from "../compose/use-compose-shortcuts";
import { useDraftLifecycle } from "../compose/use-draft-lifecycle";
import { isEmpty, parseAddresses, switchReplyMode, type ComposeMode, type Draft } from "../draft";
import { formatBytes } from "../format";
import { Keys } from "../state/keys";
import { useRunMail } from "../state/mail";
import { saveTemplateAtom, setPrefsAtom } from "../state/mutations";
import { nativeComposeCapabilitiesAtom, templatesAtom, threadAtom } from "../state/queries";
import { useShortcutText } from "../use-shortcut-text";
import { ComposeEditor } from "./ComposeEditor";
import { ComposerAi } from "./ComposerAi";
import { DraftOrganization } from "./DraftOrganization";
import { DraftSyncRecovery } from "./DraftSyncRecovery";
import { RecipientField } from "./RecipientField";
import { Alert, AlertCancel, alertButton, alertDanger, alertPrimary } from "./ui/Dialog";
import { PickerPopover, pickerFooter, pickerInput, pickerItem, pickerList } from "./ui/Picker";
import { Select } from "./ui/Select";
import { Tip } from "./ui/Tip";

const TITLES: Record<Draft["mode"], MessageDescriptor> = {
  new: msg`New Message`,
  reply: msg`Reply`,
  replyAll: msg`Reply All`,
  forward: msg`Forward`,
};

interface Props {
  standalone?: boolean;
  closeRequested?: number;
  popOutRequested?: number;
  onPopOut?: (draft: Draft) => void;
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
  standalone = false,
  closeRequested = 0,
  popOutRequested = 0,
  onPopOut,
  draft: initial,
  accounts,
  signatureFor,
  onClose,
  onDiscard,
  onSend,
}: Props) {
  const errorId = useId();
  const messages = useComposeMessages();
  const { t, i18n } = useLingui();
  const { draft, setDraft, prefs } = useComposeDraft(initial);
  const shortcut = useShortcutText();
  const nativeCapabilities = AsyncResult.getOrElse(
    useAtomValue(nativeComposeCapabilitiesAtom),
    () => ({ photos: false, continuity: false, grammar: false }),
  );
  const setPrefs = useAtomSet(setPrefsAtom);
  const set = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setAsking(null);
  };

  const run = useRunMail();
  const ccRef = useRef<HTMLInputElement>(null);
  const sourceThread = AsyncResult.getOrElse(
    useAtomValue(threadAtom(initial.inReplyTo ?? null)),
    () => [],
  );
  const original = sourceThread.find((m) => m.id === initial.inReplyTo);
  const [adding, setAdding] = useState(Boolean(initial.loadOriginalAttachments));
  const recipients = useComposeRecipients({ initial, accounts, draft, prefs, setDraft, set, run });
  const {
    account,
    aliases,
    currentSignature,
    currentAddress,
    localSignatures,
    availableSenders,
    showBcc,
    setShowBcc,
    moveChip,
    dropChip,
    selectSender,
    revertSender,
    chooseSignature,
    senderUndo,
    changeRecipients,
    currentFrom,
    addMention,
    removeMentions,
  } = recipients;

  const empty = isEmpty(
    draft,
    currentSignature?.text ??
      (draft.signatureId === undefined
        ? signatureFor(draft.accountId, draft.mode, draft.from?.address)
        : undefined),
    prefs,
  );
  const replying = draft.mode === "reply" || draft.mode === "replyAll";
  const sendFlow = useComposeSend({
    messages,
    adding,
    account,
    draft,
    onSend,
    currentSignature,
    prefs,
  });
  const { error, setError, asking, setAsking, showAttachmentProblem, submit } = sendFlow;

  const editor = useComposeEditor({
    messages,
    initial,
    prefs,
    setDraft,
    adding,
    draft,
    account,
    showAttachmentProblem,
    setError,
    setAdding,
    original,
    set,
    run,
    aliases,
    currentAddress,
    setShowBcc,
  });
  const {
    imageUrl,
    setImageUrl,
    imageUrlOpen,
    setImageUrlOpen,
    imageFileRef,
    attachmentDrag,
    picker,
    setPicker,
    templateForm,
    setTemplateForm,
    templateValues,
    setTemplateValues,
    fileRef,
    bodyRef,
    selectionRef,
    toRef,
    initialFocus,
    addFiles,
    pickNativeImages,
    toggleOriginalAttachments,
    loadImageUrl,
    addImageFiles,
    insertTemplate,
  } = editor;

  const lifecycle = useDraftLifecycle({
    messages,
    initial,
    draft,
    run,
    adding,
    empty,
    setDraft,
    setAdding,
    setError,
    onClose,
    onPopOut,
    popOutRequested,
    closeRequested,
  });
  const {
    saveState,
    saveNow,
    closing,
    setClosing,
    checkingClose,
    recover,
    recovering,
    recoveryError,
    syncStatus,
    close,
    status,
  } = lifecycle;

  useComposeShortcuts({ draft, prefs, recipients, sendFlow, editor, lifecycle, ccRef });

  const field =
    "h-9 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-a11y-muted";
  const row =
    "flex items-start gap-2 focus-within:ring-2 focus-within:ring-inset focus-within:ring-a11y-focus border-b border-black/[0.07] px-4 dark:border-white/[0.08]";
  const label = "flex h-9 w-14 shrink-0 items-center text-a11y-muted";
  const quiet =
    "rounded p-1 text-a11y-muted outline-offset-0 outline-a11y-focus hover:bg-black/5 focus-visible:outline-[3px] data-popup-open:bg-black/5 dark:hover:bg-white/10 dark:data-popup-open:bg-white/10";
  const title = i18n._(TITLES[draft.mode]);

  return (
    // Trap keyboard focus while the composer is open; Escape follows the draft-close flow.
    <Dialog.Root
      open
      modal="trap-focus"
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
          data-compose
          data-full-window={standalone || undefined}
          aria-label={title}
          initialFocus={initialFocus}
          className={`${standalone ? "no-drag fixed inset-0 z-50 flex h-full w-full " : "no-drag fixed right-5 bottom-5 z-50 flex h-[min(680px,calc(100%-40px))] w-[min(680px,calc(100%-40px))] "} flex-col overflow-hidden rounded-xl bg-white text-[13px] text-neutral-900 shadow-2xl ring-1 ring-black/10 outline-none transition-[opacity,translate] duration-150 ease-out data-starting-style:translate-y-2 data-starting-style:opacity-0 motion-reduce:transition-none dark:bg-neutral-800 dark:text-neutral-100 dark:ring-white/10`}
        >
          {standalone && <div className="drag h-8 shrink-0" />}
          {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- The entire composer accepts file drops; the attachment picker provides keyboard access. */}
          <form
            className="flex min-h-[360px] flex-1 flex-col overflow-y-auto"
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes("Files")) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (event.dataTransfer.files.length) void addFiles(event.dataTransfer.files);
            }}
            onPasteCapture={editor.onPasteCapture}
            onSubmit={(e) => {
              e.preventDefault();
              submit(false);
            }}
          >
            <header className="flex min-h-11 shrink-0 items-center gap-2 border-b border-black/[0.07] px-4 dark:border-white/[0.08]">
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
              <span className="flex-1 truncate text-[12px] text-a11y-muted">{status}</span>
              {onPopOut && (
                <button
                  type="button"
                  className={quiet}
                  disabled={checkingClose || saveState.waiting}
                  onClick={() => onPopOut(draft)}
                >
                  <Trans>Open in New Window</Trans>
                </button>
              )}
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
                onValueChange={selectSender}
                options={availableSenders.map((sender) => ({
                  value: `${sender.accountId}/${sender.address}`,
                  label: sender.name ? `${sender.name} (${sender.address})` : sender.address,
                }))}
                className="max-w-full"
              />
              {senderUndo && (
                <output className="flex items-center gap-2 text-[12px] text-a11y-muted">
                  {t`From updated`}
                  <button
                    type="button"
                    className="text-a11y-accent"
                    onClick={revertSender}
                  >{t`Revert`}</button>
                </output>
              )}
            </div>
            <ServiceHint accountId={draft.accountId} service="contacts" />
            <div className={row}>
              <span className={label}>
                <Trans>To</Trans>
              </span>
              <RecipientField
                onDragChip={() => setShowBcc(true)}
                aria-describedby={error ? errorId : undefined}
                fieldName="to"
                onMove={(index, target) => moveChip("to", target, index)}
                onDropRecipient={(chip) => dropChip("to", chip)}
                label={t`To`}
                inputRef={toRef}
                value={draft.to}
                onChange={(to) => changeRecipients("to", to)}
                showFullAddresses={prefs.showFullRecipientAddresses}
                from={draft.from?.address ?? account?.email}
              />
              {!showBcc && (
                <button
                  type="button"
                  onClick={() => setShowBcc(true)}
                  className="h-9 shrink-0 text-a11y-muted hover:text-neutral-800 dark:hover:text-neutral-200"
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
                    aria-describedby={error ? errorId : undefined}
                    fieldName="cc"
                    onMove={(index, target) => moveChip("cc", target, index)}
                    onDropRecipient={(chip) => dropChip("cc", chip)}
                    label={t`Cc`}
                    inputRef={ccRef}
                    value={draft.cc}
                    onChange={(cc) => changeRecipients("cc", cc)}
                    showFullAddresses={prefs.showFullRecipientAddresses}
                    from={draft.from?.address ?? account?.email}
                  />
                </div>
                <div className={row}>
                  <span className={label}>
                    <Trans>Bcc</Trans>
                  </span>
                  <RecipientField
                    aria-describedby={error ? errorId : undefined}
                    fieldName="bcc"
                    onMove={(index, target) => moveChip("bcc", target, index)}
                    onDropRecipient={(chip) => dropChip("bcc", chip)}
                    label={t`Bcc`}
                    value={draft.bcc}
                    onChange={(bcc) => changeRecipients("bcc", bcc)}
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
                aria-describedby={error ? errorId : undefined}
                value={draft.subject}
                onChange={(e) => set({ subject: e.target.value })}
                className={field}
              />
            </div>

            {templateForm && (
              <fieldset className="shrink-0 space-y-2 border-b px-4 py-3">
                <legend>{t`Fill template variables`}</legend>
                {customTemplateVariables(templateForm.subject, templateForm.body).map((name) => (
                  <label key={name} className="flex items-center gap-2">
                    <span>{name}</span>
                    <input
                      aria-label={name}
                      value={templateValues[name] ?? ""}
                      className="min-w-0 flex-1 rounded border px-2 py-1"
                      onChange={(event) =>
                        setTemplateValues((previous) => ({
                          ...previous,
                          [name]: event.target.value,
                        }))
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          event.stopPropagation();
                          setTemplateForm(null);
                        }
                        if (event.key === "Enter") {
                          event.preventDefault();
                          insertTemplate(templateForm, templateValues);
                        }
                      }}
                    />
                  </label>
                ))}
                <button
                  type="button"
                  className={alertPrimary}
                  onClick={() => insertTemplate(templateForm, templateValues)}
                >{t`Insert template`}</button>
                <button
                  type="button"
                  className={alertButton}
                  onClick={() => setTemplateForm(null)}
                >{t`Cancel`}</button>
              </fieldset>
            )}
            {imageUrlOpen && (
              <div className="flex items-center gap-2 px-4 py-2">
                <input
                  autoFocus
                  aria-label={t`Image URL`}
                  placeholder="https://"
                  value={imageUrl}
                  onChange={(event) => setImageUrl(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      loadImageUrl();
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      setImageUrlOpen(false);
                    }
                  }}
                  className="min-w-0 flex-1 rounded border bg-transparent px-2 py-1"
                />
                <button
                  type="button"
                  disabled={adding}
                  onClick={loadImageUrl}
                >{t`Insert image`}</button>
                <button type="button" onClick={() => setImageUrlOpen(false)}>{t`Cancel`}</button>
              </div>
            )}
            <div className="flex shrink-0 items-center gap-3 border-b px-4 py-2">
              <span className="text-a11y-muted">{t`Signature`}</span>
              <Select
                aria-label={t`Signature`}
                value={draft.signatureId === undefined ? "default" : (draft.signatureId ?? "none")}
                options={[
                  { value: "default", label: t`Default signature` },
                  { value: "none", label: t`None` },
                  ...localSignatures.map((s) => ({
                    value: s.id,
                    label: s.source === "gmail" ? t`Gmail default` : s.name,
                  })),
                ]}
                onValueChange={chooseSignature}
              />
            </div>
            <DraftSyncRecovery
              draft={syncStatus ?? initial}
              busy={recovering}
              onRecover={recover}
            />
            {recoveryError && (
              <output role="alert" className="px-4 text-a11y-danger">
                {recoveryError}
              </output>
            )}
            <ComposerAi
              accountId={draft.accountId}
              replyTo={draft.inReplyTo}
              body={draft.body}
              bodyRef={bodyRef}
              selectionRef={selectionRef}
              onChange={(body) => set({ body })}
            />
            <ComposeEditor
              shortcutSet={prefs.shortcutSet}
              prefs={prefs}
              from={currentFrom}
              onImageSize={(inlineImageSize) =>
                setPrefs({ payload: { patch: { inlineImageSize } }, reactivityKeys: [Keys.prefs] })
              }
              onMention={addMention}
              onMentionsChange={removeMentions}
              body={draft.body}
              attachments={draft.attachments}
              onChange={(body) => set({ body })}
              bodyRef={bodyRef}
              selectionRef={selectionRef}
            />

            {original && !draft.forwardAsAttachment && (
              <label className="flex items-center gap-2 px-4 py-2">
                <input
                  type="checkbox"
                  checked={
                    draft.includeOriginalAttachments ?? inheritsOriginals(draft, account?.provider)
                  }
                  disabled={adding}
                  onChange={toggleOriginalAttachments}
                />
                <span>{t`Include original attachments`}</span>
              </label>
            )}
            {inheritsOriginals(draft, account?.provider) && original?.attachments.length ? (
              <output className="px-4 py-2">{t`Original attachments are kept in Outlook without uploading them again.`}</output>
            ) : null}
            {adding && <output className="px-4 py-2">{t`Loading attachments…`}</output>}
            {(draft.attachments.length > 0 || draft.forwardAsAttachment) && (
              <div className="flex flex-wrap gap-2 px-4 pb-2">
                {draft.forwardAsAttachment && (
                  <span className="flex items-center gap-1.5 rounded-md border border-black/10 px-2 py-1 dark:border-white/10">
                    <Paperclip className="size-3.5 text-a11y-muted" />
                    <Trans>Original message (.eml)</Trans>
                    <button
                      type="button"
                      aria-label={t`Don't attach the original message`}
                      onClick={() => set({ forwardAsAttachment: false })}
                      className="text-a11y-muted hover:text-neutral-700 dark:hover:text-neutral-200"
                    >
                      <X className="size-3.5" />
                    </button>
                  </span>
                )}
                {draft.attachments.map((a, i) => (
                  <span
                    key={`${a.filename}-${i}`}
                    draggable
                    onDragStart={(event) => {
                      attachmentDrag.current = i;
                      event.dataTransfer.setData("application/x-openmail-attachment", String(i));
                      event.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={() => {
                      attachmentDrag.current = null;
                    }}
                    onDragOver={(event) => {
                      if (attachmentDrag.current !== null) {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                      }
                    }}
                    onDrop={(event) => {
                      if (attachmentDrag.current !== null) {
                        event.preventDefault();
                        event.stopPropagation();
                        set({
                          attachments: reorderAttachments(
                            draft.attachments,
                            attachmentDrag.current,
                            i,
                          ),
                        });
                        attachmentDrag.current = null;
                      }
                    }}
                    className="flex items-center gap-1.5 rounded-md border border-black/10 px-2 py-1 dark:border-white/10"
                  >
                    <Paperclip className="size-3.5 text-a11y-muted" />
                    {a.filename}
                    <button
                      type="button"
                      disabled={i === 0}
                      aria-label={t`Move ${a.filename} earlier`}
                      onClick={() =>
                        set({ attachments: reorderAttachments(draft.attachments, i, i - 1) })
                      }
                      className={quiet}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      disabled={i === draft.attachments.length - 1}
                      aria-label={t`Move ${a.filename} later`}
                      onClick={() =>
                        set({ attachments: reorderAttachments(draft.attachments, i, i + 1) })
                      }
                      className={quiet}
                    >
                      ↓
                    </button>
                    <span className="text-a11y-muted">
                      {formatBytes((a.content.length * 3) / 4, i18n.locale)}
                    </span>
                    <button
                      type="button"
                      aria-label={t`Remove ${a.filename}`}
                      onClick={() =>
                        set({ attachments: draft.attachments.filter((_, j) => j !== i) })
                      }
                      className="text-a11y-muted hover:text-neutral-700 dark:hover:text-neutral-200"
                    >
                      <X className="size-3.5" />
                    </button>
                  </span>
                ))}
              </div>
            )}

            <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-black/[0.07] px-4 py-2.5 dark:border-white/[0.08]">
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
              {nativeCapabilities.photos || nativeCapabilities.continuity ? (
                <DropdownMenu
                  align="start"
                  trigger={
                    <button
                      type="button"
                      aria-label={t`Attach files`}
                      disabled={adding}
                      className={quiet}
                    >
                      <Paperclip className="size-4" />
                    </button>
                  }
                >
                  <MenuItem onClick={() => fileRef.current?.click()}>{t`Attach files`}</MenuItem>
                  {nativeCapabilities.photos && (
                    <MenuItem onClick={() => pickNativeImages("photos")}>{t`Photos`}</MenuItem>
                  )}
                  {nativeCapabilities.continuity && (
                    <MenuItem
                      onClick={() => pickNativeImages("continuity")}
                    >{t`Import from iPhone or iPad`}</MenuItem>
                  )}
                </DropdownMenu>
              ) : (
                <Tip label={t`Attach files`} side="top">
                  <button
                    type="button"
                    aria-label={t`Attach files`}
                    disabled={adding}
                    onClick={() => fileRef.current?.click()}
                    className={quiet}
                  >
                    <Paperclip className="size-4" />
                  </button>
                </Tip>
              )}
              {account && (
                <DraftOrganization
                  provider={account.provider}
                  accountId={account.id}
                  value={draft.organization ?? { labels: [], starred: false }}
                  onChange={(organization) => {
                    const next = { ...draft, organization };
                    setDraft(next);
                    saveNow(next);
                  }}
                />
              )}
              {draft.body.kind === "rich" && (
                <>
                  <button
                    type="button"
                    disabled={adding}
                    className={quiet}
                    onClick={() => imageFileRef.current?.click()}
                  >{t`Image file`}</button>
                  <button
                    type="button"
                    disabled={adding}
                    className={quiet}
                    onClick={() => setImageUrlOpen((open) => !open)}
                  >{t`Image URL`}</button>
                </>
              )}
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
              <span
                id={errorId}
                role="alert"
                className="min-w-0 flex-1 text-[12px] text-a11y-danger"
              >
                {error}
              </span>
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
              ref={imageFileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              hidden
              onChange={(event) => {
                void addImageFiles(event.target.files);
                event.target.value = "";
              }}
            />
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

export function useComposeMessages() {
  const { t } = useLingui();
  return {
    couldntLoadTheOriginalAttachments: (reason: string) =>
      t`Couldn't load the original attachments: ${reason}`,
    saving: t`Saving…`,
    couldntSave: t`Couldn't save`,
    keptOnThisMac: t`Kept on this Mac`,
    couldntSync: t`Couldn't sync`,
    savedOnThisMacRetryingSyncAutomatically: t`Saved on this Mac. Retrying sync automatically.`,
    saved: t`Saved`,
    savedOnThisMacSyncsWhenOnline: t`Saved on this Mac. Syncs when online.`,
    waitForAttachmentsToFinishLoading: t`Wait for attachments to finish loading.`,
    listSeparator: t({ message: ", ", comment: "Separator between list items" }),
    theseAreNotEmailAddresses: (list: string) => t`These are not email addresses: ${list}`,
    addAtLeastOneRecipient: t`Add at least one recipient`,
    attachmentsExceedThe30MBComposeLimit: t`Attachments exceed the 30 MB compose limit.`,
    couldntReadTheAttachmentTryAddingIt: t`Couldn't read the attachment. Try adding it again.`,
    couldntLoadTheOriginalAttachmentsTryAgain: t`Couldn't load the original attachments. Try again.`,
    chooseBeforeInsertingAnImage: (editBody: string) =>
      t({
        message: `Choose ${editBody} before inserting an image.`,
        context: "message text instruction",
        comment: "editBody is the exact translated Edit body button label. Preserve it unchanged.",
      }),
    couldntInsertTheImageUseAPublic: t`Couldn't insert the image. Use a public PNG, JPEG, GIF or WebP image up to 8 MB.`,
    useAnImageUpTo8MB: t`Use an image up to 8 MB.`,
    usePNGJPEGGIFOrWebPImages: t`Use PNG, JPEG, GIF or WebP images up to 8 MB.`,
    couldntReadTheImage: t`Couldn't read the image.`,
    chooseBeforeInsertingATemplate: (editBody: string) =>
      t({
        message: `Choose ${editBody} before inserting a template.`,
        context: "message text instruction",
        comment: "editBody is the exact translated Edit body button label. Preserve it unchanged.",
      }),
    couldntReadTheClipboardAttachment: t`Couldn't read the clipboard attachment.`,
    gmailSize: t`Gmail attachments exceed 25 MB in total. Remove attachments before sending.`,
    gmailBlocked: (filename: string) =>
      t`Gmail blocks ${filename}. Remove this attachment before sending.`,
    outlookSize: t`This app supports Outlook attachments up to 3 MB in total. Large attachment uploads are not supported yet. Remove attachments before sending.`,
  };
}
export type ComposeMessages = ReturnType<typeof useComposeMessages>;

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
      aria-label={t`Templates`}
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
            <p className="px-3 py-2 text-a11y-muted">
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
                  <span className="block truncate text-[12px] text-a11y-muted group-data-highlighted:text-white">
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

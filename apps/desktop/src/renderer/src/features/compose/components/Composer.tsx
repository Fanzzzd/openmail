import { isEmpty, switchReplyMode, type ComposeMode, type Draft } from "../draft";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { Account, OutgoingMessage } from "../../../../../shared/api";
import { useId, useRef, useState } from "react";
import { useComposeMessages } from "../hooks/use-compose-messages";
import { Trans, useLingui } from "@lingui/react/macro";
import { useComposeDraft } from "../hooks/use-compose-draft";
import { useShortcutText } from "../../../i18n/use-shortcut-text";
import { AsyncResult } from "effect/reactivity";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { nativeComposeCapabilitiesAtom, threadAtom } from "../../../state/queries";
import { setPrefsAtom } from "../../../state/mutations";
import { useRunMail } from "../../../state/mail";
import { useComposeRecipients } from "../hooks/use-compose-recipients";
import { useComposeSend } from "../hooks/use-compose-send";
import { useComposeEditor } from "../hooks/use-compose-editor";
import { useDraftLifecycle } from "../hooks/use-draft-lifecycle";
import { useComposeShortcuts } from "../hooks/use-compose-shortcuts";
import { titlebarRow, touchTarget } from "../../../ui/styles";
import { Dialog } from "@base-ui/react/dialog";
import { SheetDragStrip, narrowSheet } from "../../../ui/Dialog";
import { TrafficLightSpace } from "../../../ui/TrafficLights";
import { Select } from "../../../ui/Select";
import { AppWindow, Ellipsis, FileText, ImagePlus, Link, Paperclip, Trash2, X } from "lucide-react";
import { Tip } from "../../../ui/Tip";
import { DraftSyncRecovery } from "./DraftSyncRecovery";
import { ComposerAi } from "./ComposerAi";
import { ComposeEditor } from "./ComposeEditor";
import { Keys } from "../../../state/keys";
import { inheritsOriginals } from "../compose-originals";
import { DropdownMenu, MenuItem } from "../../../ui/Menu";
import { DraftOrganization } from "./DraftOrganization";
import { TemplatePicker } from "./TemplatePicker";
import { TemplateVariables } from "./TemplateVariables";
import { ComposeAttachments } from "./ComposeAttachments";
import { ComposerAlerts } from "./ComposerAlerts";
import { label, quiet, row } from "./composer-styles";
import { AddressFields } from "./AddressFields";

const TITLES: Record<Draft["mode"], MessageDescriptor> = {
  new: msg`New message`,
  reply: msg`Reply`,
  replyAll: msg`Reply all`,
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
    setShowBcc,
    chooseSignature,
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
    "h-9 min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-a11y-muted";
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
          className={`${standalone ? "no-drag fixed inset-0 z-50 flex h-full w-full " : `no-drag fixed right-5 bottom-5 z-50 flex h-[min(680px,calc(100%-40px))] w-[min(680px,calc(100%-40px))] ${narrowSheet()} `} flex-col overflow-hidden rounded-sheet bg-raised text-body text-neutral-900 shadow-sheet outline-none transition-[opacity,translate] duration-150 ease-out data-starting-style:translate-y-2 data-starting-style:opacity-0 motion-reduce:transition-none dark:text-neutral-100`}
        >
          {!standalone && <SheetDragStrip />}
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
            {/* In its own window the header is the titlebar: it holds the traffic lights and
                stays on top while the form scrolls. */}
            <header
              className={`${standalone ? `${titlebarRow} sticky top-0 z-10 bg-raised` : "flex min-h-11 shrink-0 items-center"} gap-2 border-b border-separator px-4`}
            >
              <TrafficLightSpace />
              <Dialog.Title className="text-callout font-semibold">{title}</Dialog.Title>
              {original && account && (
                <Select
                  aria-label={t`Reply mode`}
                  value={draft.mode}
                  options={[
                    { value: "reply", label: t`Reply` },
                    { value: "replyAll", label: t`Reply all` },
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
                <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-caption text-violet-700 dark:text-violet-300">
                  <Trans>AI draft</Trans>
                </span>
              )}
              <span className="flex-1 truncate text-footnote text-a11y-muted">{status}</span>
              {onPopOut && (
                <button
                  type="button"
                  className={quiet}
                  disabled={checkingClose || saveState.waiting}
                  onClick={() => onPopOut(draft)}
                >
                  <AppWindow className="size-4 sm:hidden" />
                  <span className="max-sm:sr-only">
                    <Trans>Open in new window</Trans>
                  </span>
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

            <AddressFields
              draft={draft}
              prefs={prefs}
              recipients={recipients}
              describedBy={error ? errorId : undefined}
              toRef={toRef}
              ccRef={ccRef}
            />
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
              <TemplateVariables
                template={templateForm}
                values={templateValues}
                setValues={setTemplateValues}
                onInsert={insertTemplate}
                onCancel={() => setTemplateForm(null)}
              />
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
                  className="min-w-0 flex-1 rounded border bg-transparent px-2 py-1 border-separator"
                />
                <button
                  type="button"
                  disabled={adding}
                  onClick={loadImageUrl}
                >{t`Insert image`}</button>
                <button type="button" onClick={() => setImageUrlOpen(false)}>{t`Cancel`}</button>
              </div>
            )}
            <div className="flex shrink-0 items-center gap-3 border-b border-separator px-4 py-2">
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
            <ComposeAttachments draft={draft} set={set} attachmentDrag={attachmentDrag} />

            <footer className="flex shrink-0 items-center gap-2 border-t border-separator px-4 py-2.5">
              <Tip label={t`Send`} shortcut={shortcut("send")} side="top">
                <button
                  type="submit"
                  className={`h-7 rounded-control bg-blue-600 px-3.5 ${touchTarget} font-medium text-white hover:bg-blue-700`}
                >
                  <Trans>Send</Trans>
                </button>
              </Tip>
              {replying && (
                <Tip label={t`Send and archive`} shortcut={shortcut("sendArchive")} side="top">
                  <button
                    type="button"
                    onClick={() => submit(true)}
                    className="h-7 rounded-control border border-edge px-3 font-medium hover:bg-fill-hover"
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
              {draft.body.kind === "rich" && (
                <DropdownMenu
                  align="start"
                  trigger={
                    <button type="button" aria-label={t`More options`} className={quiet}>
                      <Ellipsis className="size-4" />
                    </button>
                  }
                >
                  <MenuItem
                    icon={ImagePlus}
                    disabled={adding}
                    onClick={() => imageFileRef.current?.click()}
                  >{t`Image file`}</MenuItem>
                  <MenuItem
                    icon={Link}
                    disabled={adding}
                    onClick={() => setImageUrlOpen((open) => !open)}
                  >{t`Image URL`}</MenuItem>
                </DropdownMenu>
              )}
              <span
                id={errorId}
                role="alert"
                className="min-w-0 flex-1 truncate text-footnote text-a11y-danger"
                title={error ?? undefined}
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

          <ComposerAlerts
            draft={draft}
            closing={closing}
            setClosing={setClosing}
            asking={asking}
            setAsking={setAsking}
            submit={submit}
            onAttach={() => fileRef.current?.click()}
            onDiscard={onDiscard}
            onClose={onClose}
          />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

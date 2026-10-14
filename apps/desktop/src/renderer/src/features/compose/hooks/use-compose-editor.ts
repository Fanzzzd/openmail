import { uploadAttachments } from "../../../state/web-upload";
import { isDesktop } from "../../../lib/platform";
import { RASTER_IMAGE, type NativePicker } from "../../../../../shared/native-compose";
import { useLingui } from "@lingui/react/macro";
import {
  attachmentBytes,
  attachmentProblem,
  attachmentSizesProblem,
  COMPOSE_ATTACHMENT_LIMIT,
  customTemplateVariables,
  fillTemplate,
  inlineImageHtml,
  type AttachmentProblem,
  type Message,
  type Prefs,
  type SendAs,
  providerCapabilities,
} from "@openmail/core/schema";
import { Effect } from "effect";
import { useRef, useState, type ClipboardEvent, type Dispatch, type SetStateAction } from "react";
import type { Account, OutgoingAttachment, Template } from "../../../../../shared/api";
import type { ComposeMessages } from "./use-compose-messages";
import {
  editorBody,
  insertEditorText,
  restoreEditorSelection,
  type ComposeElement,
} from "../compose-editor-dom";
import { inheritsOriginals, withOriginalAttachments } from "../compose-originals";
import { formatAddress, parseAddresses, type Draft } from "../draft";
import { EDIT_MESSAGE_TEXT } from "../../../i18n/message-text";
import { useRunMail, withMail } from "../../../state/mail";
import { localTimeZone } from "../../../lib/time-zone";
const encodedBytes = (files: readonly { content: string }[]) =>
  files.reduce((sum, file) => sum + attachmentBytes(file.content), 0);

export function useComposeEditor({
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
  messages,
}: {
  messages: ComposeMessages;
  initial: Draft;
  prefs: Prefs;
  setDraft: Dispatch<SetStateAction<Draft>>;
  adding: boolean;
  draft: Draft;
  account: Account | undefined;
  showAttachmentProblem: (problem: AttachmentProblem) => void;
  setError: Dispatch<SetStateAction<string | null>>;
  setAdding: Dispatch<SetStateAction<boolean>>;
  original: Message | undefined;
  set: (patch: Partial<Draft>) => void;
  run: ReturnType<typeof useRunMail>;
  aliases: readonly SendAs[];
  currentAddress: string;
  setShowBcc: Dispatch<SetStateAction<boolean>>;
}) {
  const { t, i18n } = useLingui();
  const [imageUrl, setImageUrl] = useState("");
  const [imageUrlOpen, setImageUrlOpen] = useState(false);
  const imageFileRef = useRef<HTMLInputElement>(null);

  const attachmentDrag = useRef<number | null>(null);
  const [picker, setPicker] = useState(false);
  const [templateForm, setTemplateForm] = useState<Template | null>(null);
  const [templateValues, setTemplateValues] = useState<Record<string, string>>({});

  const fileRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<ComposeElement>(null);
  const selectionRef = useRef<Range>(null);
  const toRef = useRef<HTMLInputElement>(null);

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

  const appendAttachments = (files: readonly OutgoingAttachment[], inline: boolean) => {
    const element = bodyRef.current;
    // A paste may finish after the user switches to plain text.
    const insertInline = inline && element instanceof HTMLDivElement && element.isContentEditable;
    const added = files.map((file) =>
      insertInline && RASTER_IMAGE.test(file.mimeType)
        ? { ...file, contentId: file.contentId ?? `image-${crypto.randomUUID()}@openmail` }
        : file,
    );
    if (insertInline) {
      for (const file of added) {
        if (!file.contentId) continue;
        restoreEditorSelection(element, selectionRef.current);
        document.execCommand("insertHTML", false, inlineImageHtml(file, prefs.inlineImageSize));
        const selection = window.getSelection();
        if (selection?.rangeCount) selectionRef.current = selection.getRangeAt(0).cloneRange();
      }
    }
    setDraft((current) => ({
      ...current,
      attachments: [...current.attachments, ...added],
      body: element && inline ? editorBody(element, current.body) : current.body,
    }));
  };

  const addFiles = async (files: FileList | null, inline = false) => {
    if (!files?.length || adding) return;
    const sizes = [
      ...draft.attachments.map((file) => ({ ...file, size: attachmentBytes(file.content) })),
      ...[...files].map((file) => ({
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
      })),
    ];
    const problem = account ? attachmentSizesProblem(account.provider, sizes) : undefined;
    if (problem) {
      showAttachmentProblem(problem);
      return;
    }
    if (sizes.reduce((sum, file) => sum + file.size, 0) > COMPOSE_ATTACHMENT_LIMIT) {
      setError(messages.attachmentsExceedThe30MBComposeLimit);
      return;
    }
    setAdding(true);
    if (!isDesktop()) {
      const uploaded = await uploadAttachments(files, account?.id, draft.attachments);
      setAdding(false);
      if (uploaded.ok) {
        appendAttachments(uploaded.files, inline);
        setError(null);
      } else if (uploaded.error === "gmailBlocked")
        showAttachmentProblem({ kind: "gmailBlocked", filename: uploaded.filename ?? "" });
      else if (uploaded.error === "tooLarge")
        setError(messages.attachmentsExceedThe30MBComposeLimit);
      else setError(messages.couldntReadTheAttachmentTryAddingIt);
      return;
    }
    try {
      const added: OutgoingAttachment[] = [];
      for (const file of files)
        added.push({
          filename: file.name,
          mimeType: file.type || "application/octet-stream",
          content: await toBase64(file),
        });
      appendAttachments(added, inline);
      setError(null);
    } catch {
      setError(messages.couldntReadTheAttachmentTryAddingIt);
    } finally {
      setAdding(false);
    }
  };

  const pickNativeImages = (kind: NativePicker) => {
    if (adding) return;
    setAdding(true);
    run(
      withMail((call) =>
        call("PickNativeImages", {
          kind,
          labels: {
            title: kind === "photos" ? t`Photos` : t`Import from iPhone or iPad`,
            instruction: t`Click in this window, then choose a device to take a photo, scan a document or add a sketch.`,
            cancel: t`Cancel`,
          },
        }),
      ).pipe(
        Effect.matchCause({
          onSuccess: ({ files, status }) => {
            const all = [...draft.attachments, ...files];
            const problem = account ? attachmentProblem(account.provider, all) : undefined;
            if (problem) showAttachmentProblem(problem);
            else if (encodedBytes(all) > COMPOSE_ATTACHMENT_LIMIT)
              setError(messages.attachmentsExceedThe30MBComposeLimit);
            else {
              if (files.length) appendAttachments(files, false);
              setError(
                status === "tooLarge"
                  ? t`Images that exceed the 30 MB attachment limit were skipped.`
                  : null,
              );
            }
            setAdding(false);
          },
          onFailure: () => {
            setAdding(false);
            setError(t`Couldn't open the system picker.`);
          },
        }),
      ),
    );
  };

  const toggleOriginalAttachments = () => {
    if (!original || adding) return;
    if (draft.includeOriginalAttachments || inheritsOriginals(draft, account?.provider)) {
      set({
        includeOriginalAttachments: false,
        attachments: draft.attachments.filter((file) => file.sourceMessageId !== original.id),
      });
      return;
    }
    if (
      account &&
      providerCapabilities(account.provider).serverForward &&
      draft.mode === "forward"
    ) {
      setDraft((current) => {
        const { includeOriginalAttachments: _choice, ...rest } = current;
        return rest;
      });
      return;
    }
    setAdding(true);
    run(
      withMail((call) => call("ComposeAttachments", { id: original.id })).pipe(
        Effect.matchCause({
          onSuccess: (files) => {
            setDraft((current) => withOriginalAttachments(current, files));
            setAdding(false);
            setError(null);
          },
          onFailure: () => {
            setAdding(false);
            setError(messages.couldntLoadTheOriginalAttachmentsTryAgain);
          },
        }),
      ),
    );
  };

  const canInsertImage = () => {
    if (bodyRef.current instanceof HTMLDivElement && !bodyRef.current.isContentEditable) {
      const editBody = t(EDIT_MESSAGE_TEXT);
      setError(messages.chooseBeforeInsertingAnImage(editBody));
      return false;
    }
    return draft.body.kind === "rich";
  };
  const loadImageUrl = () => {
    if (adding || !canInsertImage()) return;
    setAdding(true);
    run(
      withMail((call) => call("ImageFromUrl", { url: imageUrl })).pipe(
        Effect.matchCause({
          onSuccess: (file) => {
            const problem = account
              ? attachmentProblem(account.provider, [...draft.attachments, file])
              : undefined;
            if (problem) showAttachmentProblem(problem);
            else if (encodedBytes([...draft.attachments, file]) > COMPOSE_ATTACHMENT_LIMIT)
              setError(messages.attachmentsExceedThe30MBComposeLimit);
            else {
              appendAttachments([file], true);
              setImageUrlOpen(false);
              setImageUrl("");
              setError(null);
            }
            setAdding(false);
          },
          onFailure: () => {
            setAdding(false);
            setError(messages.couldntInsertTheImageUseAPublic);
          },
        }),
      ),
    );
  };
  const addImageFiles = async (files: FileList | null) => {
    if (!files?.length || adding || !canInsertImage()) return;
    const sizes = [
      ...draft.attachments.map((a) => ({ ...a, size: attachmentBytes(a.content) })),
      ...[...files].map((f) => ({ filename: f.name, mimeType: f.type, size: f.size })),
    ];
    const problem = account ? attachmentSizesProblem(account.provider, sizes) : undefined;
    if (problem) {
      showAttachmentProblem(problem);
      return;
    }
    if (sizes.reduce((sum, file) => sum + file.size, 0) > COMPOSE_ATTACHMENT_LIMIT) {
      setError(messages.attachmentsExceedThe30MBComposeLimit);
      return;
    }
    if ([...files].some((file) => file.size > 8 * 1024 * 1024)) {
      setError(messages.useAnImageUpTo8MB);
      return;
    }
    setAdding(true);
    try {
      const input = await Promise.all(
        [...files].map(async (file) => ({
          filename: file.name,
          mimeType: file.type,
          content: await toBase64(file),
        })),
      );
      run(
        Effect.all(input.map((file) => withMail((call) => call("ImageFromFile", { file })))).pipe(
          Effect.matchCause({
            onSuccess: (images) => {
              appendAttachments(images, true);
              setAdding(false);
              setError(null);
            },
            onFailure: () => {
              setAdding(false);
              setError(messages.usePNGJPEGGIFOrWebPImages);
            },
          }),
        ),
      );
    } catch {
      setAdding(false);
      setError(messages.couldntReadTheImage);
    }
  };

  const insertTemplate = (template: Template, values?: Readonly<Record<string, string>>) => {
    const variables = customTemplateVariables(template.subject, template.body);
    if (variables.length && values === undefined) {
      setTemplateValues(Object.fromEntries(variables.map((name) => [name, ""])));
      setTemplateForm(template);
      setPicker(false);
      return;
    }
    if (bodyRef.current instanceof HTMLDivElement && !bodyRef.current.isContentEditable) {
      const editBody = t(EDIT_MESSAGE_TEXT);
      setError(messages.chooseBeforeInsertingATemplate(editBody));
      return;
    }
    const to = merge(draft.to, template.to);
    const cc = merge(draft.cc, template.cc);
    const bcc = merge(draft.bcc, template.bcc ?? []);
    const first = parseAddresses(to).addresses[0];
    const context = {
      sender: {
        name:
          draft.from?.name ||
          aliases.find(
            (s) => s.accountId === draft.accountId && s.address.toLowerCase() === currentAddress,
          )?.name ||
          account?.description ||
          "",
        address: currentAddress,
      },
      now: Date.now(),
      timeZone: localTimeZone(),
      locale: i18n.locale,
      subject: draft.subject,
      to: parseAddresses(to).addresses,
      cc: parseAddresses(cc).addresses,
      bcc: parseAddresses(bcc).addresses,
    };
    const text = fillTemplate(template.body, first, values, context);
    if (bodyRef.current) insertEditorText(bodyRef.current, text, selectionRef.current);
    set({
      to,
      cc,
      bcc,
      subject: template.subject
        ? fillTemplate(template.subject, first, values, context)
        : draft.subject,
      body: bodyRef.current ? editorBody(bodyRef.current, draft.body) : draft.body,
    });
    if (cc || bcc) setShowBcc(true);
    setPicker(false);
    setTemplateForm(null);
    requestAnimationFrame(() => bodyRef.current?.focus());
  };

  const onPasteCapture = (event: ClipboardEvent<HTMLFormElement>) => {
    if (!(event.target instanceof Element) || !event.target.closest("[contenteditable],textarea"))
      return;
    const element = bodyRef.current;
    const selection = window.getSelection();
    if (
      element instanceof HTMLDivElement &&
      selection?.rangeCount &&
      element.contains(selection.getRangeAt(0).commonAncestorContainer)
    )
      selectionRef.current = selection.getRangeAt(0).cloneRange();
    const inline =
      draft.body.kind === "rich" && element instanceof HTMLDivElement && element.isContentEditable;
    if (event.clipboardData.files.length) {
      event.preventDefault();
      void addFiles(event.clipboardData.files, inline);
    } else if (!event.clipboardData.types.length && isDesktop()) {
      event.preventDefault();
      if (adding) return;
      setAdding(true);
      run(
        withMail((call) => call("ClipboardAttachments", undefined)).pipe(
          Effect.matchCause({
            onSuccess: (files) => {
              appendAttachments(files, inline);
              setAdding(false);
            },
            onFailure: () => {
              setAdding(false);
              setError(messages.couldntReadTheClipboardAttachment);
            },
          }),
        ),
      );
    }
  };
  return {
    onPasteCapture,
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
    appendAttachments,
    pickNativeImages,
    addFiles,
    toggleOriginalAttachments,
    loadImageUrl,
    addImageFiles,
    insertTemplate,
  };
}

/** Adds a template's preset addresses to what is typed, skipping ones already there. */
const merge = (typed: string, preset: readonly { name: string; address: string }[]) => {
  const have = new Set(parseAddresses(typed).addresses.map((a) => a.address.toLowerCase()));
  const extra = preset.filter((a) => !have.has(a.address.toLowerCase())).map(formatAddress);
  return [typed.trim().replace(/[,;，；]$/, ""), ...extra].filter(Boolean).join(", ");
};

async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  // Chunked: String.fromCharCode takes its arguments on the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

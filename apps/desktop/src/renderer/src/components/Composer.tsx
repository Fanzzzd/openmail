import { EDIT_MESSAGE_TEXT } from "../message-text";
import { ComposerAi } from "./ComposerAi";
import { DraftSyncRecovery, draftSyncNotice } from "./DraftSyncRecovery";
import { moveRecipient, type RecipientFieldName, type RecipientDrag } from "../recipient-actions";
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
  applyComposeSignature,
  orderedSignatures,
  splitAddresses,
  fillTemplate,
  customTemplateVariables,
  ownText,
  attachmentProblem,
  attachmentSizesProblem,
  attachmentBytes,
  type AttachmentProblem,
  reorderAttachments,
  inlineImageHtml,
  reconcileMentionRecipients,
  type Address,
} from "@openmail/core/schema";
import { Effect } from "effect";
import { AsyncResult } from "effect/reactivity";
import { FileText, Paperclip, Trash2, X } from "lucide-react";
import {
  type ReactElement,
  type RefObject,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { constVoid } from "effect/Function";

import type { Account, OutgoingAttachment, OutgoingMessage, Template } from "../../../shared/api";
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
import {
  inheritsOriginals,
  withOriginalAttachments,
  loadOriginalAttachments,
} from "../compose-originals";
import { causeText } from "../errors";
import { submitDraft, type SendWarning } from "../send";
import { formatBytes } from "../format";
import { openDraft, useRunMail, withMail } from "../state/mail";
import { Keys } from "../state/keys";
import { saveDraftAtom, saveTemplateAtom, setPrefsAtom } from "../state/mutations";
import {
  signaturesAtom,
  namedSignaturesAtom,
  draftStatusAtom,
  templatesAtom,
  sendAsAtom,
  prefsAtom,
  threadAtom,
} from "../state/queries";
import { RecipientField } from "./RecipientField";
import { DraftOrganization } from "./DraftOrganization";
import { ComposeEditor } from "./ComposeEditor";
import {
  editorBody,
  restoreEditorSelection,
  insertEditorText,
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
  const { t, i18n } = useLingui();
  const prefsResult = useAtomValue(prefsAtom);
  const prefs = AsyncResult.getOrElse(prefsResult, () => DEFAULT_PREFS);
  const shortcut = useShortcutText();
  const [draft, setDraft] = useState(() =>
    initial.mode === "new" &&
    initial.synced === undefined &&
    prefsResult._tag === "Success" &&
    initial.body.kind === "rich" &&
    !initial.body.originalHtml &&
    !initial.body.font
      ? { ...initial, body: { ...initial.body, font: prefs.composeFont } }
      : initial,
  );
  if (
    prefsResult._tag === "Success" &&
    initial.mode === "new" &&
    initial.synced === undefined &&
    draft.body.kind === "rich" &&
    !draft.body.originalHtml &&
    !draft.body.font
  )
    setDraft({ ...draft, body: { ...draft.body, font: prefsResult.value.composeFont } });
  const setPrefs = useAtomSet(setPrefsAtom);
  const freshMentions = useRef(new Map<string, Address>());
  const activeMentions = useRef(new Set<string>());
  const manualSender = useRef(false);
  const [senderUndo, setSenderUndo] = useState<{ accountId: string; address: string } | null>(null);
  const [imageUrl, setImageUrl] = useState("");
  const [imageUrlOpen, setImageUrlOpen] = useState(false);
  const imageFileRef = useRef<HTMLInputElement>(null);
  const saved = useRef(initial);
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
  const [adding, setAdding] = useState(Boolean(initial.loadOriginalAttachments));
  const attachmentDrag = useRef<number | null>(null);
  const [picker, setPicker] = useState(false);
  const [templateForm, setTemplateForm] = useState<Template | null>(null);
  const [templateValues, setTemplateValues] = useState<Record<string, string>>({});
  const [saveState, save] = useAtom(saveDraftAtom(initial.id));
  const fileRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<ComposeElement>(null);
  const selectionRef = useRef<Range>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const account = accounts.find((a) => a.id === draft.accountId);
  const library = AsyncResult.getOrElse(useAtomValue(namedSignaturesAtom), () => []);
  const defaultSignatures = AsyncResult.getOrElse(useAtomValue(signaturesAtom), () => []);
  const remoteStatus = AsyncResult.getOrElse(useAtomValue(draftStatusAtom(draft.id)), () => null);
  const signatureAt = (accountId: string, from: string | undefined) => {
    const address = (from ?? accounts.find((a) => a.id === accountId)?.email)?.toLowerCase();
    return defaultSignatures.find(
      (s) => s.address === address && s.kind === (draft.mode === "new" ? "new" : "reply"),
    );
  };
  const currentSignature =
    draft.signatureId === undefined
      ? signatureAt(draft.accountId, draft.from?.address)
      : library.find((s) => s.id === draft.signatureId);
  const currentAddress = (draft.from?.address ?? account?.email ?? "").toLowerCase();
  const localSignatures = orderedSignatures(library, prefs.signatureOrder).filter(
    (s) => s.address === currentAddress,
  );
  const syncStatus = remoteStatus ?? (saveState._tag === "Success" ? saveState.value : null);
  const syncNotice = draftSyncNotice(syncStatus ?? initial);
  const [recoveryError, setRecoveryError] = useState("");
  const [recovering, setRecovering] = useState(false);
  const recover = (action: "retry" | "local") => {
    if (recovering) return;
    setRecovering(true);
    run(
      withMail((call) =>
        call("RecoverDraft", { id: draft.id, action, draft: toDraftInput(draft) }),
      ).pipe(
        Effect.matchCause({
          onSuccess: () => {
            saved.current = draft;
            setRecovering(false);
            setRecoveryError("");
          },
          onFailure: (cause) => {
            setRecovering(false);
            setRecoveryError(causeText(i18n, cause));
          },
        }),
      ),
    );
  };
  const moveChip = (source: RecipientFieldName, target: RecipientFieldName, index: number) => {
    setDraft((current) => ({ ...current, ...moveRecipient(current, source, target, index) }));
    if (target !== "to") setShowBcc(true);
  };
  const dropChip = (target: RecipientFieldName, chip: RecipientDrag) => {
    const tokens = splitAddresses(draft[chip.source])
      .map((s) => s.trim())
      .filter(Boolean);
    if (tokens[chip.index] === chip.text) moveChip(chip.source, target, chip.index);
  };
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
  const empty = isEmpty(
    draft,
    currentSignature?.text ??
      (draft.signatureId === undefined
        ? signatureFor(draft.accountId, draft.mode, draft.from?.address)
        : undefined),
    prefs,
  );
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
  useEffect(() => {
    const due =
      !recovering && !adding && !closing && !checkingClose && draft !== saved.current && !empty;
    const timer = due
      ? setTimeout(() => {
          saved.current = draft;
          save(toDraftInput(draft));
        }, AUTOSAVE_MS)
      : undefined;
    return () => clearTimeout(timer);
  }, [draft, save, closing, checkingClose, empty, adding, recovering]);

  const originalsLoaded = useEffectEvent((files: readonly OutgoingAttachment[]) => {
    setDraft((current) => withOriginalAttachments(current, files));
    setAdding(false);
  });
  const originalsFailed = useEffectEvent((reason: string) => {
    setDraft((current) => ({
      ...current,
      loadOriginalAttachments: false,
      includeOriginalAttachments: false,
    }));
    setAdding(false);
    setError(t`Couldn't load the original attachments: ${reason}`);
  });
  useEffect(() => {
    const id = initial.inReplyTo;
    if (!initial.loadOriginalAttachments || !id) return constVoid;
    let active = true;
    run(
      loadOriginalAttachments(
        withMail((call) => call("ComposeAttachments", { id })),
        (files) => {
          if (active) originalsLoaded(files);
        },
        (cause) => {
          if (active) originalsFailed(causeText(i18n, cause));
        },
      ),
    );
    return () => {
      active = false;
    };
  }, [initial, run, i18n]);

  const showAttachmentProblem = (problem: AttachmentProblem) => {
    switch (problem.kind) {
      case "gmailSize":
        setError(t`Gmail attachments exceed 25 MB in total. Remove attachments before sending.`);
        break;
      case "gmailBlocked": {
        const filename = problem.filename;
        setError(t`Gmail blocks ${filename}. Remove this attachment before sending.`);
        break;
      }
      case "outlookSize":
        setError(
          t`This app supports Outlook attachments up to 3 MB in total. Large attachment uploads are not supported yet. Remove attachments before sending.`,
        );
        break;
    }
  };
  const submit = (archive: boolean, confirmed: readonly SendWarning[] = []) => {
    if (adding) {
      setError(t`Wait for attachments to finish loading.`);
      return;
    }
    const problem = account
      ? attachmentProblem(account.provider, toDraftInput(draft).message.attachments)
      : undefined;
    if (problem) {
      showAttachmentProblem(problem);
      return;
    }
    const result = submitDraft(
      draft,
      archive,
      confirmed,
      onSend,
      applyComposeSignature(draft.body, currentSignature, undefined, prefs),
    );
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

  const nativePopOut = useEffectEvent(() => onPopOut?.(draft));
  useEffect(() => {
    if (popOutRequested > 0) queueMicrotask(() => nativePopOut());
  }, [popOutRequested]);
  const nativeClose = useEffectEvent(close);
  useEffect(() => {
    if (closeRequested > 0) queueMicrotask(() => nativeClose());
  }, [closeRequested]);

  useEffect(() => {
    // Bubble phase: fields that handle a key themselves (suggestions) mark it handled first.
    // Escape belongs to the dialog: it closes the innermost popup, then the window.
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || asking || closing || checkingClose || templateForm) return;
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
    const attach = () => fileRef.current?.click();
    window.addEventListener("openmail-attach-files", attach);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("openmail-attach-files", attach);
    };
  });

  const appendAttachments = (files: readonly OutgoingAttachment[], inline: boolean) => {
    const element = bodyRef.current;
    // A paste may finish after the user switches to plain text.
    const insertInline = inline && element instanceof HTMLDivElement && element.isContentEditable;
    const added = files.map((file) =>
      insertInline && /^image\/(png|jpeg|gif|webp|avif|bmp)$/i.test(file.mimeType)
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
    if (sizes.reduce((sum, file) => sum + file.size, 0) > 30 * 1024 * 1024) {
      setError(t`Attachments exceed the 30 MB compose limit.`);
      return;
    }
    setAdding(true);
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
      setError(t`Couldn't read the attachment. Try adding it again.`);
    } finally {
      setAdding(false);
    }
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
    if (account?.provider === "outlook" && draft.mode === "forward") {
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
            setError(t`Couldn't load the original attachments. Try again.`);
          },
        }),
      ),
    );
  };

  const changeSender = (key: string) => {
    const sender = senders.find((s) => `${s.accountId}/${s.address}` === key);
    if (!sender) return;
    set({
      accountId: sender.accountId,
      organization: sender.accountId === draft.accountId ? draft.organization : undefined,
      from: { name: sender.name, address: sender.address },
      signatureId: undefined,
      body: applyComposeSignature(
        draft.body,
        currentSignature,
        signatureAt(sender.accountId, sender.address),
        prefs,
      ),
    });
  };
  const chooseSignature = (id: string) => {
    const signature =
      id === "default"
        ? signatureAt(draft.accountId, draft.from?.address)
        : localSignatures.find((s) => s.id === id);
    set({
      signatureId: id === "default" ? undefined : id === "none" ? null : id,
      body: applyComposeSignature(draft.body, currentSignature, signature, prefs),
    });
  };

  const applyAutomaticSender = useEffectEvent((sender: { accountId: string; address: string }) => {
    if (
      initial.synced !== undefined ||
      manualSender.current ||
      prefs.defaultFrom ||
      draft.mode !== "new"
    )
      return;
    setSenderUndo({
      accountId: draft.accountId,
      address: draft.from?.address ?? account?.email ?? "",
    });
    changeSender(`${sender.accountId}/${sender.address}`);
  });
  const currentFrom = draft.from?.address ?? account?.email ?? "";
  useEffect(() => {
    if (
      initial.synced !== undefined ||
      draft.mode !== "new" ||
      prefs.defaultFrom ||
      manualSender.current ||
      !currentFrom
    )
      return constVoid;
    let active = true;
    const timer = setTimeout(
      () =>
        run(
          withMail((call) =>
            call("SuggestSender", {
              current: { accountId: draft.accountId, address: currentFrom },
              recipients: parseAddresses([draft.to, draft.cc, draft.bcc].join(", ")).addresses.map(
                (a) => a.address,
              ),
              accountIds: accounts.filter((a) => a.enabled !== false).map((a) => a.id),
            }),
          ).pipe(
            Effect.matchCause({
              onSuccess: (sender) => {
                if (active && sender) applyAutomaticSender(sender);
              },
              onFailure: constVoid,
            }),
          ),
        ),
      300,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [
    initial.synced,
    currentFrom,
    draft.mode,
    draft.accountId,
    draft.to,
    draft.cc,
    draft.bcc,
    prefs.defaultFrom,
    accounts,
    run,
  ]);

  const addMention = (person: Address) => {
    setDraft((current) => {
      const result = reconcileMentionRecipients(
        parseAddresses(current.to).addresses,
        [...parseAddresses(current.cc).addresses, ...parseAddresses(current.bcc).addresses],
        [...freshMentions.current.values()]
          .filter((a) => activeMentions.current.has(a.address.toLowerCase()))
          .concat(person),
        new Set(freshMentions.current.keys()),
      );
      for (const recipient of result.to)
        if (result.fresh.has(recipient.address.toLowerCase()))
          freshMentions.current.set(recipient.address.toLowerCase(), recipient);
      return {
        ...current,
        to: [...result.to.map(formatAddress), ...parseAddresses(current.to).invalid].join(", "),
      };
    });
  };
  const removeMentions = (active: readonly string[]) => {
    const have = new Set(active.map((address) => address.toLowerCase()));
    activeMentions.current = have;
    if (!freshMentions.current.size) return;
    setDraft((current) => {
      const result = reconcileMentionRecipients(
        parseAddresses(current.to).addresses,
        [...parseAddresses(current.cc).addresses, ...parseAddresses(current.bcc).addresses],
        [...freshMentions.current.values()].filter((person) =>
          have.has(person.address.toLowerCase()),
        ),
        new Set(freshMentions.current.keys()),
      );
      const to = [...result.to.map(formatAddress), ...parseAddresses(current.to).invalid].join(
        ", ",
      );
      return to === current.to ? current : { ...current, to };
    });
  };
  const canInsertImage = () => {
    if (bodyRef.current instanceof HTMLDivElement && !bodyRef.current.isContentEditable) {
      const editBody = t(EDIT_MESSAGE_TEXT);
      setError(
        t({
          message: `Choose ${editBody} before inserting an image.`,
          context: "message text instruction",
          comment:
            "editBody is the exact translated Edit body button label. Preserve it unchanged.",
        }),
      );
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
            else if (
              [...draft.attachments, file].reduce((sum, a) => sum + attachmentBytes(a.content), 0) >
              30 * 1024 * 1024
            )
              setError(t`Attachments exceed the 30 MB compose limit.`);
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
            setError(
              t`Couldn't insert the image. Use a public PNG, JPEG, GIF or WebP image up to 8 MB.`,
            );
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
    if (sizes.reduce((sum, file) => sum + file.size, 0) > 30 * 1024 * 1024) {
      setError(t`Attachments exceed the 30 MB compose limit.`);
      return;
    }
    if ([...files].some((file) => file.size > 8 * 1024 * 1024)) {
      setError(t`Use an image up to 8 MB.`);
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
              setError(t`Use PNG, JPEG, GIF or WebP images up to 8 MB.`);
            },
          }),
        ),
      );
    } catch {
      setAdding(false);
      setError(t`Couldn't read the image.`);
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
      setError(
        t({
          message: `Choose ${editBody} before inserting a template.`,
          context: "message text instruction",
          comment:
            "editBody is the exact translated Edit body button label. Preserve it unchanged.",
        }),
      );
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
      now: new Date(),
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

  const status =
    recovering || saveState.waiting
      ? t`Saving…`
      : saveState._tag === "Failure"
        ? t`Couldn't save`
        : syncNotice === "local"
          ? t`Kept on this Mac`
          : syncNotice === "failed"
            ? t`Couldn't sync`
            : syncNotice === "retrying"
              ? t`Saved on this Mac. Retrying sync automatically.`
              : (syncStatus?.synced ?? initial.synced)
                ? t`Saved`
                : saveState._tag === "Success" || syncStatus
                  ? t`Saved on this Mac. Syncs when online.`
                  : "";

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
            onPasteCapture={(event) => {
              if (
                !(event.target instanceof Element) ||
                !event.target.closest("[contenteditable],textarea")
              )
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
                draft.body.kind === "rich" &&
                element instanceof HTMLDivElement &&
                element.isContentEditable;
              if (event.clipboardData.files.length) {
                event.preventDefault();
                void addFiles(event.clipboardData.files, inline);
              } else if (!event.clipboardData.types.length) {
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
                        setError(t`Couldn't read the clipboard attachment.`);
                      },
                    }),
                  ),
                );
              }
            }}
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
                onValueChange={(key) => {
                  manualSender.current = true;
                  setSenderUndo(null);
                  changeSender(key);
                }}
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
                    onClick={() => {
                      manualSender.current = true;
                      changeSender(`${senderUndo.accountId}/${senderUndo.address}`);
                      setSenderUndo(null);
                    }}
                  >{t`Revert`}</button>
                </output>
              )}
            </div>
            <div className={row}>
              <span className={label}>
                <Trans>To</Trans>
              </span>
              <RecipientField
                onDragChip={() => setShowBcc(true)}
                fieldName="to"
                onMove={(index, target) => moveChip("to", target, index)}
                onDropRecipient={(chip) => dropChip("to", chip)}
                label={t`To`}
                inputRef={toRef}
                value={draft.to}
                onChange={(to) => {
                  freshMentions.current.clear();
                  set({ to });
                }}
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
                    fieldName="cc"
                    onMove={(index, target) => moveChip("cc", target, index)}
                    onDropRecipient={(chip) => dropChip("cc", chip)}
                    label={t`Cc`}
                    inputRef={ccRef}
                    value={draft.cc}
                    onChange={(cc) => {
                      for (const a of parseAddresses(cc).addresses)
                        freshMentions.current.delete(a.address.toLowerCase());
                      set({ cc });
                    }}
                    showFullAddresses={prefs.showFullRecipientAddresses}
                    from={draft.from?.address ?? account?.email}
                  />
                </div>
                <div className={row}>
                  <span className={label}>
                    <Trans>Bcc</Trans>
                  </span>
                  <RecipientField
                    fieldName="bcc"
                    onMove={(index, target) => moveChip("bcc", target, index)}
                    onDropRecipient={(chip) => dropChip("bcc", chip)}
                    label={t`Bcc`}
                    value={draft.bcc}
                    onChange={(bcc) => {
                      for (const a of parseAddresses(bcc).addresses)
                        freshMentions.current.delete(a.address.toLowerCase());
                      set({ bcc });
                    }}
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
              {account && (
                <DraftOrganization
                  provider={account.provider}
                  accountId={account.id}
                  value={draft.organization ?? { labels: [], starred: false }}
                  onChange={(organization) => {
                    const next = { ...draft, organization };
                    setDraft(next);
                    saved.current = next;
                    save(toDraftInput(next));
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
              <span className="min-w-0 flex-1 truncate text-[12px] text-a11y-danger">{error}</span>
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

async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  // Chunked: String.fromCharCode takes its arguments on the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

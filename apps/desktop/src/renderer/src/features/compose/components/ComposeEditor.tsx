import { isDesktop } from "../../../lib/platform";
import { GrammarResults, useComposeGrammar } from "./ComposeGrammar";
import { ComposeToolbar } from "./ComposeToolbar";
import { MenuCheckboxItem, MenuItem, MenuRadioGroup, MenuSeparator } from "../../../ui/Menu";
import { EDIT_MESSAGE_TEXT } from "../../../i18n/message-text";
import { composePreviewHtml } from "../compose-preview";
import { EmailFrame } from "../../reader/frame/EmailFrame";
import { jumpDocumentSelection, jumpTextareaSelection } from "../../../lib/jump-selection";
import { activeComposeMentions, resizeComposeImage } from "../compose-contacts-dom";
/* oxlint-disable jsx-a11y/prefer-tag-over-role -- A contenteditable needs textbox semantics; textarea cannot retain rich marks. */
import { useAtomValue } from "@effect/atom-react";
import {
  matchesShortcut,
  type ShortcutAction,
  type ShortcutSet,
} from "../../../../../shared/shortcuts";
import { shortcutHint } from "../../../i18n/use-shortcut-text";
import { Effect } from "effect";
import { useRunMail, withMail, type MailEnv } from "../../../state/mail";
import { AsyncResult, Atom, Reactivity } from "effect/reactivity";
import { suggestionsAtom } from "../../../state/queries";
import { useLingui } from "@lingui/react/macro";
import {
  composeReplacement,
  composePaste,
  composeConversion,
  composeMatches,
  composeEditorText,
  composeHtmlHasUnsupported,
  editedComposeBody,
  composeLink,
  richComposeBody,
  escapeComposeText,
  type ComposeBody,
  type Address,
  type InlineImageSize,
  type Prefs,
  type PrefsPatch,
  mentionQuery,
  mentionHtml,
  emojiAtCaret,
  EMPTY_QUOTE_HISTORY,
} from "@openmail/core/schema";
import {
  useLayoutEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type KeyboardEvent,
} from "react";
import { constVoid } from "effect/Function";

import {
  restoreEditorSelection,
  composeEditorHtml,
  editorBody,
  editorCaretOffset,
  editorStartsParagraph,
  selectEditorMatch,
  replaceEditorMatches,
  type ComposeElement,
} from "../compose-editor-dom";
import type { OutgoingAttachment } from "../../../../../shared/api";
import { makeInlinePreviewCache } from "../compose-previews";
import { Select } from "../../../ui/Select";
import {
  FORMAT_ACTIONS,
  formatEditor,
  styleEditor,
  stepEditorFontSize,
  replaceMarkdownEditor,
  restoreFormatSelection,
  type FormatAction,
} from "../compose-format-dom";
import { Keys } from "../../../state/keys";
import { Alert, AlertCancel, alertButton, alertPrimary } from "../../../ui/Dialog";

const noSuggestions = Atom.make(AsyncResult.success<readonly Address[]>([]));
interface Props {
  shortcutSet: ShortcutSet;
  prefs: Prefs;
  from: string | undefined;
  onImageSize: (size: InlineImageSize) => void;
  onMention: (person: Address) => void;
  onMentionsChange: (addresses: readonly string[]) => void;
  body: ComposeBody;
  attachments: readonly OutgoingAttachment[];
  onChange: (body: ComposeBody) => void;
  bodyRef: RefObject<ComposeElement | null>;
  selectionRef: RefObject<Range | null>;
}

const clipboardText = (): Effect.Effect<string, unknown, MailEnv> =>
  isDesktop()
    ? withMail((call) => call("ClipboardText", undefined))
    : // The browser reads this device's clipboard, never the Mac's.
      Effect.tryPromise(() => navigator.clipboard.readText());

export function ComposeEditor({
  body,
  attachments,
  onChange,
  bodyRef,
  selectionRef,
  shortcutSet,
  prefs,
  from,
  onImageSize,
  onMention,
  onMentionsChange,
}: Props) {
  const { t } = useLingui();
  const shortcut = (action: ShortcutAction) => shortcutHint(shortcutSet, action);
  const run = useRunMail();
  const richRef = useRef<HTMLDivElement>(null);
  const [formatBar, setFormatBar] = useState(prefs.composeFormatBar);
  const [smartLists, setSmartLists] = useState(prefs.composeSmartLists);
  const [markdownReplacement, setMarkdownReplacement] = useState(prefs.composeMarkdownReplacement);
  const copiedStyle = useRef("");
  const smartUndo = useRef<{ body: ComposeBody; caret: number } | null>(null);
  const saveFormatPrefs = (patch: PrefsPatch) =>
    run(withMail((call) => call("SetPrefs", { patch })).pipe(Reactivity.mutation([Keys.prefs])));
  const toggleFormatBar = () => {
    setFormatBar(!formatBar);
    saveFormatPrefs({ composeFormatBar: !formatBar });
  };
  const format = (action: FormatAction) => {
    if (!richRef.current || locked) return;
    copiedStyle.current = formatEditor(
      richRef.current,
      selectionRef.current,
      action,
      copiedStyle.current,
    );
    if (action !== "copyStyle") changed();
  };
  const style = (property: string, value: string) => {
    if (!richRef.current || locked) return;
    styleEditor(richRef.current, selectionRef.current, property, value);
    changed();
  };
  const [pasteError, setPasteError] = useState(false);
  const [mention, setMention] = useState<{ query: string; range: Range } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const mentioned = useRef(new Map<string, Address>());
  const mentionSuggestions = AsyncResult.getOrElse(
    useAtomValue(mention ? suggestionsAtom(mention.query, from) : noSuggestions),
    () => [],
  );
  const [imageCid, setImageCid] = useState<string | null>(null);
  const [emojiUndo, setEmojiUndo] = useState<ComposeBody | null>(null);
  const replacingEmoji = useRef(false);
  const lastEmitted = useRef<string | null>(null);
  const [previewCache] = useState(makeInlinePreviewCache);
  const [linkOpen, setLinkOpen] = useState(false);
  const [finding, setFinding] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [findIndex, setFindIndex] = useState(0);
  const matches = composeMatches(composeEditorText(body), findQuery);
  const [href, setHref] = useState("");
  const [linkError, setLinkError] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [editPrompt, setEditPrompt] = useState(false);
  const [modePrompt, setModePrompt] = useState<ComposeBody | null>(null);
  const [modeUndo, setModeUndo] = useState<ComposeBody | null>(null);
  const remoteUnsupported = useMemo(
    () =>
      body.kind === "rich" &&
      body.originalHtml !== undefined &&
      composeHtmlHasUnsupported(body.originalHtml),
    [body],
  );
  const locked = remoteUnsupported && !unlocked;
  const grammar = useComposeGrammar({ body, bodyRef, onChange, locked });
  const changeMode = (next: ComposeBody) => {
    setModeUndo(body);
    setMention(null);
    if (next.kind !== "rich") onMentionsChange([]);
    selectionRef.current = null;
    setLinkOpen(false);
    setModePrompt(null);
    onChange(next);
  };

  const syncMentions = useEffectEvent(() =>
    onMentionsChange(activeComposeMentions(richRef.current, mentioned.current)),
  );
  useLayoutEffect(() => () => previewCache.dispose(), [previewCache]);
  useLayoutEffect(() => {
    previewCache.sync(attachments);
    const element = richRef.current;
    if (body.kind !== "rich" || !element) {
      lastEmitted.current = null;
      return constVoid;
    }
    // Leave the live DOM and caret alone for our own input/IME events.
    if (lastEmitted.current !== body.html) {
      element.innerHTML = richComposeBody(body.html).html;
      setEmojiUndo(null);
    }
    lastEmitted.current = body.html;
    for (const image of element.querySelectorAll("img")) {
      const cid =
        image.getAttribute("data-compose-cid") ?? image.getAttribute("src")?.replace(/^cid:/, "");
      // Removing an attachment must also stop displaying its now-revoked preview.
      if (cid) image.setAttribute("src", `cid:${cid}`);
      if (!cid) continue;
      const url = previewCache.get(cid);
      if (!url) continue;
      image.setAttribute("data-compose-cid", cid);
      image.setAttribute("src", url);
    }
    syncMentions();
    return constVoid;
  }, [body, attachments, previewCache, richRef]);

  const remember = () => {
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (range && richRef.current?.contains(range.commonAncestorContainer)) {
      selectionRef.current = range.cloneRange();
    }
  };
  const refreshMentions = () =>
    onMentionsChange(activeComposeMentions(richRef.current, mentioned.current));
  const updateMentionQuery = () => {
    const range = selectionRef.current;
    if (!range?.collapsed || range.startContainer.nodeType !== Node.TEXT_NODE) {
      setMention(null);
      return;
    }
    const text = (range.startContainer.textContent ?? "").slice(0, range.startOffset);
    const token = mentionQuery(text);
    if (!token || range.startContainer.parentElement?.closest("a,pre,code")) {
      setMention(null);
      return;
    }
    const selected = range.cloneRange();
    selected.setStart(range.startContainer, range.startOffset - token.length);
    setMention({ query: token.query, range: selected });
    setMentionIndex(0);
  };
  const pickMention = (person: Address) => {
    if (!mention || locked || !richRef.current?.contains(mention.range.commonAncestorContainer))
      return;
    const id = crypto.randomUUID();
    mentioned.current.set(id, person);
    selectionRef.current = mention.range;
    if (command("insertHTML", mentionHtml(person, id))) onMention(person);
    setMention(null);
  };
  const undoEmoji = () => {
    if (!emojiUndo) return;
    lastEmitted.current = null;
    onChange(emojiUndo);
    setEmojiUndo(null);
    selectionRef.current = null;
  };
  const changed = (typing = false) => {
    if (!richRef.current || locked) return;
    if (body.kind !== "rich") return;
    if (replacingEmoji.current) return;
    remember();
    setEmojiUndo(null);
    smartUndo.current = null;
    if (typing) {
      const range = selectionRef.current;
      if (
        prefs.emojiReplacement &&
        range?.collapsed &&
        range.startContainer.nodeType === Node.TEXT_NODE &&
        !range.startContainer.parentElement?.closest("a,pre,code")
      ) {
        const before = (range.startContainer.textContent ?? "").slice(0, range.startOffset);
        const emojiChange = emojiAtCaret(before);
        if (emojiChange) {
          const undo = editedComposeBody(body, composeEditorHtml(richRef.current));
          const selected = range.cloneRange();
          selected.setStart(range.startContainer, emojiChange.start);
          selected.setEnd(range.startContainer, emojiChange.end);
          restoreEditorSelection(richRef.current, selected);
          replacingEmoji.current = true;
          document.execCommand("insertText", false, emojiChange.replacement);
          replacingEmoji.current = false;
          setEmojiUndo(undo);
          const selection = window.getSelection();
          const caret = selection?.rangeCount ? selection.getRangeAt(0) : null;
          if (
            caret?.endContainer.nodeType === Node.TEXT_NODE &&
            /[\s\u00a0]/.test((caret.endContainer.textContent ?? "").charAt(caret.endOffset))
          ) {
            caret.setStart(caret.endContainer, caret.endOffset + 1);
            caret.collapse(true);
            selection?.removeAllRanges();
            selection?.addRange(caret);
          }
          remember();
        }
      }
    }
    if (typing) {
      const range = selectionRef.current;
      if (
        range?.collapsed &&
        range.startContainer.nodeType === Node.TEXT_NODE &&
        !range.startContainer.parentElement?.closest("a,pre,code")
      ) {
        const before = (range.startContainer.textContent ?? "").slice(0, range.startOffset);
        const substitution = composeReplacement(before, markdownReplacement, smartLists);
        const prefix = substitution && "block" in substitution;
        // List/quote prefixes must start a paragraph, never a later inline node.
        const startsParagraph = editorStartsParagraph(richRef.current, range);
        if (substitution && (!prefix || startsParagraph)) {
          const undo = editedComposeBody(body, composeEditorHtml(richRef.current));
          smartUndo.current = { body: undo, caret: editorCaretOffset(richRef.current, range) };
          replacingEmoji.current = true;
          replaceMarkdownEditor(richRef.current, range, substitution);
          replacingEmoji.current = false;
          remember();
        }
      }
    }
    const next = editedComposeBody(body, composeEditorHtml(richRef.current));
    if (next !== body) setModeUndo(null);
    lastEmitted.current = next.html;
    remember();
    onChange(next);
    refreshMentions();
    updateMentionQuery();
  };
  const command = (name: string, value?: string) => {
    if (!richRef.current || locked) return false;
    restoreEditorSelection(richRef.current, selectionRef.current);
    document.execCommand("styleWithCSS", false, "false");
    const inserted = document.execCommand(name, false, value);
    changed();
    return inserted;
  };
  const openLink = () => {
    const node = selectionRef.current?.startContainer;
    const anchor = (node instanceof Element ? node : node?.parentElement)?.closest("a");
    setHref(anchor?.getAttribute("href") ?? "");
    if (anchor && richRef.current?.contains(anchor)) {
      const range = document.createRange();
      range.selectNodeContents(anchor);
      selectionRef.current = range;
    }
    setLinkError(false);
    setLinkOpen(true);
  };
  const addLink = () => {
    const safe = composeLink(href);
    if (!safe) {
      setLinkError(true);
      return;
    }
    if (!selectionRef.current || selectionRef.current.collapsed) {
      command("insertHTML", `<a href="${escapeComposeText(safe)}">${escapeComposeText(safe)}</a>`);
    } else command("createLink", safe);
    setLinkOpen(false);
  };
  const selectMatch = (index: number) => {
    const match = matches[index];
    if (match && bodyRef.current) selectEditorMatch(bodyRef.current, match.start, match.end);
    setFindIndex(index);
    remember();
  };
  const replaceMatches = (all: boolean) => {
    const element = bodyRef.current;
    if (!element || locked) return;
    const targets = all
      ? matches.toReversed()
      : matches.slice(
          findIndex % Math.max(1, matches.length),
          (findIndex % Math.max(1, matches.length)) + 1,
        );
    if (!replaceEditorMatches(element, targets, replacement)) return;
    if (element instanceof HTMLTextAreaElement) onChange(editorBody(element, body));
    else changed();
    setFindIndex(0);
  };
  const findKey = (event: KeyboardEvent<HTMLInputElement>) => {
    editorKey(event);
    if (event.defaultPrevented) return;
    if (event.key === "Enter") {
      event.preventDefault();
      if (matches.length)
        selectMatch((findIndex + (event.shiftKey ? matches.length - 1 : 1)) % matches.length);
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setFinding(false);
    }
  };
  const paste = (mode: "matchStyle" | "quotation") => {
    if (locked) return;
    remember();
    const element = bodyRef.current;
    const selection = selectionRef.current?.cloneRange() ?? null;
    const snapshot = element instanceof HTMLTextAreaElement ? element.value : element?.innerHTML;
    const caret =
      element instanceof HTMLTextAreaElement
        ? { start: element.selectionStart, end: element.selectionEnd }
        : null;
    setPasteError(false);
    run(
      clipboardText().pipe(
        Effect.matchCause({
          onFailure: () => setPasteError(true),
          onSuccess: (text) => {
            if (
              !element ||
              element !== bodyRef.current ||
              (element instanceof HTMLDivElement && !element.isContentEditable)
            )
              return;
            if (
              snapshot !==
              (element instanceof HTMLTextAreaElement ? element.value : element.innerHTML)
            )
              return;
            const content = composePaste(text, mode);
            if (element instanceof HTMLTextAreaElement) {
              element.focus();
              if (caret) element.setSelectionRange(caret.start, caret.end);
              document.execCommand("insertText", false, content.text);
              onChange(editorBody(element, body));
            } else {
              restoreEditorSelection(element, selection);
              document.execCommand("insertHTML", false, content.html);
              changed();
            }
          },
        }),
      ),
    );
  };
  const editorKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented) return;
    const inBody =
      event.target === bodyRef.current ||
      (event.target instanceof Node && richRef.current?.contains(event.target));
    const inFind = event.target instanceof Element && Boolean(event.target.closest("search"));
    if (!inBody && !inFind) return;
    if (inBody && !locked) {
      if (smartUndo.current && matchesShortcut(shortcutSet, "undo", event)) {
        event.preventDefault();
        event.stopPropagation();
        const undo = smartUndo.current;
        smartUndo.current = null;
        if (undo.body.kind === "rich" && richRef.current) {
          richRef.current.innerHTML = richComposeBody(undo.body.html).html;
          lastEmitted.current = undo.body.html;
          // Put the caret back where the replacement was rather than at the end.
          restoreFormatSelection(richRef.current, undo.caret, undo.caret);
          remember();
          onChange(undo.body);
        }
        return;
      }
      if (
        emojiUndo &&
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "z" &&
        !event.shiftKey
      ) {
        event.preventDefault();
        undoEmoji();
        return;
      }
      if (
        mention &&
        mentionSuggestions.length &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          setMentionIndex(
            (index) =>
              (index + (event.key === "ArrowDown" ? 1 : -1) + mentionSuggestions.length) %
              mentionSuggestions.length,
          );
          return;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          const person = mentionSuggestions[mentionIndex];
          if (person) pickMention(person);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setMention(null);
          return;
        }
      }
    }
    if (
      matchesShortcut(shortcutSet, "search", event) &&
      (event.metaKey || event.ctrlKey) &&
      !event.altKey
    ) {
      event.preventDefault();
      event.stopPropagation();
      setFinding(true);
      return;
    }
    if (matchesShortcut(shortcutSet, "jumpSelection", event) && inBody) {
      event.preventDefault();
      event.stopPropagation();
      const element = bodyRef.current;
      if (element instanceof HTMLTextAreaElement) {
        jumpTextareaSelection(element);
      } else jumpDocumentSelection(document);
      return;
    }
    if (matchesShortcut(shortcutSet, "findSelection", event) && inBody) {
      event.preventDefault();
      event.stopPropagation();
      const element = bodyRef.current;
      const text =
        element instanceof HTMLTextAreaElement
          ? element.value.slice(element.selectionStart, element.selectionEnd)
          : (window.getSelection()?.toString() ?? "");
      if (text) {
        setFindQuery(text);
        setFindIndex(0);
        setFinding(true);
      }
      return;
    }
    if (
      matchesShortcut(shortcutSet, "findNext", event) ||
      matchesShortcut(shortcutSet, "findPrevious", event)
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (!finding) setFinding(true);
      if (matches.length)
        selectMatch(
          (findIndex +
            (matchesShortcut(shortcutSet, "findPrevious", event) ? matches.length - 1 : 1)) %
            matches.length,
        );
      return;
    }
    if (!inBody || locked) return;
    if (
      matchesShortcut(shortcutSet, "pasteMatchStyle", event) ||
      matchesShortcut(shortcutSet, "pasteQuotation", event)
    ) {
      event.preventDefault();
      event.stopPropagation();
      paste(matchesShortcut(shortcutSet, "pasteQuotation", event) ? "quotation" : "matchStyle");
      return;
    }
    if (body.kind !== "rich") return;
    if (matchesShortcut(shortcutSet, "toggleFormatBar", event)) {
      event.preventDefault();
      event.stopPropagation();
      toggleFormatBar();
      return;
    }
    if (
      matchesShortcut(shortcutSet, "fontSizeIncrease", event) ||
      matchesShortcut(shortcutSet, "fontSizeDecrease", event)
    ) {
      event.preventDefault();
      event.stopPropagation();
      remember();
      if (richRef.current) {
        stepEditorFontSize(
          richRef.current,
          selectionRef.current,
          matchesShortcut(shortcutSet, "fontSizeIncrease", event) ? 1 : -1,
        );
        changed();
      }
      return;
    }
    for (const action of FORMAT_ACTIONS) {
      if (!matchesShortcut(shortcutSet, action, event)) continue;
      event.preventDefault();
      event.stopPropagation();
      remember();
      format(action);
      return;
    }
    for (const action of ["bold", "italic", "underline", "link", "strikethrough"] as const) {
      if (!matchesShortcut(shortcutSet, action, event)) continue;
      event.preventDefault();
      event.stopPropagation();
      remember();
      if (action === "link") openLink();
      else command(action === "strikethrough" ? "strikeThrough" : action);
      return;
    }
  };
  const button =
    "rounded p-1.5 text-a11y-muted hover:bg-fill-hover focus-visible:outline-a11y-focus";

  return (
    <div
      className={`flex flex-col ${locked ? "shrink-0" : "min-h-0 flex-1"} focus-within:ring-2 focus-within:ring-inset focus-within:ring-a11y-focus`}
    >
      <ComposeToolbar
        formatting={body.kind === "rich" && formatBar}
        disabled={locked}
        onFormat={format}
        onStyle={style}
        onCommand={command}
        onLink={openLink}
        shortcut={shortcut}
        leading={
          <>
            <Select
              aria-label={t`Writing mode`}
              value={body.kind}
              options={[
                { value: "rich", label: t`Rich text` },
                { value: "plain", label: t`Plain text` },
                ...(prefs.labs.markdown || body.kind === "markdown"
                  ? [{ value: "markdown" as const, label: t`Markdown` }]
                  : []),
              ]}
              onValueChange={(kind) => {
                const conversion = composeConversion(body, kind);
                if (conversion.losesFormatting) setModePrompt(conversion.body);
                else changeMode(conversion.body);
              }}
            />
            {modeUndo && (
              <button
                type="button"
                className={button}
                onClick={() => {
                  onChange(modeUndo);
                  setModeUndo(null);
                  selectionRef.current = null;
                }}
              >{t`Undo mode change`}</button>
            )}
            {emojiUndo && (
              <button
                type="button"
                className={button}
                onClick={undoEmoji}
              >{t`Undo emoji replacement`}</button>
            )}
          </>
        }
        more={
          <>
            <MenuItem disabled={locked} onClick={() => setFinding((value) => !value)}>
              {t`Find and replace`}
            </MenuItem>
            <MenuItem
              disabled={locked}
              shortcut={shortcut("pasteMatchStyle")}
              onClick={() => paste("matchStyle")}
            >{t`Paste and match style`}</MenuItem>
            <MenuItem
              disabled={locked}
              shortcut={shortcut("pasteQuotation")}
              onClick={() => paste("quotation")}
            >{t`Paste as quotation`}</MenuItem>
            {body.kind === "rich" && (
              <>
                <MenuSeparator />
                <MenuItem shortcut={shortcut("toggleFormatBar")} onClick={toggleFormatBar}>
                  {formatBar ? t`Hide format bar` : t`Show format bar`}
                </MenuItem>
                <MenuCheckboxItem
                  checked={smartLists}
                  onCheckedChange={(next) => {
                    setSmartLists(next);
                    saveFormatPrefs({ composeSmartLists: next });
                  }}
                >{t`Smart lists`}</MenuCheckboxItem>
                <MenuCheckboxItem
                  checked={markdownReplacement}
                  onCheckedChange={(next) => {
                    setMarkdownReplacement(next);
                    saveFormatPrefs({ composeMarkdownReplacement: next });
                  }}
                >{t`Markdown replacements`}</MenuCheckboxItem>
                <MenuSeparator />
                <MenuRadioGroup
                  label={t`Image size`}
                  value={prefs.inlineImageSize}
                  disabled={locked}
                  options={[
                    { value: "small", label: t`Small` },
                    { value: "medium", label: t`Medium` },
                    { value: "large", label: t`Large` },
                    { value: "original", label: t`Original` },
                  ]}
                  onValueChange={(size) => {
                    onImageSize(size);
                    resizeComposeImage(richRef.current, imageCid, size);
                    changed();
                  }}
                />
              </>
            )}
            {grammar.available && (
              <>
                <MenuSeparator />
                <MenuItem disabled={grammar.disabled} onClick={grammar.check}>
                  {grammar.checking ? t`Checking grammar…` : t`Check grammar on this Mac`}
                </MenuItem>
              </>
            )}
          </>
        }
      />
      {pasteError && <p role="alert">{t`Could not read clipboard`}</p>}
      {mention && mentionSuggestions.length > 0 && (
        <div
          className="shrink-0 border-b px-4 py-2 border-separator"
          aria-label={t`Mention suggestions`}
        >
          {mentionSuggestions.map((person, index) => (
            <button
              key={person.address}
              type="button"
              className={`${button} ${index === mentionIndex ? "bg-blue-500/10" : ""}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pickMention(person)}
            >
              {person.name || person.address}
            </button>
          ))}
        </div>
      )}
      {finding && (
        <search
          aria-label={t`Find and replace`}
          className="flex shrink-0 flex-wrap items-center gap-2 px-4 py-2"
        >
          <input
            autoFocus
            aria-label={t`Find in body`}
            placeholder={t`Find in body`}
            value={findQuery}
            onKeyDown={findKey}
            onChange={(event) => {
              setFindQuery(event.target.value);
              setFindIndex(0);
            }}
            className="min-w-0 flex-1 rounded border px-2 py-1 border-separator"
          />
          <input
            aria-label={t`Replace with`}
            placeholder={t`Replace with`}
            value={replacement}
            onKeyDown={findKey}
            onChange={(event) => setReplacement(event.target.value)}
            className="min-w-0 flex-1 rounded border px-2 py-1 border-separator"
          />
          <output aria-live="polite">
            {matches.length
              ? `${(findIndex % matches.length) + 1}/${matches.length}`
              : t`No matches`}
          </output>
          <button
            type="button"
            disabled={!matches.length}
            className={button}
            onClick={() => selectMatch((findIndex + matches.length - 1) % matches.length)}
          >{t`Previous match`}</button>
          <button
            type="button"
            disabled={!matches.length}
            className={button}
            onClick={() => selectMatch((findIndex + 1) % matches.length)}
          >{t`Next match`}</button>
          <button
            type="button"
            disabled={locked || !matches.length}
            className={button}
            onClick={() => replaceMatches(false)}
          >{t`Replace`}</button>
          <button
            type="button"
            disabled={locked || !matches.length}
            className={button}
            onClick={() => replaceMatches(true)}
          >{t`Replace all`}</button>
          <button
            type="button"
            className={button}
            onClick={() => setFinding(false)}
          >{t`Close find`}</button>
        </search>
      )}
      <GrammarResults grammar={grammar} locked={locked} />
      {!locked && body.kind === "rich" && body.hiddenTextRemoved && (
        <p
          role="status"
          className="shrink-0 border-b border-edge px-4 py-2 text-callout text-a11y-muted"
        >
          {t({
            message: "Hidden text was removed.",
            context: "compose sanitization notice",
            comment:
              "Invisible message text was removed before opening this draft in the editable rich composer. Do not include the removed text.",
          })}
        </p>
      )}
      {remoteUnsupported && (
        <div
          role="status"
          className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100"
        >
          <p className="font-medium">
            {t({
              message: "Original formatting kept",
              context: "compose formatting status",
              comment:
                "Status for a draft shown in a read-only preview that preserves its original layout.",
            })}
          </p>
          <p>{t`This draft contains formatting or images this editor cannot keep. The original is preserved until you edit the body.`}</p>
          {locked && (
            <button type="button" className={button} onClick={() => setEditPrompt(true)}>
              {t(EDIT_MESSAGE_TEXT)}
            </button>
          )}
        </div>
      )}
      <Alert
        open={editPrompt}
        onOpenChange={setEditPrompt}
        title={t`Edit this draft body?`}
        description={t`Editing removes unsupported formatting and images from this draft. Lists, bold, italic, underline and links are kept.`}
      >
        <AlertCancel>{t`Cancel`}</AlertCancel>
        <button
          type="button"
          className={alertPrimary}
          onClick={() => {
            setUnlocked(true);
            setEditPrompt(false);
          }}
        >
          {t(EDIT_MESSAGE_TEXT)}
        </button>
      </Alert>
      <Alert
        open={modePrompt !== null}
        onOpenChange={(open) => {
          if (!open) setModePrompt(null);
        }}
        title={t`Change writing mode?`}
        description={t`Some formatting cannot be kept in this mode. Link addresses are kept. You can undo the mode change.`}
      >
        <AlertCancel>{t`Cancel`}</AlertCancel>
        <button
          type="button"
          className={alertButton}
          onClick={() => {
            if (modePrompt) changeMode(modePrompt);
          }}
        >{t`Change mode`}</button>
      </Alert>
      {linkOpen && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 py-2">
          <input
            autoFocus
            aria-label={t`Link URL`}
            value={href}
            placeholder="https://"
            className="min-w-0 flex-1 rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-600"
            onChange={(e) => {
              setHref(e.target.value);
              setLinkError(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addLink();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setLinkOpen(false);
              }
            }}
          />
          <button type="button" className={button} onClick={addLink}>{t`Apply link`}</button>
          <button
            type="button"
            className={button}
            onClick={() => setLinkOpen(false)}
          >{t`Cancel`}</button>
          {linkError && (
            <span
              role="alert"
              className="w-full text-a11y-danger"
            >{t`Use an http, https or mailto link`}</span>
          )}
        </div>
      )}
      {locked && body.kind === "rich" && (
        <div className="bg-surface px-4 py-4">
          <EmailFrame
            html={composePreviewHtml(body, attachments)}
            remote={false}
            background="light"
            zoom={100}
            presentation="compose"
            previous={EMPTY_QUOTE_HISTORY}
            findQuery=""
            findIndex={0}
            onMatches={undefined}
            onActivate={constVoid}
            onKeyDown={(event) => {
              const forwarded = new window.KeyboardEvent("keydown", {
                key: event.key,
                metaKey: event.metaKey,
                ctrlKey: event.ctrlKey,
                altKey: event.altKey,
                shiftKey: event.shiftKey,
                bubbles: true,
                cancelable: true,
              });
              window.dispatchEvent(forwarded);
              if (forwarded.defaultPrevented) event.preventDefault();
            }}
          />
        </div>
      )}
      {body.kind === "rich" ? (
        <div
          hidden={locked}
          ref={(element) => {
            richRef.current = element;
            bodyRef.current = element;
          }}
          dir="auto"
          data-openmail-compose-body={!locked ? "true" : undefined}
          contentEditable={!locked}
          autoCorrect="on"
          suppressContentEditableWarning
          tabIndex={0}
          role="textbox"
          aria-multiline="true"
          aria-readonly={locked}
          aria-label={t({
            message: "Body",
            context: "message text",
            comment: "Email message text, never an anatomical body.",
          })}
          className="min-h-0 flex-1 overflow-auto px-4 py-3 text-callout leading-relaxed outline-none [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_a]:text-blue-600 [&_a]:underline [&_em]:italic [&_strong]:font-bold [&_s]:line-through [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_img]:max-w-full [&_img:not([height])]:h-auto [&_img]:cursor-pointer [&_code]:font-mono [&_pre]:font-mono [&_pre]:whitespace-pre-wrap [&_ul[type=dash]>li]:list-none [&_ul[type=dash]>li]:before:content-['–_']"
          style={body.font ? { fontFamily: body.font.family, fontSize: body.font.size } : undefined}
          onClick={(event) => {
            const target = event.target;
            setImageCid(
              target instanceof HTMLImageElement
                ? (target.getAttribute("data-compose-cid") ??
                    target.getAttribute("src")?.replace(/^cid:/, "") ??
                    null)
                : null,
            );
          }}
          onInput={(event) =>
            changed(
              "inputType" in event.nativeEvent &&
                event.nativeEvent.inputType === "insertText" &&
                !("isComposing" in event.nativeEvent && event.nativeEvent.isComposing),
            )
          }
          onCompositionEnd={() => changed(true)}
          onKeyUp={remember}
          onMouseUp={remember}
          onBlur={remember}
          onKeyDown={editorKey}
          onPaste={(e) => {
            if (e.defaultPrevented) return;
            e.preventDefault();
            if (locked) return;
            remember();
            const html = e.clipboardData.getData("text/html");
            if (html) command("insertHTML", richComposeBody(html).html);
            else command("insertText", e.clipboardData.getData("text/plain"));
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => e.preventDefault()}
        />
      ) : (
        <textarea
          data-openmail-compose-body="true"
          ref={(element) => {
            bodyRef.current = element;
          }}
          value={body.text}
          onKeyDown={editorKey}
          onChange={(e) => {
            setModeUndo(null);
            setEmojiUndo(null);
            const text = e.target.value;
            const at = e.target.selectionStart;
            const emojiChange =
              prefs.emojiReplacement &&
              !("isComposing" in e.nativeEvent && e.nativeEvent.isComposing === true)
                ? emojiAtCaret(text.slice(0, at), body.kind === "markdown")
                : null;
            if (emojiChange) {
              setEmojiUndo({ kind: body.kind, text });
              const element = e.target;
              const caret =
                at + emojiChange.replacement.length - (emojiChange.end - emojiChange.start);
              requestAnimationFrame(() => element.setSelectionRange(caret, caret));
              onChange({
                kind: body.kind,
                text:
                  text.slice(0, emojiChange.start) +
                  emojiChange.replacement +
                  text.slice(emojiChange.end),
              });
            } else onChange({ kind: body.kind, text });
          }}
          aria-label={t({
            message: "Body",
            context: "message text",
            comment: "Email message text, never an anatomical body.",
          })}
          placeholder={
            body.kind === "markdown"
              ? t`Markdown works: **bold**, \`code\`, \`\`\`code block\`\`\``
              : undefined
          }
          className={`min-h-0 flex-1 resize-none bg-transparent px-4 py-3 text-callout leading-relaxed outline-none placeholder:text-a11y-muted ${body.kind === "markdown" ? "font-mono text-body" : ""}`}
        />
      )}
    </div>
  );
}

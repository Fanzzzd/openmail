import { GrammarResults, useComposeGrammar } from "./ComposeGrammar";
import { ComposeToolbar } from "./ComposeToolbar";
import { PlainBody } from "./PlainBody";
import { RichBody } from "./RichBody";
import { useComposeFind } from "../hooks/use-compose-find";
import { useComposeMentions } from "../hooks/use-compose-mentions";
import { useComposePaste } from "../hooks/use-compose-paste";
import { useFormatOptions } from "../hooks/use-format-options";
import { BodyNotices, LockedPreview, ModeChangePrompt } from "./BodyNotices";
import { EditorMoreMenu } from "./EditorMoreMenu";
import {
  ComposeFindBar,
  ComposeLinkBar,
  MentionSuggestions,
  editorButton,
} from "./ComposeEditorBars";
import { composePreviewHtml } from "../compose-preview";
import { resizeComposeImage } from "../compose-contacts-dom";
import {
  matchesShortcut,
  type ShortcutAction,
  type ShortcutSet,
} from "../../../../../shared/shortcuts";
import { shortcutHint } from "../../../i18n/use-shortcut-text";
import { EDITOR_ACTION_EVENT } from "../../../../../shared/native-actions";
import { useLingui } from "@lingui/react/macro";
import {
  composeReplacement,
  composeConversion,
  composeHtmlHasUnsupported,
  editedComposeBody,
  composeLink,
  richComposeBody,
  escapeComposeText,
  type ComposeBody,
  type Address,
  type InlineImageSize,
  type Prefs,
  emojiAtCaret,
} from "@openmail/core/schema";
import {
  useEffect,
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
  editorCaretOffset,
  editorStartsParagraph,
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

/** Rich-text actions the Format menu and its keys run on the body. */
const RICH_ACTIONS = [
  "toggleFormatBar",
  "fontSizeIncrease",
  "fontSizeDecrease",
  ...FORMAT_ACTIONS,
  "bold",
  "italic",
  "underline",
  "link",
  "strikethrough",
] as const;
type RichAction = (typeof RICH_ACTIONS)[number];

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
  const richRef = useRef<HTMLDivElement>(null);
  const copiedStyle = useRef("");
  const smartUndo = useRef<{ body: ComposeBody; caret: number } | null>(null);
  const {
    formatBar,
    toggleFormatBar,
    smartLists,
    setSmartLists,
    markdownReplacement,
    setMarkdownReplacement,
  } = useFormatOptions(prefs);
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
  const [imageCid, setImageCid] = useState<string | null>(null);
  const [emojiUndo, setEmojiUndo] = useState<ComposeBody | null>(null);
  const replacingEmoji = useRef(false);
  const lastEmitted = useRef<string | null>(null);
  const [previewCache] = useState(makeInlinePreviewCache);
  const [linkOpen, setLinkOpen] = useState(false);
  const [href, setHref] = useState("");
  const [linkError, setLinkError] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
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
  const mentions = useComposeMentions({
    from,
    richRef,
    selectionRef,
    locked,
    onMentionsChange,
    insert: (html) => command("insertHTML", html),
    onMention,
  });
  const changeMode = (next: ComposeBody) => {
    setModeUndo(body);
    mentions.close();
    if (next.kind !== "rich") onMentionsChange([]);
    selectionRef.current = null;
    setLinkOpen(false);
    setModePrompt(null);
    onChange(next);
  };

  const syncMentions = useEffectEvent(() => mentions.refresh());
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
    mentions.refresh();
    mentions.updateQuery();
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
  const find = useComposeFind({
    body,
    bodyRef,
    shortcutSet,
    locked,
    onChange,
    remember,
    changed: () => changed(),
  });
  const { paste, pasteError } = useComposePaste({
    body,
    bodyRef,
    selectionRef,
    locked,
    onChange,
    remember,
    changed: () => changed(),
  });
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
      if (mentions.handleKey(event)) return;
    }
    if (find.handleKey(event, inBody === true)) return;
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
    const action = RICH_ACTIONS.find((candidate) => matchesShortcut(shortcutSet, candidate, event));
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    richAction(action);
  };
  const richAction = (action: RichAction) => {
    if (action === "toggleFormatBar") {
      toggleFormatBar();
      return;
    }
    remember();
    if (action === "fontSizeIncrease" || action === "fontSizeDecrease") {
      if (!richRef.current) return;
      stepEditorFontSize(
        richRef.current,
        selectionRef.current,
        action === "fontSizeIncrease" ? 1 : -1,
      );
      changed();
    } else if (action === "link") openLink();
    else if (
      action === "bold" ||
      action === "italic" ||
      action === "underline" ||
      action === "strikethrough"
    )
      command(action === "strikethrough" ? "strikeThrough" : action);
    else format(action);
  };
  // Format menu items without a key arrive as an event on the focused body.
  const menuAction = useEffectEvent((event: Event) => {
    const inBody =
      event.target === bodyRef.current ||
      (event.target instanceof Node && richRef.current?.contains(event.target));
    if (!inBody || locked || body.kind !== "rich") return;
    // Read off the event rather than through instanceof, which differs per window.
    const detail: unknown = Reflect.get(event, "detail");
    const action = RICH_ACTIONS.find((candidate) => candidate === detail);
    if (action) richAction(action);
  });
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return constVoid;
    const listener = (event: Event) => menuAction(event);
    root.addEventListener(EDITOR_ACTION_EVENT, listener);
    return () => root.removeEventListener(EDITOR_ACTION_EVENT, listener);
  }, []);

  return (
    <div
      ref={rootRef}
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
                className={editorButton}
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
                className={editorButton}
                onClick={undoEmoji}
              >{t`Undo emoji replacement`}</button>
            )}
          </>
        }
        more={
          <EditorMoreMenu
            locked={locked}
            rich={body.kind === "rich"}
            shortcut={shortcut}
            onFind={find.toggle}
            onPaste={paste}
            formatBar={formatBar}
            onToggleFormatBar={toggleFormatBar}
            smartLists={smartLists}
            onSmartLists={setSmartLists}
            markdownReplacement={markdownReplacement}
            onMarkdownReplacement={setMarkdownReplacement}
            imageSize={prefs.inlineImageSize}
            onImageSize={(size) => {
              onImageSize(size);
              resizeComposeImage(richRef.current, imageCid, size);
              changed();
            }}
            grammar={grammar}
          />
        }
      />
      {pasteError && <p role="alert">{t`Couldn't read clipboard`}</p>}
      {mentions.suggestions.length > 0 && (
        <MentionSuggestions
          people={mentions.suggestions}
          index={mentions.index}
          onPick={mentions.pick}
        />
      )}
      {find.finding && (
        <ComposeFindBar
          query={find.query}
          onQuery={find.setQuery}
          replacement={find.replacement}
          onReplacement={find.setReplacement}
          onKeyDown={(event) => {
            editorKey(event);
            find.barKey(event);
          }}
          index={find.index}
          count={find.count}
          locked={locked}
          onSelect={find.select}
          onReplace={find.replace}
          onClose={find.close}
        />
      )}
      <GrammarResults grammar={grammar} locked={locked} />
      <BodyNotices
        hiddenTextRemoved={!locked && body.kind === "rich" && body.hiddenTextRemoved === true}
        remoteUnsupported={remoteUnsupported}
        locked={locked}
        onUnlock={() => setUnlocked(true)}
      />
      <ModeChangePrompt
        open={modePrompt !== null}
        onCancel={() => setModePrompt(null)}
        onConfirm={() => {
          if (modePrompt) changeMode(modePrompt);
        }}
      />
      {linkOpen && (
        <ComposeLinkBar
          href={href}
          onHref={(next) => {
            setHref(next);
            setLinkError(false);
          }}
          error={linkError}
          onApply={addLink}
          onCancel={() => setLinkOpen(false)}
        />
      )}
      {locked && body.kind === "rich" && (
        <LockedPreview html={composePreviewHtml(body, attachments)} />
      )}
      {body.kind === "rich" ? (
        <RichBody
          font={body.font}
          locked={locked}
          richRef={richRef}
          bodyRef={bodyRef}
          onImage={setImageCid}
          onEdit={changed}
          remember={remember}
          onKeyDown={editorKey}
          command={command}
        />
      ) : (
        <PlainBody
          body={body}
          bodyRef={bodyRef}
          emojiReplacement={prefs.emojiReplacement}
          onKeyDown={editorKey}
          onEdit={(undo) => {
            setModeUndo(null);
            setEmojiUndo(undo);
          }}
          onChange={onChange}
        />
      )}
    </div>
  );
}

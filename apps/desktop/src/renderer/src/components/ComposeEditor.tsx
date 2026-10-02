/* oxlint-disable jsx-a11y/prefer-tag-over-role -- A contenteditable needs textbox semantics; textarea cannot retain rich marks. */
import { useLingui } from "@lingui/react/macro";
import {
  composeConversion,
  composeMatches,
  composeEditorText,
  composeHtmlHasUnsupported,
  editedComposeBody,
  composeLink,
  richComposeBody,
  escapeComposeText,
  type ComposeBody,
} from "@openmail/core/schema";
import { Bold, Italic, Underline, Link, Unlink } from "lucide-react";
import {
  useLayoutEffect,
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
  selectEditorMatch,
  replaceEditorMatches,
  type ComposeElement,
} from "../compose-editor-dom";
import type { OutgoingAttachment } from "../../../shared/api";
import { makeInlinePreviewCache } from "../compose-previews";
import { Select } from "./ui/Select";
import { Alert, AlertCancel, alertButton, alertPrimary } from "./ui/Dialog";

interface Props {
  body: ComposeBody;
  attachments: readonly OutgoingAttachment[];
  onChange: (body: ComposeBody) => void;
  bodyRef: RefObject<ComposeElement | null>;
  selectionRef: RefObject<Range | null>;
}

export function ComposeEditor({ body, attachments, onChange, bodyRef, selectionRef }: Props) {
  const { t } = useLingui();
  const richRef = useRef<HTMLDivElement>(null);
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
  const changeMode = (next: ComposeBody) => {
    setModeUndo(body);
    selectionRef.current = null;
    setLinkOpen(false);
    setModePrompt(null);
    onChange(next);
  };

  useLayoutEffect(() => () => previewCache.dispose(), [previewCache]);
  useLayoutEffect(() => {
    previewCache.sync(attachments);
    const element = richRef.current;
    if (body.kind !== "rich" || !element) {
      lastEmitted.current = null;
      return constVoid;
    }
    // Leave the live DOM and caret alone for our own input/IME events.
    if (lastEmitted.current !== body.html) element.innerHTML = richComposeBody(body.html).html;
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
    return constVoid;
  }, [body, attachments, previewCache]);

  const remember = () => {
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (range && richRef.current?.contains(range.commonAncestorContainer)) {
      selectionRef.current = range.cloneRange();
    }
  };
  const changed = () => {
    if (!richRef.current || locked) return;
    if (body.kind !== "rich") return;
    const next = editedComposeBody(body, composeEditorHtml(richRef.current));
    if (next !== body) setModeUndo(null);
    lastEmitted.current = next.html;
    remember();
    onChange(next);
  };
  const command = (name: string, value?: string) => {
    if (!richRef.current || locked) return;
    restoreEditorSelection(richRef.current, selectionRef.current);
    document.execCommand("styleWithCSS", false, "false");
    document.execCommand(name, false, value);
    changed();
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
    if (event.key === "Enter") {
      event.preventDefault();
      if (matches.length) selectMatch((findIndex + 1) % matches.length);
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setFinding(false);
    }
  };
  const button =
    "rounded p-1.5 text-neutral-500 hover:bg-black/5 focus-visible:outline-blue-500 dark:text-neutral-400 dark:hover:bg-white/10";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-black/[0.07] px-4 py-1 dark:border-white/[0.08]">
        <Select
          aria-label={t`Writing mode`}
          value={body.kind}
          options={[
            { value: "rich", label: t`Rich text` },
            { value: "plain", label: t`Plain text` },
            { value: "markdown", label: t`Markdown` },
          ]}
          onValueChange={(kind) => {
            const conversion = composeConversion(body, kind);
            if (conversion.losesFormatting) setModePrompt(conversion.body);
            else changeMode(conversion.body);
          }}
        />
        <button
          type="button"
          className={button}
          disabled={locked}
          onClick={() => setFinding((value) => !value)}
        >{t`Find and replace`}</button>
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
        {body.kind === "rich" && (
          <>
            {[
              { name: "bold", label: t`Bold`, Icon: Bold },
              { name: "italic", label: t`Italic`, Icon: Italic },
              { name: "underline", label: t`Underline`, Icon: Underline },
            ].map(({ name, label, Icon }) => (
              <button
                key={name}
                type="button"
                disabled={locked}
                aria-label={label}
                title={label}
                className={button}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => command(name)}
              >
                <Icon className="size-4" />
              </button>
            ))}
            <button
              type="button"
              disabled={locked}
              aria-label={t`Edit link`}
              title={t`Edit link`}
              className={button}
              onMouseDown={(e) => e.preventDefault()}
              onClick={openLink}
            >
              <Link className="size-4" />
            </button>
            <button
              type="button"
              disabled={locked}
              aria-label={t`Remove link`}
              title={t`Remove link`}
              className={button}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => command("unlink")}
            >
              <Unlink className="size-4" />
            </button>
          </>
        )}
      </div>
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
            className="min-w-0 flex-1 rounded border px-2 py-1"
          />
          <input
            aria-label={t`Replace with`}
            placeholder={t`Replace with`}
            value={replacement}
            onKeyDown={findKey}
            onChange={(event) => setReplacement(event.target.value)}
            className="min-w-0 flex-1 rounded border px-2 py-1"
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
      {remoteUnsupported && (
        <div
          role="status"
          className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100"
        >
          <p>{t`This draft contains formatting or images this editor cannot keep. The original is preserved until you edit the body.`}</p>
          {locked && (
            <button
              type="button"
              className={button}
              onClick={() => setEditPrompt(true)}
            >{t`Edit body`}</button>
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
        >{t`Edit body`}</button>
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
              className="w-full text-red-500"
            >{t`Use an http, https or mailto link`}</span>
          )}
        </div>
      )}
      {body.kind === "rich" ? (
        <div
          ref={(element) => {
            richRef.current = element;
            bodyRef.current = element;
          }}
          contentEditable={!locked}
          suppressContentEditableWarning
          tabIndex={0}
          role="textbox"
          aria-multiline="true"
          aria-readonly={locked}
          aria-label={t`Body`}
          className="min-h-0 flex-1 overflow-auto px-4 py-3 text-[14px] leading-relaxed outline-none [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_a]:text-blue-600 [&_a]:underline [&_em]:italic [&_strong]:font-bold"
          onInput={changed}
          onKeyUp={remember}
          onMouseUp={remember}
          onBlur={remember}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
              e.preventDefault();
              setFinding(true);
              return;
            }
            if (locked) return;
            if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
              const key = e.key.toLowerCase();
              if (key === "b" || key === "i" || key === "u" || key === "k") {
                e.preventDefault();
                remember();
                if (key === "k") openLink();
                else command(key === "b" ? "bold" : key === "i" ? "italic" : "underline");
              }
            }
          }}
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
          ref={(element) => {
            bodyRef.current = element;
          }}
          value={body.text}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
              e.preventDefault();
              setFinding(true);
            }
          }}
          onChange={(e) => {
            setModeUndo(null);
            onChange({ kind: body.kind, text: e.target.value });
          }}
          aria-label={t`Body`}
          placeholder={
            body.kind === "markdown"
              ? t`Markdown works: **bold**, \`code\`, \`\`\`code block\`\`\``
              : undefined
          }
          className={`min-h-0 flex-1 resize-none bg-transparent px-4 py-3 text-[14px] leading-relaxed outline-none placeholder:text-neutral-400 ${body.kind === "markdown" ? "font-mono text-[13px]" : ""}`}
        />
      )}
    </div>
  );
}

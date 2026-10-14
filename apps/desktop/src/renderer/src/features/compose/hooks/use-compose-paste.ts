import { composePaste, type ComposeBody } from "@openmail/core/schema";
import { Effect } from "effect";
import { useState, type RefObject } from "react";
import { isDesktop } from "../../../lib/platform";
import { useRunMail, withMail, type MailEnv } from "../../../state/mail";
import { editorBody, restoreEditorSelection, type ComposeElement } from "../compose-editor-dom";

const clipboardText = (): Effect.Effect<string, unknown, MailEnv> =>
  isDesktop()
    ? withMail((call) => call("ClipboardText", undefined))
    : // The browser reads this device's clipboard, never the Mac's.
      Effect.tryPromise(() => navigator.clipboard.readText());

interface Options {
  body: ComposeBody;
  bodyRef: RefObject<ComposeElement | null>;
  selectionRef: RefObject<Range | null>;
  locked: boolean;
  onChange: (body: ComposeBody) => void;
  remember: () => void;
  /** Emits the rich body after the paste edited it in place. */
  changed: () => void;
}

/**
 * Paste and Match Style and Paste as Quotation. The clipboard read is async, so the paste is
 * dropped when the body changed or went read-only in the meantime.
 */
export function useComposePaste({
  body,
  bodyRef,
  selectionRef,
  locked,
  onChange,
  remember,
  changed,
}: Options) {
  const run = useRunMail();
  const [pasteError, setPasteError] = useState(false);
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
  return { paste, pasteError };
}

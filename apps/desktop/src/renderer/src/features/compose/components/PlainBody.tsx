import { useLingui } from "@lingui/react/macro";
import { emojiAtCaret, type ComposeBody } from "@openmail/core/schema";
import type { KeyboardEvent, RefObject } from "react";
import type { ComposeElement } from "../compose-editor-dom";

/** The plain text or Markdown body, with emoji replacement as the person types. */
export function PlainBody({
  body,
  bodyRef,
  emojiReplacement,
  onKeyDown,
  onEdit,
  onChange,
}: {
  body: Extract<ComposeBody, { kind: "plain" | "markdown" }>;
  bodyRef: RefObject<ComposeElement | null>;
  emojiReplacement: boolean;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  /** Every edit; `emojiUndo` is the text before an emoji replacement, if this edit made one. */
  onEdit: (emojiUndo: ComposeBody | null) => void;
  onChange: (body: ComposeBody) => void;
}) {
  const { t } = useLingui();
  return (
    <textarea
      data-openmail-compose-body="true"
      ref={(element) => {
        bodyRef.current = element;
      }}
      value={body.text}
      onKeyDown={onKeyDown}
      onChange={(e) => {
        const text = e.target.value;
        const at = e.target.selectionStart;
        const emojiChange =
          emojiReplacement &&
          !("isComposing" in e.nativeEvent && e.nativeEvent.isComposing === true)
            ? emojiAtCaret(text.slice(0, at), body.kind === "markdown")
            : null;
        onEdit(emojiChange ? { kind: body.kind, text } : null);
        if (emojiChange) {
          const element = e.target;
          const caret = at + emojiChange.replacement.length - (emojiChange.end - emojiChange.start);
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
  );
}

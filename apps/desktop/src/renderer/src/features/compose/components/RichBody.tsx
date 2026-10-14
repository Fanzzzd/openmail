/* oxlint-disable jsx-a11y/prefer-tag-over-role -- A contenteditable needs textbox semantics; textarea cannot retain rich marks. */
import { richComposeBody, type ComposeBody } from "@openmail/core/schema";
import { useLingui } from "@lingui/react/macro";
import type { KeyboardEvent, RefObject } from "react";
import type { ComposeElement } from "../compose-editor-dom";

interface Props {
  font: Extract<ComposeBody, { kind: "rich" }>["font"];
  locked: boolean;
  richRef: RefObject<HTMLDivElement | null>;
  bodyRef: RefObject<ComposeElement | null>;
  /** The Content-ID of the clicked inline image, or null for a click elsewhere. */
  onImage: (cid: string | null) => void;
  /** After every edit; `typing` is true for typed text, so replacements may run. */
  onEdit: (typing: boolean) => void;
  remember: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  command: (name: string, value?: string) => boolean;
}

/** The contenteditable rich-text body. The parent owns its HTML and emits each edit. */
export function RichBody({
  font,
  locked,
  richRef,
  bodyRef,
  onImage,
  onEdit,
  remember,
  onKeyDown,
  command,
}: Props) {
  const { t } = useLingui();
  return (
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
      style={font ? { fontFamily: font.family, fontSize: font.size } : undefined}
      onClick={(event) => {
        const target = event.target;
        onImage(
          target instanceof HTMLImageElement
            ? (target.getAttribute("data-compose-cid") ??
                target.getAttribute("src")?.replace(/^cid:/, "") ??
                null)
            : null,
        );
      }}
      onInput={(event) =>
        onEdit(
          "inputType" in event.nativeEvent &&
            event.nativeEvent.inputType === "insertText" &&
            !("isComposing" in event.nativeEvent && event.nativeEvent.isComposing),
        )
      }
      onCompositionEnd={() => onEdit(true)}
      onKeyUp={remember}
      onMouseUp={remember}
      onBlur={remember}
      onKeyDown={onKeyDown}
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
  );
}

import {
  quoteOffset,
  mobileComposeQuoteOffset,
  spliceMobileComposeBody,
  type OutgoingMessage,
} from "@openmail/core/portable";
import { richTextBody, type Mark } from "./rich-text";

export type AiEditorBody = Pick<OutgoingMessage, "text" | "html" | "originalHtml"> & {
  marks: readonly Mark[];
  list: boolean;
};
export type AiEditUndo = { before: AiEditorBody; acceptedText: string };
export function aiUndoBody(
  current: Pick<OutgoingMessage, "text">,
  undo: AiEditUndo,
): AiEditorBody | null {
  return current.text === undo.acceptedText ? undo.before : null;
}
export function composeAiPart(text: string, signature?: string, html?: string) {
  const quoted = Math.min(
    quoteOffset(text),
    mobileComposeQuoteOffset({ text, html }) ?? text.length,
  );
  const prefix = text.slice(0, quoted);
  const separator = /^--[ \t]*\r?$/m.exec(prefix);
  let authored = prefix.slice(0, separator?.index ?? prefix.length).trim();
  const beforeQuote = prefix.trimEnd();
  if (signature?.trim() && beforeQuote.endsWith(signature.trim())) {
    const at = beforeQuote.length - signature.trim().length;
    if (at === 0 || beforeQuote[at - 1] === "\n")
      authored = text.slice(0, Math.min(at, separator?.index ?? at)).trim();
  }
  const start = authored ? text.indexOf(authored) : 0;
  return { text: authored, start, end: start + authored.length };
}
export function applyAiEdit(
  body: AiEditorBody,
  replacement: string,
  signature?: string,
): AiEditorBody | null {
  const part = composeAiPart(body.text, signature, body.html);
  if (!part.text) return null;
  const after = replacement.trim();
  if (!after) return null;
  const text = body.text.slice(0, part.start) + after + body.text.slice(part.end);
  const delta = after.length - part.text.length;
  const retained = body.marks.flatMap((mark) => [
    ...(mark.start < part.start ? [{ ...mark, end: Math.min(mark.end, part.start) }] : []),
    ...(mark.end > part.end
      ? [{ ...mark, start: Math.max(mark.start, part.end) + delta, end: mark.end + delta }]
      : []),
  ]);
  if (body.html !== undefined) {
    const result = spliceMobileComposeBody(body, part.start, part.end, after);
    if (!result) return null;
    const end = part.start + after.length;
    const rewritten = result.marks
      .filter((mark) => mark.start < end && mark.end > part.start)
      .map((mark) => ({
        ...mark,
        start: Math.max(part.start, mark.start),
        end: Math.min(end, mark.end),
      }));
    return { ...result, marks: [...rewritten, ...retained] };
  }
  return { ...richTextBody(text, retained, body.list), marks: retained, list: body.list };
}

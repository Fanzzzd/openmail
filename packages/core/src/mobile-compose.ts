import { parseDocument, ElementType } from "htmlparser2";
import { richComposeBody } from "./compose-body.js";
import type { OutgoingMessage } from "./domain.js";
export type MobileComposeMark = { start: number; end: number; kind: "bold" | "italic" };
type Node = ReturnType<typeof parseDocument>["children"][number];
/** Restore the mobile editor's text and ranges from canonical sanitized HTML.
 * List markers belong to rendering, not the editable text or range offsets. */
export function restoreMobileRichText(message: Pick<OutgoingMessage, "text" | "html">): {
  text: string;
  marks: MobileComposeMark[];
  list: boolean;
} {
  if (message.html === undefined) return { text: message.text, marks: [], list: false };
  const body = richComposeBody(message.html);
  let text = "";
  const marks: MobileComposeMark[] = [];
  let list = false;
  let breakPending = false;
  const flushBreak = () => {
    if (breakPending && text && !text.endsWith("\n")) text += "\n";
    breakPending = false;
  };
  const visit = (node: Node): void => {
    if (node.type === ElementType.Text) {
      if (node.data) {
        flushBreak();
        text += node.data;
      }
      return;
    }
    if (!("children" in node)) return;
    const name = node.type === ElementType.Tag ? node.name : "";
    if (name === "br") {
      breakPending = false;
      text += "\n";
      return;
    }
    const block = ["div", "p", "li", "ul", "ol", "blockquote", "pre"].includes(name);
    if (block && text) breakPending = true;
    if (name === "ul" || name === "ol") list = true;
    const kind = name === "strong" ? "bold" : name === "em" ? "italic" : null;
    if (kind) flushBreak();
    const start = text.length;
    for (const child of node.children) visit(child);
    if (kind && text.length > start) marks.push({ start, end: text.length, kind });
    if (block) breakPending = true;
  };
  for (const node of parseDocument(body.html).children) visit(node);
  return { text, marks, list };
}

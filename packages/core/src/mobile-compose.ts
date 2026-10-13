import { Parser, parseDocument, ElementType } from "htmlparser2";
import { escapeComposeText, richComposeBody } from "./compose-body.js";
import type { OutgoingMessage } from "./domain/domain.js";
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
  const { text, marks, list } = projectMobileHtml(richComposeBody(message.html).html);
  return { text, marks, list };
}

function projectMobileHtml(html: string) {
  let text = "";
  const marks: MobileComposeMark[] = [];
  const runs: { start: number; end: number; node: Node }[] = [];
  const quote: { start: number | null } = { start: null };
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
        const start = text.length;
        text += node.data;
        runs.push({ start, end: text.length, node });
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
    if (name === "blockquote" && quote.start === null) quote.start = text.length;
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
  for (const node of parseDocument(html, { withStartIndices: true, withEndIndices: true }).children)
    visit(node);
  return { text, marks, list, runs, quoteStart: quote.start };
}

/** Replace one editor text range, preserving all HTML outside its source boundaries.
 * The input must match the editor projection; a mismatch cannot overwrite retained content. */
export function spliceMobileComposeBody(
  message: Pick<OutgoingMessage, "text" | "html">,
  start: number,
  end: number,
  replacement: string,
): { text: string; html: string; marks: MobileComposeMark[]; list: boolean } | null {
  if (message.html === undefined) return null;
  const html = message.html;
  const projection = projectMobileHtml(html);
  const offsets = editorOffsets(projection.text, message.text);
  if (!offsets) return null;
  const sourceStart = offsets.findIndex((offset) => offset >= start);
  const sourceEnd = offsets.findIndex((offset) => offset >= end);
  const first = projection.runs.find((run) => run.start <= sourceStart && sourceStart < run.end);
  const last = projection.runs.find((run) => run.start < sourceEnd && sourceEnd <= run.end);
  if (!first || !last) return null;
  const from = rawOffset(html, first, sourceStart),
    to = rawOffset(html, last, sourceEnd);
  if (from === null || to === null) return null;
  const a = ancestors(first.node),
    b = ancestors(last.node);
  let shared = 0;
  while (shared < Math.min(a.length, b.length) && a[shared] === b[shared]) shared++;
  const closing = a
    .slice(shared)
    .toReversed()
    .map((node) => ("name" in node ? `</${node.name}>` : ""))
    .join("");
  const opening = b
    .slice(shared)
    .map((node) => {
      if (node.startIndex === null) return "";
      let quote = "";
      for (let index = node.startIndex; index < html.length; index++) {
        const char = html[index];
        if (quote) {
          if (char === quote) quote = "";
        } else if (char === '"' || char === "'") quote = char;
        else if (char === ">") return html.slice(node.startIndex, index + 1);
      }
      return "";
    })
    .join("");
  const nextHtml =
    html.slice(0, from) +
    escapeComposeText(replacement).replaceAll("\n", "<br>") +
    closing +
    opening +
    html.slice(to);
  const next = projectMobileHtml(nextHtml);
  const text = message.text.slice(0, start) + replacement + message.text.slice(end);
  const nextOffsets = editorOffsets(next.text, text);
  if (!nextOffsets) return null;
  const marks = next.marks.map((mark) => ({
    ...mark,
    start: nextOffsets[mark.start] ?? 0,
    end: nextOffsets[mark.end] ?? text.length,
  }));
  return { text, html: nextHtml, marks, list: next.list };
}

function ancestors(node: Node): Node[] {
  const path: Node[] = [];
  for (let parent = node.parent; parent; parent = parent.parent)
    if (parent.type === ElementType.Tag) path.unshift(parent);
  return path;
}

function rawOffset(html: string, run: { start: number; node: Node }, at: number): number | null {
  const { startIndex, endIndex } = run.node;
  if (startIndex === null || endIndex === null) return null;
  const target = at - run.start;
  const result: { offset: number | null } = { offset: null };
  let decoded = 0;
  const parser = new Parser({
    ontext(data) {
      if (target >= decoded && target <= decoded + data.length) {
        const relative = target - decoded;
        const rawLength = parser.endIndex + 1 - parser.startIndex;
        // Entity callbacks may cover several source bytes for one decoded character.
        if (relative === 0) result.offset = startIndex + parser.startIndex;
        else if (relative === data.length) result.offset = startIndex + parser.endIndex + 1;
        else if (rawLength === data.length)
          result.offset = startIndex + parser.startIndex + relative;
      }
      decoded += data.length;
    },
  });
  parser.end(html.slice(startIndex, endIndex + 1));
  return result.offset;
}

/** HTML blockquotes may lack the plain-text > prefix in imported drafts. */
export function mobileComposeQuoteOffset(
  message: Pick<OutgoingMessage, "text" | "html">,
): number | null {
  if (message.html === undefined) return null;
  const projection = projectMobileHtml(message.html);
  const offsets = editorOffsets(projection.text, message.text);
  return offsets && projection.quoteStart !== null
    ? (offsets[projection.quoteStart] ?? null)
    : null;
}

/** Source prefix for the authored part; visible-text filtering happens before AI input. */
export function mobileComposeTextPrefix(
  message: Pick<OutgoingMessage, "text" | "html">,
  end: number,
): string | null {
  if (message.html === undefined) return "";
  const projection = projectMobileHtml(message.html);
  const offsets = editorOffsets(projection.text, message.text);
  if (!offsets) return null;
  const sourceEnd = offsets.findIndex((offset) => offset >= end);
  const run = projection.runs.find((entry) => entry.start < sourceEnd && sourceEnd <= entry.end);
  if (!run) return null;
  const to = rawOffset(message.html, run, sourceEnd);
  return to === null ? null : message.html.slice(0, to);
}

/** The editor keeps whitespace that canonical HTML may collapse. Align only whitespace,
 * never changed words, so retained text and HTML can both survive a partial replacement. */
function editorOffsets(source: string, editor: string): number[] | null {
  const offsets = [0];
  let index = 0,
    target = 0;
  while (index < source.length || target < editor.length) {
    if (/\s/.test(source[index] ?? "") || /\s/.test(editor[target] ?? "")) {
      const from = index,
        before = target;
      while (index < source.length && /\s/.test(source[index] ?? "")) index++;
      while (target < editor.length && /\s/.test(editor[target] ?? "")) target++;
      if (index === from) offsets[index] = target;
      else
        for (let at = from + 1; at <= index; at++)
          offsets[at] = before + Math.ceil(((at - from) * (target - before)) / (index - from));
    } else {
      if (source[index] !== editor[target]) return null;
      index++;
      target++;
      offsets[index] = target;
    }
  }
  return offsets;
}

import {
  richComposeBody,
  editedComposeBody,
  textComposeHtml,
  escapeComposeText,
  type ComposeBody,
} from "@openmail/core/schema";

export type ComposeElement = HTMLDivElement | HTMLTextAreaElement;

export function editorBody(element: ComposeElement, previous: ComposeBody): ComposeBody {
  return element instanceof HTMLTextAreaElement
    ? { kind: previous.kind === "markdown" ? "markdown" : "plain", text: element.value }
    : previous.kind === "rich"
      ? editedComposeBody(previous, composeEditorHtml(element))
      : richComposeBody(composeEditorHtml(element));
}

/** Return selection to this editor after a toolbar, template picker or link field. */
export function restoreEditorSelection(element: HTMLElement, saved: Range | null): void {
  element.focus();
  const selection = window.getSelection();
  if (!selection) return;
  const range =
    saved && element.contains(saved.commonAncestorContainer) ? saved : document.createRange();
  if (range !== saved) {
    range.selectNodeContents(element);
    range.collapse(false);
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

export function insertEditorText(element: ComposeElement, text: string, saved: Range | null): void {
  if (element instanceof HTMLTextAreaElement) {
    const at = element.selectionStart;
    element.setRangeText(text, at, element.selectionEnd, "end");
    element.focus();
  } else {
    restoreEditorSelection(element, saved);
    // Chromium's editing commands preserve native undo, including paste and templates.
    document.execCommand("insertHTML", false, textComposeHtml(text));
  }
}

type Point = { node: Node; offset: number };

/** Text offsets include block/BR line breaks, just like the core compose serializer. */
function textPoints(element: HTMLElement): Point[] {
  const points: Point[] = [{ node: element, offset: 0 }];
  let text = "";
  const newline = (point: Point) => {
    if (text && !text.endsWith("\n")) {
      text += "\n";
      points.push(point);
    }
  };
  const walk = (parent: Node) => {
    for (const [index, node] of [...parent.childNodes].entries()) {
      if (node.nodeType === Node.TEXT_NODE) {
        const value = node.textContent ?? "";
        // Positions following a virtual block break must land inside the next text node.
        points[text.length] = { node, offset: 0 };
        for (let i = 0; i < value.length; i++) {
          text += value[i];
          points.push({ node, offset: i + 1 });
        }
      } else if (node instanceof HTMLElement) {
        const block = new Set(["DIV", "P", "UL", "OL", "LI", "BLOCKQUOTE"]).has(node.tagName);
        if (block) newline({ node: parent, offset: index });
        if (node.tagName === "BR") {
          text += "\n";
          points.push({ node: parent, offset: index + 1 });
        } else walk(node);
        if (block) newline({ node: parent, offset: index + 1 });
      }
    }
  };
  walk(element);
  return points;
}

/** Replace the changed text span only, so changing From preserves other rich marks. */
export function replaceEditorText(element: ComposeElement, previous: string, next: string): void {
  if (element instanceof HTMLTextAreaElement) {
    element.value = next;
    return;
  }
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) start++;
  let end = previous.length;
  let nextEnd = next.length;
  while (end > start && nextEnd > start && previous[end - 1] === next[nextEnd - 1]) {
    end--;
    nextEnd--;
  }
  const points = textPoints(element);
  const first = points[start];
  const last = points[end];
  if (!first || !last) return;
  const range = document.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset);
  restoreEditorSelection(element, range);
  document.execCommand("insertHTML", false, textComposeHtml(next.slice(start, nextEnd)));
}

/** Blob previews are local presentation only; drafts and MIME retain the CID. */
export function composeEditorHtml(element: HTMLElement): string {
  const copy = element.cloneNode(true);
  if (!(copy instanceof HTMLElement)) return "";
  for (const image of copy.querySelectorAll("img[data-compose-cid]")) {
    image.setAttribute("src", `cid:${image.getAttribute("data-compose-cid") ?? ""}`);
    image.removeAttribute("data-compose-cid");
  }
  return copy.innerHTML;
}

export function editorMatchPoints(element: HTMLElement, start: number, end: number) {
  const points = textPoints(element);
  const first = points[start];
  const last = points[end];
  return first && last ? { first, last } : undefined;
}

export function selectEditorMatch(element: ComposeElement, start: number, end: number): boolean {
  if (element instanceof HTMLTextAreaElement) {
    element.focus();
    element.setSelectionRange(start, end);
    return true;
  }
  const points = editorMatchPoints(element, start, end);
  if (!points) return false;
  const range = document.createRange();
  range.setStart(points.first.node, points.first.offset);
  range.setEnd(points.last.node, points.last.offset);
  restoreEditorSelection(element, range);
  return true;
}

/** One editing command per Replace/Replace All keeps the operation on Chromium's undo stack. */
export function replaceEditorMatches(
  element: ComposeElement,
  matches: readonly { start: number; end: number }[],
  replacement: string,
): boolean {
  const ordered = matches.toSorted((a, b) => a.start - b.start);
  const first = ordered[0];
  const last = ordered.at(-1);
  if (!first || !last) return false;
  if (element instanceof HTMLTextAreaElement) {
    let text = element.value.slice(first.start, last.end);
    for (const match of ordered.toReversed()) {
      text =
        text.slice(0, match.start - first.start) +
        replacement +
        text.slice(match.end - first.start);
    }
    selectEditorMatch(element, first.start, last.end);
    return document.execCommand("insertText", false, text);
  }
  if (ordered.length === 1) {
    if (!selectEditorMatch(element, first.start, first.end)) return false;
    return document.execCommand(
      "insertHTML",
      false,
      escapeComposeText(replacement).replaceAll("\n", "<br>"),
    );
  }
  const copy = element.cloneNode(true);
  if (!(copy instanceof HTMLElement)) return false;
  for (const match of ordered.toReversed()) {
    const points = editorMatchPoints(copy, match.start, match.end);
    if (!points) return false;
    const range = document.createRange();
    range.setStart(points.first.node, points.first.offset);
    range.setEnd(points.last.node, points.last.offset);
    range.deleteContents();
    const fragment = document.createDocumentFragment();
    for (const [index, line] of replacement.split("\n").entries()) {
      if (index) fragment.append(document.createElement("br"));
      fragment.append(document.createTextNode(line));
    }
    range.insertNode(fragment);
  }
  const range = document.createRange();
  range.selectNodeContents(element);
  restoreEditorSelection(element, range);
  return document.execCommand("insertHTML", false, composeEditorHtml(copy));
}

import {
  richComposeBody,
  editedComposeBody,
  textComposeHtml,
  type ComposeBody,
} from "@openmail/core/schema";

export type ComposeElement = HTMLDivElement | HTMLTextAreaElement;

export function editorBody(element: ComposeElement, previous: ComposeBody): ComposeBody {
  return element instanceof HTMLTextAreaElement
    ? { kind: previous.kind === "markdown" ? "markdown" : "plain", text: element.value }
    : previous.kind === "rich"
      ? editedComposeBody(previous, element.innerHTML)
      : richComposeBody(element.innerHTML);
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
function textPoints(element: HTMLDivElement): Point[] {
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
        const block = new Set(["DIV", "P", "UL", "OL", "LI"]).has(node.tagName);
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

import {
  COMPOSE_FONT_SIZES,
  composeStyle,
  richComposeBody,
  type ComposeReplacement,
} from "@openmail/core/schema";
import {
  editorCaretOffset,
  composeEditorHtml,
  editorMatchPoints,
  restoreEditorSelection,
} from "./compose-editor-dom";

export type FormatAction =
  | "superscript"
  | "subscript"
  | "alignLeft"
  | "alignCenter"
  | "alignRight"
  | "alignJustify"
  | "directionLtr"
  | "directionRtl"
  | "directionAuto"
  | "bulletList"
  | "numberList"
  | "dashList"
  | "inlineCode"
  | "blockCode"
  | "indentParagraph"
  | "outdentParagraph"
  | "indentList"
  | "outdentList"
  | "quoteIncrease"
  | "quoteDecrease"
  | "copyStyle"
  | "pasteStyle"
  | "clearFormatting";
export const FORMAT_ACTIONS: readonly FormatAction[] = [
  "superscript",
  "subscript",
  "alignLeft",
  "alignCenter",
  "alignRight",
  "alignJustify",
  "directionLtr",
  "directionRtl",
  "directionAuto",
  "bulletList",
  "numberList",
  "dashList",
  "inlineCode",
  "blockCode",
  "indentParagraph",
  "outdentParagraph",
  "indentList",
  "outdentList",
  "quoteIncrease",
  "quoteDecrease",
  "copyStyle",
  "pasteStyle",
  "clearFormatting",
];

function pathTo(root: Node, node: Node): number[] {
  const path: number[] = [];
  while (node !== root && node.parentNode) {
    path.unshift([...node.parentNode.childNodes].findIndex((child) => child === node));
    node = node.parentNode;
  }
  return path;
}
function atPath(root: Node, path: number[]): Node {
  for (const index of path) root = root.childNodes[index] ?? root;
  return root;
}
function paragraph(root: HTMLElement, node: Node): HTMLElement {
  let block = (node instanceof HTMLElement ? node : node.parentElement)?.closest("div,p,li,pre");
  if (block instanceof HTMLElement && block !== root && root.contains(block)) return block;
  const wrapper = root.ownerDocument.createElement("div");
  while (root.firstChild) wrapper.append(root.firstChild);
  root.append(wrapper);
  return wrapper;
}
function replaceTag(element: HTMLElement, tag: string): HTMLElement {
  const next = element.ownerDocument.createElement(tag);
  for (const attribute of element.attributes) next.setAttribute(attribute.name, attribute.value);
  while (element.firstChild) next.append(element.firstChild);
  element.replaceWith(next);
  return next;
}
/** Lift one selected branch, preserving siblings before and after with their formatting. */
function liftFromParent(node: HTMLElement, parent: HTMLElement): void {
  const before = parent.cloneNode(false);
  const after = parent.cloneNode(false);
  let passed = false;
  for (const child of Array.from(parent.childNodes)) {
    if (child === node) {
      passed = true;
      continue;
    }
    (passed ? after : before).appendChild(child);
  }
  const parts: Node[] = [];
  if (before.textContent || (before instanceof HTMLElement && before.querySelector("img,br")))
    parts.push(before);
  parts.push(node);
  if (after.textContent || (after instanceof HTMLElement && after.querySelector("img,br")))
    parts.push(after);
  parent.replaceWith(...parts);
}
/** Mutate a detached tree and commit one sanitized native edit, retaining Chromium undo. */
export function formatEditor(
  root: HTMLElement,
  saved: Range | null,
  action: FormatAction,
  copied: string,
): string {
  restoreEditorSelection(root, saved);
  const range = window.getSelection()?.rangeCount ? window.getSelection()?.getRangeAt(0) : null;
  const caret = range
    ? { start: editorCaretOffset(root, range), end: editorCaretOffset(root, range, "end") }
    : null;
  const copy = root.cloneNode(true);
  if (!(copy instanceof HTMLElement)) return copied;
  const target = range ? atPath(copy, pathTo(root, range.startContainer)) : copy;
  const endTarget = range ? atPath(copy, pathTo(root, range.endContainer)) : copy;
  if (action === "copyStyle") {
    const styles: string[] = [];
    for (
      let node =
        range?.startContainer instanceof HTMLElement
          ? range.startContainer
          : range?.startContainer.parentElement;
      node && node !== root;
      node = node.parentElement
    ) {
      // Outer declarations precede inner ones so the nearest style wins.
      styles.unshift(node.getAttribute("style") ?? "");
      if (node.matches("b,strong")) styles.push("__bold");
      if (node.matches("i,em")) styles.push("__italic");
      if (node.matches("u")) styles.push("text-decoration:underline");
      if (node.matches("s,strike")) styles.push("text-decoration:line-through");
      if (node.matches("sub,sup,code")) styles.push(`__${node.tagName.toLowerCase()}`);
    }
    return [root.getAttribute("style") ?? "font-family:Arial;font-size:14px", ...styles].join(";");
  }
  const block = paragraph(copy, target);
  const blocks = [block];
  if (range && !range.collapsed) {
    for (const original of root.querySelectorAll("div,p,li,pre")) {
      if (!(original instanceof HTMLElement) || !range.intersectsNode(original)) continue;
      const candidate = atPath(copy, pathTo(root, original));
      if (candidate instanceof HTMLElement && !blocks.includes(candidate)) blocks.push(candidate);
    }
  }
  for (let item of blocks) {
    if (!copy.contains(item)) continue;
    if (action.startsWith("align")) item.style.textAlign = action.slice(5).toLowerCase();
    else if (action.startsWith("direction")) {
      const dir = action === "directionAuto" ? "auto" : action === "directionRtl" ? "rtl" : "ltr";
      item.setAttribute("dir", dir);
      if (dir === "auto") item.style.removeProperty("direction");
      else item.style.direction = dir;
    } else if (action === "indentParagraph" || action === "outdentParagraph") {
      const current = Number.parseInt(item.style.marginLeft || "0");
      item.style.marginLeft = `${Math.max(0, Math.min(240, current + (action === "indentParagraph" ? 24 : -24)))}px`;
    } else if (action === "quoteIncrease") {
      const quote = copy.ownerDocument.createElement("blockquote");
      item.before(quote);
      quote.append(item);
    } else if (action === "quoteDecrease") {
      const quote = item.closest("blockquote");
      if (quote instanceof HTMLElement && copy.contains(quote)) {
        let branch = item;
        while (branch.parentElement && branch.parentElement !== quote)
          branch = branch.parentElement;
        liftFromParent(branch, quote);
      }
    } else if (action === "blockCode") replaceTag(item, "pre");
    else if (action === "bulletList" || action === "numberList" || action === "dashList") {
      const existing = item.closest("ul,ol");
      const list =
        existing instanceof HTMLElement
          ? replaceTag(existing, action === "numberList" ? "ol" : "ul")
          : copy.ownerDocument.createElement(action === "numberList" ? "ol" : "ul");
      if (!existing) {
        item.before(list);
        item = replaceTag(item, "li");
        list.append(item);
      }
      list.setAttribute(
        "type",
        action === "dashList" ? "dash" : action === "numberList" ? "1" : "disc",
      );
    } else if (action === "indentList") {
      const li = item.closest("li");
      const previous = li?.previousElementSibling;
      if (li && previous && li.parentElement) {
        const nested = copy.ownerDocument.createElement(li.parentElement.tagName.toLowerCase());
        const type = li.parentElement.getAttribute("type");
        if (type) nested.setAttribute("type", type);
        previous.append(nested);
        nested.append(li);
      }
    } else if (action === "outdentList") {
      const li = item.closest("li");
      const list = li?.parentElement;
      const outer = list?.parentElement;
      if (li && outer?.tagName === "LI") {
        outer.after(li);
        if (!list?.childNodes.length) list?.remove();
      } else if (li && list) {
        liftFromParent(replaceTag(li, "div"), list);
      }
    }
  }
  if (
    ["clearFormatting", "pasteStyle", "inlineCode", "superscript", "subscript"].includes(action)
  ) {
    const selected = root.ownerDocument.createRange();
    if (range && !range.collapsed) {
      selected.setStart(target, range.startOffset);
      selected.setEnd(endTarget, range.endOffset);
    } else selected.selectNodeContents(block);
    const contents = selected.extractContents();
    const wrapper = copy.ownerDocument.createElement(
      action === "inlineCode"
        ? "code"
        : action === "superscript"
          ? "sup"
          : action === "subscript"
            ? "sub"
            : "span",
    );
    if (action === "clearFormatting") {
      for (const node of Array.from(
        contents.querySelectorAll("span,b,strong,i,em,u,s,strike,sub,sup,code,a"),
      ))
        node.replaceWith(...node.childNodes);
      for (const node of contents.querySelectorAll("[style],[dir]")) {
        node.removeAttribute("style");
        node.removeAttribute("dir");
      }
      wrapper.append(contents);
      if (!range || range.collapsed) {
        block.removeAttribute("style");
        block.removeAttribute("dir");
      }
    } else {
      if (action === "pasteStyle") {
        for (const node of Array.from(
          contents.querySelectorAll("span,b,strong,i,em,u,s,strike,sub,sup,code"),
        ))
          node.replaceWith(...node.childNodes);
        for (const node of contents.querySelectorAll("[style]")) node.removeAttribute("style");
      }
      wrapper.append(contents);
      if (action === "pasteStyle") {
        wrapper.setAttribute("style", composeStyle(copied));
        for (const [token, tag] of [
          ["__bold", "strong"],
          ["__italic", "em"],
          ["__sub", "sub"],
          ["__sup", "sup"],
          ["__code", "code"],
        ]) {
          if (!copied.split(";").includes(token ?? "")) continue;
          const mark = copy.ownerDocument.createElement(tag ?? "span");
          while (wrapper.firstChild) mark.append(wrapper.firstChild);
          wrapper.append(mark);
        }
      }
    }
    selected.insertNode(wrapper);
    // Split inherited inline marks around the selection, keeping unselected text styled.
    if (action === "clearFormatting" || action === "pasteStyle") {
      let parent = wrapper.parentElement;
      while (
        parent &&
        parent !== block &&
        parent !== copy &&
        parent.matches("span,b,strong,i,em,u,s,strike,sub,sup,code,a")
      ) {
        liftFromParent(wrapper, parent);
        parent = wrapper.parentElement;
      }
    }
    if (
      action === "clearFormatting" &&
      (!range || range.collapsed || wrapper.textContent === block.textContent)
    ) {
      block.removeAttribute("style");
      block.removeAttribute("dir");
      const list = block.parentElement;
      let cleared = block;
      if (block.tagName === "LI" && list?.matches("ul,ol")) {
        cleared = replaceTag(block, "div");
        liftFromParent(cleared, list);
      } else if (block.tagName === "PRE") cleared = replaceTag(block, "div");
      let quote = cleared.closest("blockquote");
      while (quote instanceof HTMLElement && copy.contains(quote)) {
        let branch = cleared;
        while (branch.parentElement && branch.parentElement !== quote)
          branch = branch.parentElement;
        liftFromParent(branch, quote);
        quote = cleared.closest("blockquote");
      }
    }
  }
  // Adjacent selected paragraphs form one list.
  for (const list of Array.from(copy.querySelectorAll("ul,ol"))) {
    const previous = list.previousElementSibling;
    if (
      previous?.tagName === list.tagName &&
      previous.getAttribute("type") === list.getAttribute("type")
    ) {
      while (list.firstChild) previous.append(list.firstChild);
      list.remove();
    }
  }
  const all = root.ownerDocument.createRange();
  all.selectNodeContents(root);
  restoreEditorSelection(root, all);
  document.execCommand("insertHTML", false, richComposeBody(composeEditorHtml(copy)).html);
  if (caret) restoreFormatSelection(root, caret.start, caret.end);
  return copied;
}
export function styleEditor(
  root: HTMLElement,
  saved: Range | null,
  property: string,
  value: string,
): void {
  restoreEditorSelection(root, saved);
  const range = window.getSelection()?.rangeCount ? window.getSelection()?.getRangeAt(0) : null;
  if (!range) return;
  const caret = {
    start: editorCaretOffset(root, range),
    end: editorCaretOffset(root, range, "end"),
  };
  if (range.collapsed) range.selectNodeContents(paragraph(root, range.startContainer));
  const wrapper = document.createElement("span");
  wrapper.setAttribute("style", composeStyle(`${property}:${value}`));
  wrapper.append(range.cloneContents());
  for (const node of wrapper.querySelectorAll("[style]")) {
    const remaining = composeStyle(node.getAttribute("style") ?? "")
      .split(";")
      .filter((declaration) => !declaration.startsWith(`${property}:`))
      .join(";");
    if (remaining) node.setAttribute("style", remaining);
    else node.removeAttribute("style");
  }
  document.execCommand("insertHTML", false, richComposeBody(wrapper.outerHTML).html);
  restoreFormatSelection(root, caret.start, caret.end);
}
export function replaceMarkdownEditor(
  root: HTMLElement,
  range: Range,
  replacement: ComposeReplacement,
): void {
  const selected = range.cloneRange();
  selected.setStart(range.startContainer, replacement.start);
  selected.setEnd(range.startContainer, replacement.end);
  if ("tag" in replacement) {
    const wrapper = document.createElement(replacement.tag);
    wrapper.textContent = replacement.text;
    restoreEditorSelection(root, selected);
    document.execCommand("insertHTML", false, richComposeBody(wrapper.outerHTML).html);
  } else {
    restoreEditorSelection(root, selected);
    document.execCommand("delete", false);
    if (replacement.block === "ul" || replacement.block === "ol") {
      document.execCommand(
        replacement.block === "ul" ? "insertUnorderedList" : "insertOrderedList",
        false,
      );
      const node = window.getSelection()?.anchorNode;
      const list = node?.parentElement?.closest("ul,ol");
      if (list)
        list.setAttribute(
          "type",
          replacement.dashed ? "dash" : replacement.block === "ul" ? "disc" : "1",
        );
    } else document.execCommand("formatBlock", false, replacement.block);
  }
}
export function restoreFormatSelection(root: HTMLElement, start: number, end: number): void {
  const points = editorMatchPoints(root, start, end);
  if (!points) return;
  const range = document.createRange();
  range.setStart(points.first.node, points.first.offset);
  range.setEnd(points.last.node, points.last.offset);
  if (start === end) range.collapse(true);
  restoreEditorSelection(root, range);
}

export function stepEditorFontSize(
  root: HTMLElement,
  saved: Range | null,
  direction: 1 | -1,
): void {
  restoreEditorSelection(root, saved);
  const selection = window.getSelection();
  if (!selection?.rangeCount) return;
  const node = selection.getRangeAt(0).startContainer;
  const element = node instanceof HTMLElement ? node : node.parentElement;
  if (!element || !root.contains(element)) return;
  const size = Number.parseFloat(window.getComputedStyle(element).fontSize) || 14;
  const sizes = direction === 1 ? COMPOSE_FONT_SIZES : COMPOSE_FONT_SIZES.toReversed();
  const next = sizes.find((value) => (direction === 1 ? value > size : value < size));
  if (next !== undefined) styleEditor(root, saved, "font-size", `${next}px`);
}

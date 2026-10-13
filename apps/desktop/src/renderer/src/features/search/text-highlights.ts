import { constVoid } from "effect/Function";

/**
 * Search and find hits drawn with the CSS Custom Highlight API. A highlight
 * paints ranges over existing text: no element, class or attribute enters the
 * mail's document, so the mail's CSS (`:has()`, attribute selectors, counters)
 * cannot react to what the reader searched for.
 *
 * Each document has one registry. Messages shown in the app's own document
 * (plain-text bodies) share it, so each caller adds and removes only its own ranges.
 */

/** Highlight names, styled by `HIGHLIGHT_CSS`. */
export const HIGHLIGHTS = {
  searchHit: "openmail-search-hit",
  searchActive: "openmail-search-active",
  findHit: "openmail-find-hit",
  findActive: "openmail-find-active",
} as const;
type HighlightName = (typeof HIGHLIGHTS)[keyof typeof HIGHLIGHTS];

const HIT = "#fef08a";
const ACTIVE = "#fb923c";

/** The highlight colors, for the mail frame's style sheet and the app's. */
export const HIGHLIGHT_CSS = Object.values(HIGHLIGHTS)
  .map(
    (name) =>
      `::highlight(${name}){background-color:${name.endsWith("active") ? ACTIVE : HIT} !important;color:#111 !important}`,
  )
  .join("");

const PRIORITY: Record<HighlightName, number> = {
  [HIGHLIGHTS.searchHit]: 0,
  [HIGHLIGHTS.findHit]: 1,
  [HIGHLIGHTS.searchActive]: 2,
  [HIGHLIGHTS.findActive]: 3,
};

/** The document's highlight of `name`, created on first use; undefined without the API. */
function highlight(doc: Document, name: HighlightName): Highlight | undefined {
  const view = doc.defaultView;
  // jsdom and older engines have no registry; hits then still count and scroll.
  const css: Partial<typeof CSS> | undefined = view?.CSS;
  const registry = css?.highlights;
  if (!view || !registry || typeof view.Highlight !== "function") return undefined;
  let existing = registry.get(name);
  if (!existing) {
    existing = new view.Highlight();
    existing.priority = PRIORITY[name];
    registry.set(name, existing);
  }
  return existing;
}

/** Paints `ranges` under `name` until the returned function removes them. */
export function paintRanges(
  doc: Document,
  name: HighlightName,
  ranges: readonly Range[],
): () => void {
  const target = highlight(doc, name);
  if (!target || !ranges.length) return constVoid;
  for (const range of ranges) target.add(range);
  return () => {
    for (const range of ranges) target.delete(range);
  };
}

const scrolls = (overflow: string) => overflow !== "visible" && overflow !== "clip";

const SKIPPED = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "SELECT"]);

/** Text nodes under `root` that show text: not in script, style, template or form fields. */
export function textNodes(root: Element): Text[] {
  const view = root.ownerDocument.defaultView;
  if (!view) return [];
  const nodes: Text[] = [];
  // Iterative: hostile mail can nest deeply.
  const stack: Node[] = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node) break;
    if (node instanceof view.Text) nodes.push(node);
    else if (!(node instanceof view.Element) || !SKIPPED.has(node.tagName.toUpperCase()))
      for (let child = node.lastChild; child; child = child.previousSibling) stack.push(child);
  }
  return nodes;
}

const elementOf = (node: Node): Element | null => {
  const view = node.ownerDocument?.defaultView;
  return view && node instanceof view.Element ? node : node.parentElement;
};

/** Whether a hit shows: not inside a collapsed quote or other hidden content. */
export function rangeVisible(range: Range): boolean {
  const element = elementOf(range.startContainer);
  if (!element || element.closest("[hidden]")) return false;
  return typeof element.checkVisibility !== "function" || element.checkVisibility();
}

/**
 * Scrolls every box that holds the range so its middle is centered vertically
 * and it is in view horizontally, through same-origin frames, as
 * `scrollIntoView({ block: "center" })` does for an element.
 */
export function scrollRangeIntoView(range: Range): void {
  if (typeof range.getBoundingClientRect !== "function") return;
  const rect = range.getBoundingClientRect();
  let { top, bottom, left, right } = rect;
  let element = elementOf(range.startContainer);
  while (element) {
    const doc = element.ownerDocument;
    const view = doc.defaultView;
    if (!view) return;
    for (let node: Element | null = element; node; node = node.parentElement) {
      const root = node === (doc.scrollingElement ?? doc.documentElement);
      let box: { top: number; bottom: number; left: number; right: number };
      if (root) box = { top: 0, bottom: view.innerHeight, left: 0, right: view.innerWidth };
      else {
        const style = view.getComputedStyle(node);
        if (
          !(scrolls(style.overflowY) && node.scrollHeight > node.clientHeight) &&
          !(scrolls(style.overflowX) && node.scrollWidth > node.clientWidth)
        )
          continue;
        const outer = node.getBoundingClientRect();
        box = {
          top: outer.top + node.clientTop,
          bottom: outer.top + node.clientTop + node.clientHeight,
          left: outer.left + node.clientLeft,
          right: outer.left + node.clientLeft + node.clientWidth,
        };
      }
      const y = (top + bottom) / 2 - (box.top + box.bottom) / 2;
      const x =
        left < box.left
          ? left - box.left
          : right > box.right
            ? Math.min(right - box.right, left - box.left)
            : 0;
      const [beforeTop, beforeLeft] = [node.scrollTop, node.scrollLeft];
      if (y) node.scrollTop = beforeTop + y;
      if (x) node.scrollLeft = beforeLeft + x;
      const movedY = node.scrollTop - beforeTop;
      const movedX = node.scrollLeft - beforeLeft;
      top -= movedY;
      bottom -= movedY;
      left -= movedX;
      right -= movedX;
    }
    // Into the document that shows this frame.
    const frame = view.frameElement;
    if (!frame) return;
    const outer = frame.getBoundingClientRect();
    top += outer.top + frame.clientTop;
    bottom += outer.top + frame.clientTop;
    left += outer.left + frame.clientLeft;
    right += outer.left + frame.clientLeft;
    element = frame.parentElement;
  }
}

import { constVoid } from "effect/Function";
import { repeatedQuote, type QuoteHistory } from "@openmail/core/schema";
import { HIGHLIGHTS, paintRanges, scrollRangeIntoView } from "../../search";

/** Visit each container once, skipping descendants of a repeated parent. */
export function repeatedQuoteElements(root: HTMLElement, previous: QuoteHistory): HTMLElement[] {
  const quotes: HTMLElement[] = [];
  const view = root.ownerDocument.defaultView;
  if (!view || !previous.before) return quotes;
  const visit = (parent: HTMLElement) => {
    let marker: HTMLElement | null = null;
    let tailCount = 0;
    let allRepeated = true;
    for (const element of parent.children) {
      if (!(element instanceof view.HTMLElement)) continue;
      if (element.id === "divRplyFwdMsg") {
        if (marker && tailCount && allRepeated) quotes.push(marker);
        marker = element;
        tailCount = 0;
        allRepeated = true;
        continue;
      }
      const candidate = marker !== null || element.matches("blockquote,.gmail_quote,.yahoo_quoted");
      const repeated = candidate && repeatedQuote(element.textContent, previous);
      if (marker) {
        tailCount++;
        allRepeated &&= repeated;
      }
      if (repeated) quotes.push(element);
      else visit(element);
    }
    if (marker && tailCount && allRepeated) quotes.push(marker);
  };
  visit(root);
  return quotes;
}

/** Toggle repeats while restoring every sender-owned attribute on cleanup. Find exposes quotes temporarily. */
export function presentBody(
  root: HTMLElement,
  quotes: readonly HTMLElement[],
  expanded: boolean,
  query: string,
) {
  const attributes = quotes.map((quote) => ({
    hidden: quote.getAttribute("hidden"),
    style: quote.getAttribute("style"),
  }));
  if (!expanded && !query)
    for (const quote of quotes) {
      quote.setAttribute("hidden", "");
      quote.style.setProperty("display", "none", "important");
    }
  const highlights = highlightBody(root, query);
  return {
    ...highlights,
    hasQuotes: quotes.length > 0,
    dispose() {
      highlights.dispose();
      for (const [index, quote] of quotes.entries()) {
        const original = attributes[index];
        if (!original) continue;
        for (const key of ["hidden", "style"] as const) {
          const value = original[key];
          if (value === null) quote.removeAttribute(key);
          else quote.setAttribute(key, value);
        }
      }
    },
  };
}

interface TextPart {
  node: Text;
  start: number;
  end: number;
}
const BLOCK = new Set([
  "DIV",
  "P",
  "PRE",
  "LI",
  "TR",
  "TD",
  "TH",
  "BLOCKQUOTE",
  "BR",
  "H1",
  "H2",
  "H3",
]);

/**
 * Find in message. Matches span inline nodes, but never scripts, hidden
 * quotes, fields or paragraph boundaries. They are drawn as highlights, so the
 * mail's document and its CSS never see what was typed.
 */
export function highlightBody(root: HTMLElement, query: string) {
  const none: Range[] = [];
  if (!query)
    return { count: 0, ranges: none, select: (_index: number) => constVoid(), dispose: constVoid };
  const document = root.ownerDocument;
  const view = document.defaultView;
  const parts: TextPart[] = [];
  let text = "";
  const visit = (node: Node) => {
    if (node.nodeType === 3) {
      const value = node.textContent ?? "";
      // createTreeWalker is not needed; nodeType narrows at this DOM boundary.
      if (view !== null && node instanceof view.Text) {
        parts.push({ node, start: text.length, end: text.length + value.length });
        text += value;
      }
      return;
    }
    if (node.nodeType !== 1) return;
    if (!(view !== null && node instanceof view.Element)) return;
    if (
      node.matches(
        'script,style,noscript,template,input,textarea,select,[hidden],[aria-hidden="true"]',
      )
    )
      return;
    const style = typeof view.getComputedStyle === "function" ? view.getComputedStyle(node) : null;
    if (style?.display === "none" || style?.visibility === "hidden") return;
    const block = BLOCK.has(node.tagName);
    if (block) text += "\n";
    for (const child of node.childNodes) visit(child);
    if (block) text += "\n";
  };
  visit(root);
  // Escape the literal query. RegExp /i preserves original string offsets for Unicode case folding.
  const literal = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Matches come in order, so one cursor walks the text nodes once.
  let cursor = 0;
  const position = (offset: number, end: boolean) => {
    // The text node holding `offset`; an end offset belongs to the node it closes.
    while (cursor < parts.length && (parts[cursor]?.end ?? 0) < offset + (end ? 0 : 1)) cursor++;
    const part = parts[cursor];
    return part && part.start <= offset - (end ? 1 : 0)
      ? ([part.node, offset - part.start] as const)
      : undefined;
  };
  const matches: Range[] = [];
  for (const match of text.matchAll(new RegExp(literal, "gi"))) {
    const from = position(match.index, false);
    const to = from && position(match.index + match[0].length, true);
    if (!from || !to) continue;
    const range = document.createRange();
    range.setStart(...from);
    range.setEnd(...to);
    matches.push(range);
  }
  const clearHits = paintRanges(document, HIGHLIGHTS.findHit, matches);
  let clearActive = constVoid;
  return {
    count: matches.length,
    ranges: matches,
    select(index: number) {
      clearActive();
      const active = matches[index];
      clearActive = paintRanges(document, HIGHLIGHTS.findActive, active ? [active] : []);
      if (active) scrollRangeIntoView(active);
    },
    dispose() {
      clearActive();
      clearHits();
    },
  };
}

import { constVoid } from "effect/Function";
import { repeatedQuote, type QuoteHistory } from "@openmail/core/schema";

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

/** Matches span inline nodes, but never scripts, hidden quotes, fields or paragraph boundaries. */
export function highlightBody(root: HTMLElement, query: string) {
  if (!query) return { count: 0, select: (_index: number) => constVoid(), dispose: constVoid };
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
  const matches: { start: number; end: number; marks: HTMLElement[] }[] = [];
  // Escape the literal query. RegExp /i preserves original string offsets for Unicode case folding.
  if (query) {
    const literal = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const match of text.matchAll(new RegExp(literal, "gi")))
      matches.push({ start: match.index, end: match.index + match[0].length, marks: [] });
  }
  for (const part of parts) {
    const overlaps = matches.filter((match) => match.start < part.end && match.end > part.start);
    if (!overlaps.length) continue;
    const fragment = document.createDocumentFragment();
    const value = part.node.data;
    let position = 0;
    for (const match of overlaps) {
      const start = Math.max(0, match.start - part.start);
      const end = Math.min(value.length, match.end - part.start);
      fragment.append(document.createTextNode(value.slice(position, start)));
      const mark = document.createElement("mark");
      mark.textContent = value.slice(start, end);
      mark.style.setProperty("background", "#fef08a", "important");
      mark.style.setProperty("color", "#111", "important");
      fragment.append(mark);
      match.marks.push(mark);
      position = end;
    }
    fragment.append(document.createTextNode(value.slice(position)));
    part.node.replaceWith(fragment);
  }
  return {
    count: matches.length,
    select(index: number) {
      for (const [i, match] of matches.entries())
        for (const mark of match.marks)
          mark.style.setProperty("background", i === index ? "#fb923c" : "#fef08a", "important");
      const active = matches[index]?.marks[0];
      if (typeof active?.scrollIntoView === "function") active.scrollIntoView({ block: "center" });
    },
    dispose() {
      for (const match of matches)
        for (const mark of match.marks) mark.replaceWith(document.createTextNode(mark.textContent));
      root.normalize();
    },
  };
}

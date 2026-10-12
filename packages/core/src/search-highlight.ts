import { DomUtils, ElementType, parseDocument } from "htmlparser2";
import { searchTermRanges, type SearchRange } from "./search-snippets.js";
import { wordTokens } from "./search.js";

/** The reader styles and counts only marks with this class. Sender markup cannot claim it. */
export const SEARCH_HIT_CLASS = "openmail-search-hit";
/** Bounds the work on a huge message; later hits stay unmarked. */
const MAX_HITS = 500;
/** Cloned per hit; no hand-built element constructors. */
const TEMPLATE = parseDocument(`<mark class="${SEARCH_HIT_CLASS}">.</mark>`).children[0];

type Document = ReturnType<typeof parseDocument>;
type Node = Document["children"][number];
type TextNode = Extract<Node, { type: typeof ElementType.Text }>;

const wordHits = (text: string, terms: readonly string[]) =>
  searchTermRanges(text, terms).slice(0, MAX_HITS);
/**
 * A word the tokenizer cannot find (the index may still use trigrams) falls
 * back to literal text when it has at least three characters, as trigrams do.
 */
const literalHits = (text: string, terms: readonly string[]) => {
  const literal = terms.filter((term) => wordTokens(term).join("").length >= 3);
  return literal.length ? searchTermRanges(text, literal, "substring").slice(0, MAX_HITS) : [];
};

/** Search hits in a plain-text body, with the same fallback as `markSearchHits`. */
export function plainSearchHits(text: string, terms: readonly string[]): SearchRange[] {
  const words = wordHits(text, terms);
  return words.length ? words : literalHits(text, terms);
}

/**
 * Wraps search hits in text nodes of a sanitized reader document with
 * `<mark class="openmail-search-hit">`. Attributes, URLs and styles are never
 * touched and the serializer escapes all text, so a query cannot add markup.
 * Matches do not span element boundaries. Returns the number of marks.
 */
export function markSearchHits(document: Document, terms: readonly string[]): number {
  if (!terms.length) return 0;
  // A sender's own copy of the class would add fake hits to the count and navigation.
  for (const element of DomUtils.findAll(
    (candidate) => candidate.attribs.class?.includes(SEARCH_HIT_CLASS) ?? false,
    document.children,
  ))
    element.attribs.class = (element.attribs.class ?? "")
      .split(/\s+/)
      .filter((name) => name !== SEARCH_HIT_CLASS)
      .join(" ");
  let hits = findHits(document, (text) => wordHits(text, terms));
  if (!hits.length) hits = findHits(document, (text) => literalHits(text, terms));
  let count = 0;
  for (const { node, siblings, ranges } of hits) {
    const value = node.data;
    const parts: Node[] = [];
    let position = 0;
    const text = (data: string) => {
      const copy = node.cloneNode();
      copy.data = data;
      parts.push(copy);
    };
    for (const { start, end } of ranges) {
      if (start > position) text(value.slice(position, start));
      const mark = TEMPLATE?.cloneNode(true);
      const inner = mark?.type === ElementType.Tag ? mark.children[0] : undefined;
      if (!mark || inner?.type !== ElementType.Text) break;
      inner.data = value.slice(start, end);
      parts.push(mark);
      position = end;
    }
    if (position < value.length) text(value.slice(position));
    siblings.splice(siblings.indexOf(node), 1, ...parts);
    count += ranges.length;
  }
  return count;
}

type Hit = { node: TextNode; siblings: Node[]; ranges: SearchRange[] };
/**
 * The sanitizer moves children between arrays without updating parent links,
 * so each text node keeps the array that serializes it.
 */
function findHits(document: Document, find: (text: string) => SearchRange[]): Hit[] {
  const hits: Hit[] = [];
  // Iterative, in document order: hostile mail can nest deeply.
  const stack: { node: Node; siblings: Node[] }[] = document.children
    .map((node) => ({ node, siblings: document.children }))
    .toReversed();
  let count = 0;
  while (count < MAX_HITS) {
    const entry = stack.pop();
    if (!entry) break;
    const { node, siblings } = entry;
    if (node.type === ElementType.Text) {
      const ranges = find(node.data).slice(0, MAX_HITS - count);
      if (ranges.length) hits.push({ node, siblings, ranges });
      count += ranges.length;
    } else if ("children" in node && !("name" in node && node.name === "style")) {
      const children = node.children;
      stack.push(...children.map((child) => ({ node: child, siblings: children })).toReversed());
    }
  }
  return hits;
}

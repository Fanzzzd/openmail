import { searchTermRanges, type SearchRange } from "./search-snippets.js";
import { wordTokens } from "./fts.js";

/** Bounds the work on a huge message; later hits stay unmarked. */
const MAX_HITS = 500;

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

/** A hit inside `texts[node]`, in UTF-16 offsets. */
export interface TextSearchHit extends SearchRange {
  node: number;
}

/**
 * Search hits in a message's text nodes, in document order. Matches do not
 * span nodes. Words come first; literal text only when no word matches in any
 * node. The reader draws the hits as highlights over the text, so nothing is
 * added to the mail's document and its CSS cannot tell what was searched.
 */
export function textSearchHits(
  texts: readonly string[],
  terms: readonly string[],
): TextSearchHit[] {
  if (!terms.length) return [];
  const find = (match: (text: string) => SearchRange[]) => {
    const hits: TextSearchHit[] = [];
    for (const [node, text] of texts.entries()) {
      if (hits.length >= MAX_HITS) break;
      for (const range of match(text).slice(0, MAX_HITS - hits.length))
        hits.push({ node, ...range });
    }
    return hits;
  };
  const words = find((text) => wordHits(text, terms));
  return words.length ? words : find((text) => literalHits(text, terms));
}

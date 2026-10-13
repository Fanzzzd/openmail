import type { SearchCriteria, ThreadQuery } from "./domain/domain.js";
import {
  parseSearchExpression,
  parseSearchQuery,
  type SearchExpression,
  searchWords,
  unquoteSearchValue,
  usesSubstringSearch,
  wordTokens,
} from "./search.js";

/** Only positive text terms contribute highlights; operators and exclusions do not. */
export function searchHighlightTerms(query: ThreadQuery): string[] {
  const terms: string[] = [];
  const pushCriteria = (criteria: SearchCriteria | undefined) => {
    if (criteria?.subject) terms.push(criteria.subject);
    if (criteria?.proximity) terms.push(criteria.proximity.left, criteria.proximity.right);
  };
  const visit = (node: SearchExpression): void => {
    if (node.kind === "not") return;
    if (node.kind !== "term") {
      for (const child of node.children) visit(child);
      return;
    }
    const parsed = parseSearchQuery({ search: node.value });
    terms.push(...searchWords(parsed.search ?? ""));
    pushCriteria(parsed.criteria);
  };
  visit(parseSearchExpression(query.search ?? ""));
  pushCriteria(query.criteria);
  return [...new Set(terms)].filter((term) => wordTokens(term).length > 0);
}

const normalized = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export type SearchRange = { start: number; end: number };

/**
 * UTF-16 ranges of the positive terms in `text`, sorted and merged. Words
 * compare without case or diacritics; CJK and other non-word terms match as
 * literal substrings.
 */
export function searchTermRanges(
  text: string,
  terms: readonly string[],
  mode: "words" | "substring" = "words",
): SearchRange[] {
  // Tokens are normalized once and shared by every term: a 1 MB body has ~150k.
  let tokens: { index: number; end: number; word: string }[] | undefined;
  const ranges: SearchRange[] = [];
  for (const term of terms) {
    const prefix = term.endsWith("*");
    const literal = unquoteSearchValue(prefix ? term.slice(0, -1) : term).replace(/\s+/g, " ");
    if (mode === "substring" || usesSubstringSearch(literal)) {
      if (!literal) continue;
      const pattern = new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
      for (const match of text.matchAll(pattern))
        ranges.push({ start: match.index, end: match.index + match[0].length });
      continue;
    }
    const words = wordTokens(literal);
    const [first] = words;
    if (first === undefined) continue;
    tokens ??= Array.from(text.matchAll(/[\p{L}\p{N}\p{M}]+/gu), (match) => ({
      index: match.index,
      end: match.index + match[0].length,
      word: normalized(match[0]),
    }));
    const last = words.length - 1;
    const fits = (offset: number, candidate: string) =>
      prefix && offset === last
        ? candidate.startsWith(words[offset] ?? "")
        : candidate === words[offset];
    for (let index = 0; index + last < tokens.length; index++) {
      if (!fits(0, tokens[index]?.word ?? "")) continue;
      let offset = 1;
      while (offset <= last && fits(offset, tokens[index + offset]?.word ?? "")) offset++;
      const start = tokens[index]?.index;
      const end = tokens[index + last]?.end;
      if (offset > last && start !== undefined && end !== undefined) ranges.push({ start, end });
    }
  }
  return mergeSearchRanges(ranges);
}

/** Sorted ranges with overlapping and touching ones joined. */
export function mergeSearchRanges(ranges: readonly SearchRange[]): SearchRange[] {
  const merged: SearchRange[] = [];
  for (const range of ranges.toSorted((a, b) => a.start - b.start || b.end - a.end)) {
    const last = merged.at(-1);
    if (last && last.end >= range.start) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/** Plain strings only. The same ranges drive React marks and structured tool output. */
export function searchSnippet(
  text: string,
  terms: readonly string[],
  mode: "words" | "substring" = "words",
) {
  const visible = text.replace(/\s+/g, " ").trim();
  const merged = searchTermRanges(visible, terms, mode);
  const insideSurrogatePair = (offset: number) =>
    offset > 0 &&
    offset < visible.length &&
    /[\uD800-\uDBFF]/.test(visible[offset - 1] ?? "") &&
    /[\uDC00-\uDFFF]/.test(visible[offset] ?? "");
  const windowStart = Math.max(0, (merged[0]?.start ?? 0) - 60);
  const start = insideSurrogatePair(windowStart) ? windowStart - 1 : windowStart;
  const windowEnd = Math.min(visible.length, Math.max(start + 240, merged[0]?.end ?? 0));
  const end = insideSurrogatePair(windowEnd) ? windowEnd + 1 : windowEnd;
  const leading = start > 0 ? "…" : "";
  return {
    snippet: leading + visible.slice(start, end) + (end < visible.length ? "…" : ""),
    highlights: merged
      .filter((range) => range.start >= start && range.end <= end)
      .map((range) => ({
        start: range.start - start + leading.length,
        end: range.end - start + leading.length,
      })),
  };
}

/** A contiguous multiword query is a stronger attachment signal than scattered words. */
export function exactSearchPhrase(text: string, terms: readonly string[]): boolean {
  const words = terms.map((term) => unquoteSearchValue(term)).join(" ");
  return wordTokens(words).length > 1 && searchSnippet(text, [words]).highlights.length > 0;
}

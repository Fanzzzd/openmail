/** Word tokens and FTS terms shared by the SQLite index and local matching. */

import { contains, unquoteSearchValue } from "./search-tokens.js";
import type { SearchCondition } from "../domain/message.js";

/** Only a trailing, explicit star enables FTS prefix matching; all syntax is quoted. */
export function ftsSearchTerm(value: string): string | null {
  const prefix = value.endsWith("*");
  const text = unquoteSearchValue(prefix ? value.slice(0, -1) : value);
  if (!/[\p{L}\p{N}]/u.test(text)) return null;
  return `"${text.replaceAll('"', '""')}"${prefix ? "*" : ""}`;
}
export const wordTokens = (text: string): string[] =>
  text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
export function wholeWordMatch(text: string, value: string): boolean {
  const literal = unquoteSearchValue(value.endsWith("*") ? value.slice(0, -1) : value);
  if (ftsSearchTerm(value) === null) return true;
  if (usesSubstringSearch(literal)) return contains(text, literal);
  const haystack = wordTokens(text);
  const prefix = value.endsWith("*");
  const needle = wordTokens(unquoteSearchValue(prefix ? value.slice(0, -1) : value));
  return (
    needle.length > 0 &&
    haystack.some((_, start) =>
      needle.every((word, offset) => {
        const candidate = haystack[start + offset];
        return prefix && offset === needle.length - 1
          ? candidate?.startsWith(word)
          : candidate === word;
      }),
    )
  );
}
/** Scripts normally written without spaces retain the existing substring search. */
export const usesSubstringSearch = (text: string): boolean =>
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}\p{Script=Bopomofo}]/u.test(
    text,
  );

export function proximityMatch(
  text: string,
  proximity: NonNullable<SearchCondition["proximity"]>,
): boolean {
  const words = wordTokens(text);
  const left = wordTokens(proximity.left),
    right = wordTokens(proximity.right);
  if (!left.length || !right.length) return false;
  const positions = (phrase: string[]) =>
    words.flatMap((_, i) => (phrase.every((word, j) => words[i + j] === word) ? [i] : []));
  return positions(left).some((a) =>
    positions(right).some((b) =>
      b >= a + left.length
        ? b - a - left.length <= proximity.distance
        : !proximity.ordered && a >= b + right.length && a - b - right.length <= proximity.distance,
    ),
  );
}

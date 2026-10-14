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
/**
 * The combining marks SQLite's unicode61 treats as diacritics
 * (sqlite3Fts5UnicodeIsdiacritic). Inside a token they are dropped; every other
 * mark, such as a Devanagari vowel sign or an Arabic harakah, separates tokens.
 */
const DIACRITICS = new Set([
  0x300, 0x301, 0x302, 0x303, 0x304, 0x306, 0x307, 0x308, 0x309, 0x30a, 0x30b, 0x30c, 0x30f, 0x311,
  0x31b, 0x323, 0x324, 0x325, 0x326, 0x327, 0x328, 0x32d, 0x32e, 0x330, 0x331,
]);
// unicode61's default token characters. Its Unicode tables are older than V8's,
// so code points it sees as unassigned are token characters too.
const TOKEN_CHAR = /[\p{L}\p{N}\p{Co}\p{Cn}]/u;
const LATIN = /\p{Script=Latin}/u;
const folded = new Map<string, string>();

/** unicode61 with remove_diacritics=1: simple case folding, then one diacritic off an ASCII letter. */
function foldTokenChar(char: string): string {
  const cached = folded.get(char);
  if (cached !== undefined) return cached;
  // Upper then lower approximates case folding (µ, ſ, ς, ϐ); ß and ı keep their form.
  const upper = char.toUpperCase();
  const lower =
    Array.from(upper).length === 1 && char !== "\u0131" ? upper.toLowerCase() : char.toLowerCase();
  let out = "";
  for (const c of lower) {
    if (DIACRITICS.has(c.codePointAt(0) ?? 0)) continue;
    const parts = Array.from(c.normalize("NFD"));
    out +=
      LATIN.test(c) &&
      parts.length === 2 &&
      /^[a-z]$/u.test(parts[0] ?? "") &&
      DIACRITICS.has(parts[1]?.codePointAt(0) ?? 0)
        ? parts[0]
        : c;
  }
  folded.set(char, out);
  return out;
}

/** Splits text into the tokens the messages_words and derived_words indexes store. */
export function wordTokens(text: string): string[] {
  const tokens: string[] = [];
  let token = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80 ? /[A-Za-z0-9]/u.test(char) : TOKEN_CHAR.test(char))
      token += code < 0x80 ? char.toLowerCase() : foldTokenChar(char);
    else if (token && DIACRITICS.has(code)) continue;
    else if (token) {
      tokens.push(token);
      token = "";
    }
  }
  if (token) tokens.push(token);
  return tokens;
}
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

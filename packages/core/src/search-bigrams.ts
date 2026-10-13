/**
 * Bigram index for one- and two-character searches in scripts written
 * without spaces (Chinese, Japanese, Korean, Thai, …). The trigram index
 * cannot answer a term shorter than three characters, so these terms used a
 * LIKE scan over every message.
 *
 * Each character of such a script becomes one token: the character and the
 * next one when that is also such a character, or the character alone at the
 * end of a run. `ab` is a substring exactly when the token `ab` exists, and
 * `a` is one exactly when a token starts with `a`, so a token match gives the
 * same rows as LIKE. The FTS table uses the `ascii` tokenizer, which keeps
 * every non-ASCII character as part of a token and folds none of them.
 */
const SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}\p{Script=Bopomofo}]/u;

const inScript = (char: string | undefined) => char !== undefined && SCRIPT.test(char);

/** The space-separated bigram tokens of `text`; empty when it has no such characters. */
export function bigramText(text: string | null | undefined): string {
  if (!text || !SCRIPT.test(text)) return "";
  const chars = Array.from(text);
  const tokens: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    if (!char || !inScript(char)) continue;
    const next = chars[i + 1];
    tokens.push(next !== undefined && inScript(next) ? char + next : char);
  }
  return tokens.join(" ");
}

/**
 * The FTS query for a one- or two-character literal made only of these
 * scripts, or undefined when the bigram index cannot answer it.
 */
export function bigramMatch(text: string): string | undefined {
  const chars = Array.from(text);
  if (chars.length < 1 || chars.length > 2 || !chars.every(inScript)) return undefined;
  return chars.length === 2 ? `"${text}"` : `"${text}" *`;
}

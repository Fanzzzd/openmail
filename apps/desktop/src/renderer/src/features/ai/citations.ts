/** Splitting AI text at its [message id] citations, so they render as numbered source links. */

export type CitedPart =
  | { readonly kind: "text"; readonly text: string }
  /** 1-based positions in the source list. */
  | { readonly kind: "cite"; readonly numbers: readonly number[] };

const BRACKET = /\[([^[\]\n]{1,600})\]/g;

/**
 * The text with each bracket that holds only known source ids, such as
 * "[gmail:me@example.com/m1]" or "[id1, id2]", replaced by those sources' numbers. A bracket
 * with anything else stays text, so ordinary brackets and invented ids show as written.
 */
export function citedParts(text: string, sources: readonly { readonly id: string }[]): CitedPart[] {
  const index = new Map(sources.map((source, i) => [source.id, i + 1]));
  const parts: CitedPart[] = [];
  const pushText = (value: string) => {
    if (!value) return;
    const last = parts.at(-1);
    if (last?.kind === "text") parts[parts.length - 1] = { kind: "text", text: last.text + value };
    else parts.push({ kind: "text", text: value });
  };
  let at = 0;
  for (const match of text.matchAll(BRACKET)) {
    const ids = (match[1] ?? "").split(/[,;\s]+/).filter(Boolean);
    const numbers = ids.map((id) => index.get(id));
    if (!ids.length || numbers.some((n) => n === undefined)) continue;
    pushText(text.slice(at, match.index));
    parts.push({ kind: "cite", numbers: numbers.filter((n) => n !== undefined) });
    at = match.index + match[0].length;
  }
  pushText(text.slice(at));
  return parts;
}

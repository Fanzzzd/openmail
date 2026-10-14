/** Splitting AI text at its [message id] citations, so they render as numbered source links. */

export type CitedPart =
  | { readonly kind: "text"; readonly text: string }
  /** 1-based positions in the source list. */
  | { readonly kind: "cite"; readonly numbers: readonly number[] };

const SEPARATOR = /[,;\s]/;

/**
 * The text with each bracket that holds only known source ids, such as
 * "[gmail:me@example.com/m1]" or "[id1, id2]", replaced by those sources' numbers. A bracket
 * with anything else stays text, so ordinary brackets and invented ids show as written.
 *
 * The scan matches the known ids themselves, longest first, so ids that contain spaces or
 * brackets, such as IMAP ids with the folder "Sent Items" or "[Gmail]/Sent Mail", still match.
 */
export function citedParts(text: string, sources: readonly { readonly id: string }[]): CitedPart[] {
  const index = new Map<string, number>();
  for (const [i, source] of sources.entries()) {
    if (source.id && !index.has(source.id)) index.set(source.id, i + 1);
  }
  const ids = [...index.keys()].toSorted((a, b) => b.length - a.length);
  const parts: CitedPart[] = [];
  const pushText = (value: string) => {
    if (!value) return;
    const last = parts.at(-1);
    if (last?.kind === "text") parts[parts.length - 1] = { kind: "text", text: last.text + value };
    else parts.push({ kind: "text", text: value });
  };

  /** The ids from `from` up to and including the closing "]", or undefined if anything else is there. */
  const idList = (from: number): { numbers: number[]; end: number } | undefined => {
    let start = from;
    while (start < text.length && /\s/.test(text[start]!)) start++;
    for (const id of ids) {
      if (!text.startsWith(id, start)) continue;
      const number = index.get(id)!;
      let after = start + id.length;
      while (after < text.length && /\s/.test(text[after]!)) after++;
      if (text[after] === "]") return { numbers: [number], end: after + 1 };
      let next = after;
      while (next < text.length && SEPARATOR.test(text[next]!)) next++;
      if (next === start + id.length) continue;
      const rest = idList(next);
      if (rest) return { numbers: [number, ...rest.numbers], end: rest.end };
    }
    return undefined;
  };

  let at = 0;
  let open = ids.length ? text.indexOf("[") : -1;
  while (open !== -1) {
    const cite = idList(open + 1);
    if (cite) {
      pushText(text.slice(at, open));
      parts.push({ kind: "cite", numbers: cite.numbers });
      at = cite.end;
    }
    open = text.indexOf("[", cite ? cite.end : open + 1);
  }
  pushText(text.slice(at));
  return parts;
}

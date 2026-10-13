/** Literal, case-insensitive matches. Offsets refer to the original UTF-16 text. */
export function composeMatches(text: string, query: string): { start: number; end: number }[] {
  if (!query) return [];
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  return [...text.matchAll(pattern)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

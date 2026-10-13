/** ~300 UTF-16 characters with the preceding sentence carried into the next block. */
export function textChunks(
  text: string,
  maxChunks = Number.POSITIVE_INFINITY,
): { text: string; start: number; end: number }[] {
  const chunks: { text: string; start: number; end: number }[] = [];
  let start = 0;
  while (start < text.length && chunks.length < maxChunks) {
    let end = Math.min(start + 300, text.length);
    if (end < text.length) {
      const tail = text.slice(start + 200, end).match(/[。！？.!?\n][\s\S]*$/);
      if (tail?.index !== undefined) end = start + 200 + tail.index + 1;
    }
    const value = text.slice(start, end);
    if (value.trim()) chunks.push({ text: value, start, end });
    if (end === text.length) break;
    const previous = [...value.matchAll(/[。！？.!?\n]/g)].at(-2);
    const overlap = previous ? start + previous.index + 1 : end - 50;
    start = Math.max(start + 1, overlap);
  }
  return chunks;
}

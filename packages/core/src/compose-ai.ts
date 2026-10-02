/** A single replacement span for a text-only AI preview. */
export function composeAiDiff(before: string, after: string) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = before.length;
  let nextEnd = after.length;
  while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) {
    end--;
    nextEnd--;
  }
  return {
    prefix: before.slice(0, start),
    removed: before.slice(start, end),
    added: after.slice(start, nextEnd),
    suffix: before.slice(end),
  };
}

export function composeAiReplacement(
  text: string,
  start: number,
  end: number,
  replacement: string,
) {
  return text.slice(0, start) + replacement + text.slice(end);
}

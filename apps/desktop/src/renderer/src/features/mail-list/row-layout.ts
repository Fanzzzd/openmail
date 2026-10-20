/**
 * Row geometry for the windowed message list. Rows differ in height only where a search shows
 * attachment or text hits under them, so every other row keeps the density's height.
 */
export interface RowLayout {
  /** offsets[i] is the top of row i; the last entry is the list's full height. */
  offsets: readonly number[];
}

export function rowLayout(heights: readonly number[]): RowLayout {
  const offsets = [0];
  for (const height of heights) offsets.push((offsets.at(-1) ?? 0) + height);
  return { offsets };
}

/** The row under a y coordinate: the last row whose top is at or above it. */
function rowAt(offsets: readonly number[], y: number): number {
  let low = 0;
  let high = offsets.length - 2;
  if (high < 0) return 0;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((offsets[middle] ?? 0) <= y) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** The rows to mount for a viewport, with six rows of overscan on each side. */
export function rowWindow(layout: RowLayout, scrollTop: number, height: number) {
  const { offsets } = layout;
  const count = offsets.length - 1;
  const total = offsets[count] ?? 0;
  if (count === 0) return { first: 0, end: 0, offset: 0, total };
  const first = Math.max(0, rowAt(offsets, scrollTop) - 6);
  const end = Math.min(count, rowAt(offsets, scrollTop + height) + 1 + 6);
  return { first, end, offset: offsets[first] ?? 0, total };
}

/**
 * The row Page Down or Page Up moves to from row `from`: the row one list height below or above
 * its top, and at least the next or previous row.
 */
export function pageRow(layout: RowLayout, from: number, height: number, direction: 1 | -1) {
  const { offsets } = layout;
  const last = offsets.length - 2;
  if (last < 0) return -1;
  const top = offsets[Math.max(0, Math.min(last, from))] ?? 0;
  const row = rowAt(offsets, top + direction * height);
  const index = direction > 0 ? Math.max(row, from + 1) : Math.min(row, from - 1);
  return Math.max(0, Math.min(last, index));
}

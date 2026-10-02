export function adjacentWindowId(
  ids: readonly number[],
  current: number | null,
  direction: 1 | -1,
): number | undefined {
  if (!ids.length) return undefined;
  const index = current === null ? -1 : ids.indexOf(current);
  return ids[index < 0 ? 0 : (index + direction + ids.length) % ids.length];
}

/** Fixed row geometry shared by the renderer and its large-list tests. */
export const MESSAGE_ROW_HEIGHT = 84;
export function listWindow(
  count: number,
  scrollTop: number,
  height: number,
  rowHeight = MESSAGE_ROW_HEIGHT,
) {
  const first = Math.max(0, Math.min(count, Math.floor(scrollTop / rowHeight) - 6));
  const end = Math.min(count, Math.ceil((scrollTop + height) / rowHeight) + 6);
  return { first, end, offset: first * rowHeight, total: count * rowHeight };
}

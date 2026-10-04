/** The actions menu button, like every icon button: 6 px padding around a 16 px icon. */
const MENU_BUTTON = 28;
/** The toolbar's gap between buttons. */
const GAP = 2;

/**
 * How many actions fit in `width` px beside the actions menu, by their
 * measured widths or, for one not shown yet, an icon button's. A toolbar not
 * measured yet (first paint, jsdom) shows them all.
 */
export function fittingCount(
  ordered: readonly string[],
  widths: Readonly<Record<string, number>>,
  width: number,
): number {
  if (width === 0) return ordered.length;
  let used = MENU_BUTTON;
  let count = 0;
  for (const action of ordered) {
    used += (widths[action] ?? MENU_BUTTON) + GAP;
    if (used > width) break;
    count++;
  }
  return count;
}

/** The toolbar's actions, with `anchor` at the end when it is not among them. */
export function withAnchor<A extends string>(ordered: readonly A[], anchor: A | undefined): A[] {
  return anchor && !ordered.includes(anchor) ? [...ordered, anchor] : [...ordered];
}

/**
 * The first `limit` candidates, all of them when unset. An anchor the limit
 * cuts off takes the last shown action's place, so an open picker keeps its
 * button and the limit still holds unless it is 0.
 */
export function shownActions<A extends string>(
  candidates: readonly A[],
  limit: number | undefined,
  anchor: A | undefined,
): A[] {
  const shown = limit === undefined ? [...candidates] : candidates.slice(0, Math.max(0, limit));
  if (!anchor || shown.includes(anchor)) return shown;
  return [...shown.slice(0, Math.max(0, shown.length - 1)), anchor];
}

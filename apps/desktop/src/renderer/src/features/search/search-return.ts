/** What had focus when the search field took it, so Escape can hand focus back. */
let returnTarget: HTMLElement | null = null;

/**
 * Called when the search field gains focus. `from` is the element that lost focus and `row` the
 * field's own row: focus that moves between the field and its chips is not a place to return to.
 */
export function rememberSearchReturn(from: EventTarget | null, row: Element | null) {
  if (from instanceof HTMLElement && !row?.contains(from)) returnTarget = from;
  else if (!from) returnTarget = null;
}

/** Puts focus back where it was before the search field took it. False when nothing is left to focus. */
export function restoreSearchReturn(): boolean {
  const target = returnTarget;
  returnTarget = null;
  if (!target?.isConnected) return false;
  target.focus({ preventScroll: true });
  return true;
}

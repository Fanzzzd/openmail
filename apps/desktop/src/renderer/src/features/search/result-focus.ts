/** Focuses the first row of the message list. False when the list has no rows. */
export function focusFirstResult(document: Document): boolean {
  const row = document.querySelector<HTMLElement>(
    '[data-mail-pane="list"] [role="listbox"] [data-id]',
  );
  if (!row) return false;
  row.focus({ preventScroll: true });
  return true;
}

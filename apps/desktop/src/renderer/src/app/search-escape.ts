/**
 * Escape clears the search in layers, as in Gmail and Mimestream. An open popup, menu or
 * dialog takes Escape first. In the search field, Escape clears it like a macOS search field.
 * In the list, it clears the search only while no conversation is open in the reader.
 * Anywhere else, including a message, Escape leaves the search alone.
 */
export function escapeClearsSearch({
  target,
  field,
  readerOpen,
}: {
  target: EventTarget | null;
  field: HTMLInputElement | null;
  readerOpen: boolean;
}): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('[role="menu"],[role="dialog"],[role="alertdialog"]')) return false;
  if (field && target === field) return field.getAttribute("aria-expanded") !== "true";
  return !readerOpen && target.closest('[data-mail-pane="list"] [role="listbox"]') !== null;
}

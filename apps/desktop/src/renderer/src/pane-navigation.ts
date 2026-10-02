/** Focus the adjacent pane, preserving message selection and text cursor behavior. */
export function moveMailPaneFocus(
  document: Document,
  direction: "left" | "right",
  selectedId: string | null,
): boolean {
  const active = document.activeElement;
  if (
    !active ||
    active.closest(
      'input,textarea,select,[contenteditable="true"],[role="menu"],[role="dialog"],[role="combobox"],[role="toolbar"],iframe',
    )
  )
    return false;
  const order = ["sidebar", "list", "reader"];
  const pane = active.closest<HTMLElement>("[data-mail-pane]");
  const index = order.indexOf(pane?.dataset.mailPane ?? "");
  if (index < 0) return false;
  const name = order[index + (direction === "right" ? 1 : -1)];
  if (!name) return false;
  const target = document.querySelector<HTMLElement>(`[data-mail-pane="${name}"]`);
  if (!target) return false;
  const remembered = selectedId
    ? [...target.querySelectorAll<HTMLElement>("[data-id]")].find(
        (row) => row.dataset.id === selectedId,
      )
    : undefined;
  const focus =
    name === "sidebar"
      ? (target.querySelector<HTMLElement>(
          'nav button[aria-current],nav button[aria-selected="true"]',
        ) ?? target.querySelector<HTMLElement>("nav button"))
      : name === "list"
        ? (remembered ??
          target.querySelector<HTMLElement>("[data-id]") ??
          target.querySelector<HTMLElement>('[role="listbox"]'))
        : target.querySelector<HTMLElement>("[data-reader-text]");
  (focus ?? target).focus({ preventScroll: true });
  return true;
}

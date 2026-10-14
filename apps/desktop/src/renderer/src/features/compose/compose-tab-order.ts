import type { KeyboardEvent } from "react";

/**
 * The composer's Tab order. Subject leads straight to the body. The controls placed between
 * them on screen (signature, AI, writing mode and the format bar) come after the body, then
 * the rest of the form follows.
 */
export function composeTabOrder<T>(tabbables: readonly T[], subject: T, body: T): readonly T[] {
  const s = tabbables.indexOf(subject);
  const b = tabbables.indexOf(body);
  if (s < 0 || b < 0 || b < s) return tabbables;
  return [
    ...tabbables.slice(0, s + 1),
    body,
    ...tabbables.slice(s + 1, b),
    ...tabbables.slice(b + 1),
  ];
}

/** The element Tab (or Shift-Tab with `back`) moves to, or undefined to leave it to the browser. */
export function composeTabTarget<T>(order: readonly T[], current: T, back: boolean): T | undefined {
  const index = order.indexOf(current);
  if (index < 0) return undefined;
  return order[back ? index - 1 : index + 1];
}

const TABBABLE =
  "a[href], button, input, select, textarea, [contenteditable='true'], [contenteditable=''], [tabindex]";

function tabbablesIn(root: Element, body: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (el) =>
      el === body ||
      (el.tabIndex >= 0 &&
        !el.matches(":disabled") &&
        !el.closest("[hidden], [inert]") &&
        // Content inside an editable body is part of the body, not a stop of its own.
        !el.parentElement?.closest("[contenteditable='true'], [contenteditable='']") &&
        !(el instanceof HTMLInputElement && el.type === "hidden")),
  );
}

/** Applies {@link composeTabOrder} to a Tab press inside the compose form. */
export function handleComposeTab(
  event: KeyboardEvent<HTMLElement>,
  subject: HTMLElement | null,
  body: HTMLElement | null,
): void {
  if (event.key !== "Tab" || event.defaultPrevented) return;
  if (event.metaKey || event.ctrlKey || event.altKey || !subject || !body) return;
  if (!(event.target instanceof HTMLElement)) return;
  const current = body.contains(event.target) ? body : event.target;
  const order = composeTabOrder(tabbablesIn(event.currentTarget, body), subject, body);
  const next = composeTabTarget(order, current, event.shiftKey);
  if (!next) return;
  event.preventDefault();
  next.focus();
}

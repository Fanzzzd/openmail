type Closest = { closest(selectors: string): Element | null };

// Duck-typed so key events from the reader's iframe, another realm, still match.
const hasClosest = (target: unknown): target is Closest =>
  typeof target === "object" &&
  target !== null &&
  "closest" in target &&
  typeof target.closest === "function";

/** The user is typing when the target is an input, a textarea or a select, or is editable.
 * Editability follows `isContentEditable`: the nearest `contenteditable` attribute decides,
 * so `contenteditable="false"` and its children are not typing targets. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!hasClosest(target)) return false;
  if (target.closest("input,textarea,select")) return true;
  const editable = target.closest("[contenteditable]");
  return editable !== null && editable.getAttribute("contenteditable")?.toLowerCase() !== "false";
}

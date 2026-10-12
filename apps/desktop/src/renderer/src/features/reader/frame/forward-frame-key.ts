import { isTypingTarget } from "../../../lib/typing-target";

/** ⌘A, ⌘C and ⌘X act on text selected in the message. ⌃⌘A is Archive, so it goes on. */
const isTextSelectionKey = (event: KeyboardEvent) =>
  event.metaKey !== event.ctrlKey &&
  !event.altKey &&
  !event.shiftKey &&
  ["a", "c", "x"].includes(event.key.toLowerCase());

/**
 * Key events in a message frame stay in the frame's document and never reach the window,
 * where list and mail shortcuts listen. A key the reader left unhandled is replayed on
 * `target`, as native menu actions are. Handling the copy handles the original, so a menu
 * accelerator for the same key does not fire twice.
 */
export function forwardFrameKey(event: KeyboardEvent, target: EventTarget = document.body) {
  if (event.defaultPrevented || isTypingTarget(event.target) || isTextSelectionKey(event)) return;
  const copy = new KeyboardEvent("keydown", {
    key: event.key,
    code: event.code,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    repeat: event.repeat,
    bubbles: true,
    cancelable: true,
  });
  if (!target.dispatchEvent(copy)) event.preventDefault();
}

import type { NativeAction } from "../../../shared/native-actions";
import {
  EDITOR_ACTION_EVENT,
  NATIVE_MENUS,
  nativeActionStroke,
  nativeActionUsesEditor,
  nativeActionUsesReader,
  nativeMenuActions,
} from "../../../shared/native-actions";
import type { ShortcutSet } from "../../../shared/shortcuts";
import { isTypingTarget } from "../lib/typing-target";

export function shouldDropNativeAction(action: NativeAction, triggeredByAccelerator: boolean) {
  return (
    triggeredByAccelerator &&
    NATIVE_MENUS.some(
      (menu) => menu.name !== "format" && nativeMenuActions(menu).includes(action),
    ) &&
    isTypingTarget(document.activeElement)
  );
}

export function dispatchNativeAction(
  set: ShortcutSet,
  action: NativeAction,
  triggeredByAccelerator: boolean,
) {
  if (shouldDropNativeAction(action, triggeredByAccelerator)) return;
  const stroke = nativeActionStroke(set, action);
  const target = nativeActionUsesEditor(action)
    ? (document.activeElement ?? window)
    : nativeActionUsesReader(action)
      ? readerText()
      : document.body;
  if (!stroke) {
    // Rare formatting has no key, so the menu names the action instead.
    if (nativeActionUsesEditor(action))
      target.dispatchEvent(new CustomEvent(EDITOR_ACTION_EVENT, { detail: action, bubbles: true }));
    return;
  }
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: stroke.key,
      metaKey: Boolean(stroke.cmd),
      ctrlKey: Boolean(stroke.control),
      altKey: Boolean(stroke.alt),
      shiftKey: Boolean(stroke.shift),
      bubbles: true,
      cancelable: true,
    }),
  );
}

/** The reader text that zoom keys act on: the focused one, else the window's reader. */
function readerText(): Element {
  return (
    document.activeElement?.closest('[data-reader-text][role="document"]') ??
    document.querySelector('[data-reader-text][role="document"]') ??
    document.body
  );
}

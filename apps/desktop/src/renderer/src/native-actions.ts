import type { NativeAction } from "../../shared/native-actions";
import {
  NATIVE_MENUS,
  nativeActionStroke,
  nativeActionUsesEditor,
} from "../../shared/native-actions";
import type { ShortcutSet } from "../../shared/shortcuts";

export function shouldDropNativeAction(action: NativeAction, triggeredByAccelerator: boolean) {
  return (
    triggeredByAccelerator &&
    NATIVE_MENUS.some(
      (menu) => menu.name !== "format" && menu.actions.some((candidate) => candidate === action),
    ) &&
    Boolean(document.activeElement?.closest("input,textarea,select,[contenteditable]"))
  );
}

export function dispatchNativeAction(
  set: ShortcutSet,
  action: NativeAction,
  triggeredByAccelerator: boolean,
) {
  if (shouldDropNativeAction(action, triggeredByAccelerator)) return;
  const stroke = nativeActionStroke(set, action);
  if (!stroke) return;
  const target = nativeActionUsesEditor(action)
    ? (document.activeElement ?? window)
    : document.body;
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

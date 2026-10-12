import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_PREFS } from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import {
  platformShortcutText,
  shortcutText,
  type ShortcutAction,
  type ShortcutSet,
} from "../../../shared/shortcuts";
import { isTouchWeb } from "../lib/platform";
import { prefsAtom } from "../state/queries";

export function useShortcutSet() {
  return AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS).shortcutSet;
}

/**
 * A keyboard hint for a tooltip, menu item or label. Empty on a phone or
 * tablet in the web build, which has no keyboard to press it on, so callers
 * render nothing there. A laptop browser keeps the hints.
 */
export const shortcutHint = (set: ShortcutSet, action: ShortcutAction) =>
  isTouchWeb() ? "" : shortcutText(set, action);

/** The same hint in the notation of this OS (Ctrl and Alt off a Mac). */
export const platformShortcutHint = (set: ShortcutSet, action: ShortcutAction) =>
  isTouchWeb() ? "" : platformShortcutText(set, action, navigator.platform);

export function useShortcutText() {
  const set = useShortcutSet();
  return (action: ShortcutAction) => shortcutHint(set, action);
}

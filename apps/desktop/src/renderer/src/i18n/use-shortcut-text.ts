import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_PREFS } from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import {
  platformShortcutText,
  shortcutText,
  type ShortcutAction,
  type ShortcutSet,
} from "../../../shared/shortcuts";
import { isDesktop } from "../lib/platform";
import { prefsAtom } from "../state/queries";

export function useShortcutSet() {
  return AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS).shortcutSet;
}

/**
 * A keyboard hint for a tooltip, menu item or label. Empty in the web build,
 * which runs on phones and tablets, so callers render nothing there.
 */
export const shortcutHint = (set: ShortcutSet, action: ShortcutAction) =>
  isDesktop() ? shortcutText(set, action) : "";

/** The same hint in the notation of this OS (Ctrl and Alt off a Mac). */
export const platformShortcutHint = (set: ShortcutSet, action: ShortcutAction) =>
  isDesktop() ? platformShortcutText(set, action, navigator.platform) : "";

export function useShortcutText() {
  const set = useShortcutSet();
  return (action: ShortcutAction) => shortcutHint(set, action);
}

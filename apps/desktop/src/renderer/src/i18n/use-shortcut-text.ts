import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_PREFS } from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import {
  KEYMAP,
  platformShortcutText,
  spaceStroke,
  shortcutText,
  strokesLabel,
  type KeyStroke,
  type ShortcutAction,
  type ShortcutLabel,
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

/** The label of fixed strokes, such as ⌘[ for Back, with `aria-keyshortcuts` for this OS. */
export const strokesHint = (strokes: readonly KeyStroke[]): ShortcutLabel | undefined =>
  strokes.length === 0 ? undefined : strokesLabel(strokes, navigator.platform);

/** An action's label for a tooltip and its trigger. Undefined where {@link shortcutHint} is empty. */
export const shortcutLabelHint = (set: ShortcutSet, action: ShortcutAction) =>
  isTouchWeb() ? undefined : strokesHint(KEYMAP[set][action]);

export function useShortcutLabel() {
  const set = useShortcutSet();
  return (action: ShortcutAction) => shortcutLabelHint(set, action);
}

/** The label of the stroke that opens the space at `index`, for the first nine. */
export function spaceShortcutHint(set: string, index: number) {
  const stroke = spaceStroke(set, index);
  return stroke && strokesHint([stroke]);
}

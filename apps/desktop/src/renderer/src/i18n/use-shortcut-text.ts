import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_PREFS } from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import { shortcutText, type ShortcutAction } from "../../../shared/shortcuts";
import { prefsAtom } from "../state/queries";

export function useShortcutSet() {
  return AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS).shortcutSet;
}

export function useShortcutText() {
  const set = useShortcutSet();
  return (action: ShortcutAction) => shortcutText(set, action);
}

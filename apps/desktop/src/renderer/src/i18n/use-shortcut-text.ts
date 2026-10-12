import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_PREFS } from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import { shortcutText, type ShortcutAction } from "../../../shared/shortcuts";
import { prefsAtom } from "../state/queries";

export function useShortcutText() {
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  return (action: ShortcutAction) => shortcutText(prefs.shortcutSet, action);
}

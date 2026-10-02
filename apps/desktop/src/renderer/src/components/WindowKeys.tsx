import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_PREFS } from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import { useEffect } from "react";
import { shortcutAction } from "../../../shared/shortcuts";
import { prefsAtom } from "../state/queries";
import { useRunMail, withMail } from "../state/mail";

export function WindowKeys() {
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  const run = useRunMail();
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      const typing =
        event.target instanceof Element &&
        Boolean(event.target.closest("input,textarea,select,[contenteditable]"));
      const action = shortcutAction(prefs.shortcutSet, event, typing);
      if (action !== "nextWindow" && action !== "previousWindow" && action !== "focusMainWindow")
        return;
      event.preventDefault();
      run(withMail((call) => call("SwitchWindow", { action })));
    };
    window.addEventListener("keydown", listener);
    return () => {
      window.removeEventListener("keydown", listener);
    };
  }, [prefs.shortcutSet, run]);
  return null;
}

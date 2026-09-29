import { useAtomValue } from "@effect/atom-react";
import { I18nProvider } from "@lingui/react";
import { AsyncResult } from "effect/reactivity";
import { type ReactNode, useLayoutEffect } from "react";

import { activateLocale, i18n, resolveLocale } from "../i18n";
import { prefsAtom } from "../state/queries";

/**
 * Applies the language preference. The app waits for the stored preference so
 * it never paints in the wrong language first; a failed read follows the OS.
 * Changing the preference switches the language in place.
 */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const prefs = useAtomValue(prefsAtom);
  const locale = AsyncResult.isSuccess(prefs)
    ? resolveLocale(prefs.value.language)
    : AsyncResult.isFailure(prefs)
      ? resolveLocale("system")
      : null;
  // Before paint, so the first frame with the app already has the right language.
  useLayoutEffect(() => {
    if (locale) activateLocale(locale);
  }, [locale]);
  return <I18nProvider i18n={i18n}>{locale ? children : null}</I18nProvider>;
}

import { useAtomValue } from "@effect/atom-react";
import { I18nProvider } from "@lingui/react";
import { AsyncResult } from "effect/reactivity";
import { type ReactNode, useEffect, useState } from "react";

import { activateLocale, i18n, resolveLocale, type Locale } from "./i18n";
import { prefsAtom } from "../state/queries";

type CatalogState =
  | { kind: "pending" }
  | { kind: "ready"; locale: Locale }
  | { kind: "failed"; error: Error };

/** Wait for the initial catalog; keep the UI mounted while a later language loads. */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const prefs = useAtomValue(prefsAtom);
  const [catalog, setCatalog] = useState<CatalogState>({ kind: "pending" });
  const locale = AsyncResult.isSuccess(prefs)
    ? resolveLocale(prefs.value.language)
    : AsyncResult.isFailure(prefs)
      ? resolveLocale("system")
      : null;
  useEffect(() => {
    let active = true;
    if (locale) {
      void activateLocale(locale)
        .then((activated) => {
          if (active && activated) setCatalog({ kind: "ready", locale });
          return activated;
        })
        .catch((error: unknown) => {
          if (active)
            setCatalog({
              kind: "failed",
              error: error instanceof Error ? error : new Error(String(error)),
            });
        });
    }
    return () => {
      active = false;
    };
  }, [locale]);
  if (catalog.kind === "failed") throw catalog.error;
  return catalog.kind === "ready" ? <I18nProvider i18n={i18n}>{children}</I18nProvider> : null;
}

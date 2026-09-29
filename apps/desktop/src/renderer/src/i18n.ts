import { i18n } from "@lingui/core";

import type { Language } from "../../shared/api";
import { messages as en } from "./locales/en/messages.po";
import { messages as zhCN } from "./locales/zh-CN/messages.po";

export type Locale = "en" | "zh-CN";

/**
 * The OS language, from the main process (`?system=` on the page URL).
 * Chinese in any script or region maps to zh-CN; everything else to English.
 */
const SYSTEM_LOCALE: Locale = /^zh\b/i.test(
  new URLSearchParams(window.location.search).get("system") ?? navigator.language,
)
  ? "zh-CN"
  : "en";

/** The locale the UI uses for a language preference. */
export function resolveLocale(language: Language): Locale {
  return language === "system" ? SYSTEM_LOCALE : language;
}

// Two small catalogs, both bundled, so switching is synchronous.
i18n.load({ en, "zh-CN": zhCN });

export function activateLocale(locale: Locale): void {
  if (i18n.locale === locale) return;
  i18n.activate(locale);
  document.documentElement.lang = locale;
}

// Until the stored preference loads, follow the OS.
activateLocale(SYSTEM_LOCALE);

export { i18n };

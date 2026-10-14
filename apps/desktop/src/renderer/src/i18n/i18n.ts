import { i18n } from "@lingui/core";
import { Schema } from "effect";
import type { Language } from "../../../shared/api";
import { loadCatalog } from "../../../shared/catalogs";
import { createLocaleActivator } from "../../../shared/locale-activation";
import { systemLocale, type Locale } from "../../../shared/locales";
import { setSystemDateRegion } from "../lib/format";
export type { Locale } from "../../../shared/locales";

const query = new URLSearchParams(window.location.search);
setSystemDateRegion(query);
const preferred = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)))(
  query.get("systemLanguages") ?? "null",
);
const SYSTEM_LOCALE = systemLocale(
  preferred._tag === "Some" ? preferred.value : navigator.languages,
);

export function resolveLocale(language: Language): Locale {
  return language === "system" ? SYSTEM_LOCALE : language;
}

export const activateLocale = createLocaleActivator(i18n, loadCatalog, (locale) => {
  document.documentElement.lang = locale;
});

export { i18n };

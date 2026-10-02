import type { Locale } from "./locales";
import type { Messages } from "@lingui/core";

const catalogs = {
  en: () => import("../renderer/src/locales/en/messages.po"),
  "zh-CN": () => import("../renderer/src/locales/zh-CN/messages.po"),
  cs: () => import("../renderer/src/locales/cs/messages.po"),
  nl: () => import("../renderer/src/locales/nl/messages.po"),
  fr: () => import("../renderer/src/locales/fr/messages.po"),
  de: () => import("../renderer/src/locales/de/messages.po"),
  it: () => import("../renderer/src/locales/it/messages.po"),
  ja: () => import("../renderer/src/locales/ja/messages.po"),
  ru: () => import("../renderer/src/locales/ru/messages.po"),
  es: () => import("../renderer/src/locales/es/messages.po"),
} satisfies Record<Locale, () => Promise<{ messages: Messages }>>;

const loaded = new Map<Locale, Promise<Messages>>();
export function loadCatalog(locale: Locale): Promise<Messages> {
  const cached = loaded.get(locale);
  if (cached) return cached;
  const pending = catalogs[locale]()
    .then((module) => module.messages)
    .catch((error: unknown) => {
      loaded.delete(locale);
      throw error;
    });
  loaded.set(locale, pending);
  return pending;
}

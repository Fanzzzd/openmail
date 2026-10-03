import { setupI18n } from "@lingui/core";
import { getLocales } from "expo-localization";
import { messages as en } from "./locales/en/messages";
import { messages as zh } from "./locales/zh-CN/messages";
import { messages as cs } from "./locales/cs/messages";
import { messages as nl } from "./locales/nl/messages";
import { messages as fr } from "./locales/fr/messages";
import { messages as de } from "./locales/de/messages";
import { messages as it } from "./locales/it/messages";
import { messages as ja } from "./locales/ja/messages";
import { messages as ru } from "./locales/ru/messages";
import { messages as es } from "./locales/es/messages";

const catalogs = { en, "zh-CN": zh, cs, nl, fr, de, it, ja, ru, es };
const language = getLocales()[0].languageCode ?? "en";
const locale = language === "zh" ? "zh-CN" : language in catalogs ? language : "en";
export const i18n = setupI18n({ locale, messages: catalogs });

export function activateLanguage(preferredLanguage: string) {
  const target = preferredLanguage === "system" ? locale : preferredLanguage;
  if (target in catalogs && i18n.locale !== target) i18n.activate(target);
}

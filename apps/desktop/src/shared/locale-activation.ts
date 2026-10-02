import type { I18n, Messages } from "@lingui/core";
import type { Locale } from "./locales";

/** Slow imports may finish out of order; only the latest requested language may activate. */
export function createLocaleActivator(
  i18n: I18n,
  load: (locale: Locale) => Promise<Messages>,
  onActivated: (locale: Locale) => void,
) {
  let request = 0;
  return async (locale: Locale): Promise<boolean> => {
    const current = ++request;
    const messages = await load(locale);
    if (current !== request) return false;
    i18n.load(locale, messages);
    i18n.activate(locale);
    onActivated(locale);
    return true;
  };
}

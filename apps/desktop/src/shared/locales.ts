import { LANGUAGES, type Language } from "@openmail/core/schema";

export type Locale = Exclude<Language, "system">;

/** Match OS region/script variants to a supported catalog. */
export function systemLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const base = language.toLowerCase().split(/[-_]/)[0];
    if (base === "zh") return "zh-CN";
    const match = LANGUAGES.find(
      (locale): locale is Locale => locale !== "system" && locale === base,
    );
    if (match) return match;
  }
  return "en";
}

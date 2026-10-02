import { expect, it } from "vitest";
import { Schema } from "effect";
import { DEFAULT_PREFS, LANGUAGES, Prefs } from "@openmail/core/schema";
import { setupI18n } from "@lingui/core";
import { systemLocale } from "./locales";
import { formatBytes, shortDate } from "../renderer/src/format";

it("every language preference round-trips and OS region/script variants select the right catalog", () => {
  const decode = Schema.decodeUnknownSync(Prefs);
  for (const language of LANGUAGES)
    expect(decode({ ...DEFAULT_PREFS, language }).language).toBe(language);
  for (const [system, locale] of [
    ["cs-CZ", "cs"],
    ["nl_NL", "nl"],
    ["fr-CA", "fr"],
    ["DE-de", "de"],
    ["it-IT", "it"],
    ["ja-JP", "ja"],
    ["ru-RU", "ru"],
    ["es-MX", "es"],
    ["zh-Hant-TW", "zh-CN"],
    ["en-GB", "en"],
    ["pt-BR", "en"],
    ["", "en"],
  ])
    expect(systemLocale([system ?? ""])).toBe(locale);
  expect(systemLocale(["pt-BR", "de-AT", "ja-JP"])).toBe("de");
  expect(systemLocale(["ko-KR", "zh-Hant-TW", "en"])).toBe("zh-CN");
  expect(systemLocale([])).toBe("en");
  expect(() => decode({ ...DEFAULT_PREFS, language: "invalid" })).toThrow();
});

it("dates and attachment sizes follow the selected language, including decimal separators and unit names", () => {
  const date = new Date(2020, 2, 15).getTime();
  for (const locale of ["en", "zh-CN", "cs", "nl", "fr", "de", "it", "ja", "ru", "es"]) {
    const i18n = setupI18n({ locale, messages: { [locale]: {} } });
    expect(shortDate(date, i18n)).toBe(new Date(date).toLocaleDateString(locale));
    expect(formatBytes(1.5 * 1024 ** 2, locale)).toBe(
      new Intl.NumberFormat(locale, {
        style: "unit",
        unit: "megabyte",
        unitDisplay: "short",
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }).format(1.5),
    );
  }
  expect(formatBytes(1.5 * 1024 ** 2, "de")).toContain("1,5");
  expect(formatBytes(1024, "fr")).toContain("ko");
});

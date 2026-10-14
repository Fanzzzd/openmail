import { setupI18n } from "@lingui/core";
import { expect, it } from "vitest";
import { dateLocale } from "../../../shared/date-region";
import { formatBytes, previewText, shortDate, threadDate } from "./format";

const english = setupI18n({ locale: "en", messages: { en: {} } });
const now = new Date(2026, 9, 14, 15, 0);
const morning = new Date(2026, 9, 14, 8, 9).getTime();
const october12 = new Date(2026, 6, 12, 8, 9).getTime();

it("formats list dates with the macOS region when it speaks the UI language", () => {
  const uk = { region: "en-GB", hourCycle: undefined };
  const us = { region: "en-US", hourCycle: undefined };
  expect(shortDate(morning, english, uk, now)).toBe("08:09");
  expect(shortDate(morning, english, us, now)).toBe("8:09 AM");
  expect(shortDate(october12, english, uk, now)).toBe("12/07");
  expect(shortDate(october12, english, us, now)).toBe("7/12");
  expect(threadDate(october12, english, uk, now)).toBe("12 July 08:09");
  expect(threadDate(october12, english, us, now)).toBe("July 12 8:09 AM");
});

it("follows the macOS 12 or 24-hour switch over the region's clock", () => {
  expect(shortDate(morning, english, { region: "en-US", hourCycle: "h23" }, now)).toBe("08:09");
  expect(shortDate(morning, english, { region: "en-GB", hourCycle: "h12" }, now)).toMatch(
    /^8:09\sam$/i,
  );
});

it("uses the UI language's own region when the macOS region speaks another language", () => {
  expect(dateLocale("en", "de-DE")).toBe("en");
  expect(dateLocale("de", "de-AT")).toBe("de-AT");
  expect(dateLocale("zh-CN", "zh-Hans-CN")).toBe("zh-Hans-CN");
  expect(dateLocale("en", "not a locale")).toBe("en");
  expect(dateLocale("en", undefined)).toBe("en");
});

it("formats zero, one and plural bytes with the locale's grammatical unit", () => {
  for (const locale of ["en", "zh-CN", "cs", "nl", "fr", "de", "it", "ja", "ru", "es"])
    for (const bytes of [0, 1, 2, 5])
      expect(formatBytes(bytes, locale)).toBe(
        new Intl.NumberFormat(locale, {
          style: "unit",
          unit: "byte",
          unitDisplay: "long",
          maximumFractionDigits: 0,
        }).format(bytes),
      );
  expect(formatBytes(0, "en")).toBe("0 bytes");
  expect(formatBytes(1, "en")).toBe("1 byte");
  expect(formatBytes(2 * 1024 ** 3, "en")).toBe("2.0 GB");
});

it("drops preheader padding from a row's preview", () => {
  // Combining grapheme joiner, zero-width non-joiner, figure space, byte order mark.
  const [cgj, zwnj, figure, bom, zwsp] = [0x34f, 0x200c, 0x2007, 0xfeff, 0x200b].map((code) =>
    String.fromCodePoint(code),
  );
  const padding = `${cgj} ${zwnj} ${figure} ${figure}${bom} `.repeat(3);
  expect(previewText(`Sale today.\r\n${padding}`)).toBe("Sale today.");
  // Runs of two or more collapse; a lone character inside text stays.
  expect(previewText(`a${zwsp}${zwsp}b\u00a0 c`)).toBe("a b c");
  expect(previewText("")).toBe("");
});

it("keeps a single joiner inside emoji and words", () => {
  const [zwj, zwnj] = [0x200d, 0x200c].map((code) => String.fromCodePoint(code));
  const family = ["👨", "👩", "👧"].join(zwj);
  expect(previewText(`Hi ${family} there`)).toBe(`Hi ${family} there`);
  const persian = `می${zwnj}خواهم`;
  expect(previewText(persian)).toBe(persian);
});

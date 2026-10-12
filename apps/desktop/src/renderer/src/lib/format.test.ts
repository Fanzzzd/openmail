import { expect, it } from "vitest";
import { formatBytes, previewText } from "./format";

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

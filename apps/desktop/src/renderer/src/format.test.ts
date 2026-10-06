import { expect, it } from "vitest";
import { formatBytes } from "./format";

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

import { expect, it } from "vitest";
import { GMAIL_AVATAR_TONES, letterAvatarColor } from "./format";
it("letter avatar colors are stable by normalized name, with Google Material tones", () => {
  expect(letterAvatarColor("Ada Lovelace")).toBe("#6d4c41");
  expect(letterAvatarColor("  ADA LOVELACE  ")).toBe(letterAvatarColor("Ada Lovelace"));
  expect(letterAvatarColor("Alice")).toBe("#c62828");
  expect(letterAvatarColor("张三")).toBe("#ad1457");
  expect(letterAvatarColor("Jose\u0301")).toBe(letterAvatarColor("José"));
  for (const name of ["", "李", "👩🏽‍💻", "me@example.com"])
    expect(GMAIL_AVATAR_TONES).toContain(letterAvatarColor(name));
});

it("every avatar tone has at least 4.5:1 contrast against its white text", () => {
  for (const tone of GMAIL_AVATAR_TONES) {
    const rgb = [1, 3, 5]
      .map((offset) => parseInt(tone.slice(offset, offset + 2), 16) / 255)
      .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
    const luminance = (rgb[0] ?? 0) * 0.2126 + (rgb[1] ?? 0) * 0.7152 + (rgb[2] ?? 0) * 0.0722;
    expect(1.05 / (luminance + 0.05)).toBeGreaterThanOrEqual(4.5);
  }
});

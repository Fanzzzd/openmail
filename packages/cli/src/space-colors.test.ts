import { PROFILE_COLORS } from "@openmail/core";
import { expect, it } from "vitest";
import { COLOR_WORDS, profileColor } from "./commands/accounts.js";

// The app names the swatches Purple, Red, Brown, Green and Gray, but --color took only the
// stored keys, so `--color brown` was a usage error.
it("--color takes the app's color words in any letter case and the stored keys", () => {
  expect(
    Object.fromEntries(COLOR_WORDS.map((word) => [word, profileColor(word.toUpperCase())])),
  ).toEqual({
    blue: "blue",
    purple: "violet",
    red: "rose",
    orange: "orange",
    brown: "amber",
    green: "emerald",
    teal: "teal",
    gray: "slate",
  });
  expect(profileColor("Grey")).toBe("slate");
  for (const key of PROFILE_COLORS) expect(profileColor(key)).toBe(key);
  expect(new Set(COLOR_WORDS.map(profileColor))).toEqual(new Set(PROFILE_COLORS));
  for (const word of ["pink", "", "constructor", "__proto__"])
    expect(profileColor(word)).toBeUndefined();
});

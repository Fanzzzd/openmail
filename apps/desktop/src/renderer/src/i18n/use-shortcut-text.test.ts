// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { shortcutText } from "../../../shared/shortcuts";
import { setPlatform } from "../lib/platform";
import { platformShortcutHint, shortcutHint } from "./use-shortcut-text";

/** A browser whose primary pointer is a finger (coarse) or a mouse or trackpad (fine). */
const pointer = (coarse: boolean) =>
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(pointer: coarse)" && coarse,
    media: query,
  }));

afterEach(() => {
  setPlatform("desktop");
  vi.unstubAllGlobals();
});

it("shows shortcut hints on the Mac and in a laptop browser, but not on a phone", () => {
  const hint = shortcutText("gmail", "compose");
  expect(hint).not.toBe("");

  pointer(true);
  expect(shortcutHint("gmail", "compose")).toBe(hint);

  setPlatform("web");
  pointer(false);
  expect(shortcutHint("gmail", "compose")).toBe(hint);
  expect(platformShortcutHint("gmail", "compose")).not.toBe("");

  pointer(true);
  expect(shortcutHint("gmail", "compose")).toBe("");
  expect(platformShortcutHint("gmail", "compose")).toBe("");
});

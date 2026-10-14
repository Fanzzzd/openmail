import { existsSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { ICNS, ICON_COMPOSER, macIcon, macIconFor, xcodeMajor } from "../../../build/mac-icon.cjs";
import { desktopRoot } from "../../renderer/src/test-support/paths";

it("reads the Xcode major version from xcodebuild -version", () => {
  expect(xcodeMajor("Xcode 26.6\nBuild version 17F113\n")).toBe(26);
  expect(xcodeMajor("Xcode 16.4\nBuild version 16F6\n")).toBe(16);
  expect(xcodeMajor("Xcode 27\nBuild version 18A1\n")).toBe(27);
  expect(xcodeMajor("xcode-select: error: tool 'xcodebuild' requires Xcode")).toBeUndefined();
  expect(xcodeMajor(null)).toBeUndefined();
});

it("packages the Icon Composer icon with Xcode 26 or later and the icns otherwise", () => {
  expect(macIconFor("Xcode 26.0\nBuild version 17A324\n")).toBe(ICON_COMPOSER);
  expect(macIconFor("Xcode 30.1\nBuild version 21A1\n")).toBe(ICON_COMPOSER);
  expect(macIconFor("Xcode 16.4\nBuild version 16F6\n")).toBe(ICNS);
  expect(macIconFor("Xcode 15.2\nBuild version 15C500b\n")).toBe(ICNS);
  expect(macIconFor(null)).toBe(ICNS);
});

it("says when it falls back to the icns", () => {
  const logs: string[] = [];
  expect(
    macIcon(
      () => null,
      (message) => logs.push(message),
    ),
  ).toBe(ICNS);
  expect(logs).toEqual([expect.stringContaining("build/icon.icns")]);
  logs.length = 0;
  expect(
    macIcon(
      () => "Xcode 26.6\n",
      (message) => logs.push(message),
    ),
  ).toBe(ICON_COMPOSER);
  expect(logs).toEqual([]);
});

it("both icons exist in the repo", () => {
  for (const icon of [ICNS, ICON_COMPOSER])
    expect(existsSync(path.join(desktopRoot, icon))).toBe(true);
});

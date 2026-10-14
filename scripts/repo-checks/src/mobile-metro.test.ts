import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("Metro resolves through Expo's default resolver, so core's css-tree import gets the browser build", () => {
  // packages/core/src/platform/node/css-browser.test.ts checks the css-tree side.
  const metro = readFileSync(
    new URL("../../../apps/mobile/metro.config.cjs", import.meta.url),
    "utf8",
  );
  expect(metro).toContain('require("expo/metro-config")');
  expect(metro).toContain("context.resolveRequest(context, moduleName, platform)");
});

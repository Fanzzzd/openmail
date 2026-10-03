import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
const order = vi.hoisted(() => [] as string[]);
vi.mock("./background", () => {
  order.push("background");
  return {};
});
vi.mock("expo-router/entry", () => {
  order.push("router");
  return {};
});
it("loads the headless task definition before Expo Router without mounting routes", async () => {
  const packageJson: unknown = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  expect(packageJson).toHaveProperty("main", "index.js");
  await import("../index.js");
  expect(order).toEqual(["background", "router"]);
  const background = readFileSync(new URL("./background.ts", import.meta.url), "utf8");
  expect(background).toContain("TaskManager.defineTask(REFRESH_TASK, runBackgroundRefresh)");
  expect(background).not.toMatch(
    /from ["'](?:react|expo-router|\.\/mailbox|\.\/lifecycle|\.\/platform)["']/,
  );
});

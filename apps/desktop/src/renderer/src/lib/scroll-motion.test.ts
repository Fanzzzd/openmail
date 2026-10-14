import { afterEach, expect, it, vi } from "vitest";
import { scrollBehavior } from "./scroll-motion";

afterEach(() => {
  vi.unstubAllGlobals();
});

const reduceMotion = (on: boolean) =>
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: on && query === "(prefers-reduced-motion: reduce)",
  }));

it("scrolls smoothly unless Reduce Motion is on", () => {
  reduceMotion(false);
  expect(scrollBehavior()).toBe("smooth");
  reduceMotion(true);
  expect(scrollBehavior()).toBe("auto");
});

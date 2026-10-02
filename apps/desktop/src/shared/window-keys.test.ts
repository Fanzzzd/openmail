import { expect, it } from "vitest";
import { adjacentWindowId } from "./window-keys";
it("window navigation wraps in both directions and handles missing/only windows", () => {
  expect(adjacentWindowId([1, 2, 3], 3, 1)).toBe(1);
  expect(adjacentWindowId([1, 2, 3], 1, -1)).toBe(3);
  expect(adjacentWindowId([1, 2, 3], 2, 1)).toBe(3);
  expect(adjacentWindowId([1], 1, -1)).toBe(1);
  expect(adjacentWindowId([1, 2], null, -1)).toBe(1);
  expect(adjacentWindowId([], 1, 1)).toBeUndefined();
});

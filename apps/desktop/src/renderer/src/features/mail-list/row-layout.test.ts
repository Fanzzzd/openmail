import { listWindow } from "@openmail/core/schema";
import { expect, it } from "vitest";
import { pageRow, rowLayout, rowWindow } from "./row-layout";

it("matches the fixed-height window when every row is the same height", () => {
  const layout = rowLayout(Array.from({ length: 500 }, () => 104));
  for (const [top, height] of [
    [0, 800],
    [5200, 600],
    [51_000, 1200],
  ] as const)
    expect(rowWindow(layout, top, height)).toEqual(listWindow(500, top, height, 104));
});

it("gives only rows with hits the taller height, so plain rows leave no blank band", () => {
  const heights = [104, 152, 104, 104, 152, 104];
  const layout = rowLayout(heights);
  expect(layout.offsets).toEqual([0, 104, 256, 360, 464, 616, 720]);
  expect(rowWindow(layout, 0, 300)).toEqual({ first: 0, end: 6, offset: 0, total: 720 });
  const tall = rowLayout(Array.from({ length: 40 }, (_, i) => (i % 2 ? 152 : 104)));
  // Rows 20 and 21 span 2560..2816; the window starts six rows above the one at the top.
  const window = rowWindow(tall, 2600, 200);
  expect(window.first).toBe(14);
  expect(window.offset).toBe(tall.offsets[14]);
  expect(window.end).toBe(28);
  expect(rowWindow(rowLayout([]), 0, 500)).toEqual({ first: 0, end: 0, offset: 0, total: 0 });
});

it("pages by the list's height, at least one row, and stops at either end", () => {
  const layout = rowLayout(Array.from({ length: 30 }, (_, i) => (i === 3 ? 152 : 100)));
  // 600 px below row 0's top is inside row 5, since row 3 is 52 px taller.
  expect(pageRow(layout, 0, 600, 1)).toBe(5);
  expect(pageRow(layout, 5, 600, -1)).toBe(0);
  expect(pageRow(layout, 27, 600, 1)).toBe(29);
  expect(pageRow(layout, 2, 600, -1)).toBe(0);
  // A list not measured yet still moves one row.
  expect(pageRow(layout, 4, 0, 1)).toBe(5);
  expect(pageRow(layout, 4, 0, -1)).toBe(3);
  expect(pageRow(rowLayout([]), 0, 600, 1)).toBe(-1);
});

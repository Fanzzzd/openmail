import { expect, it } from "vitest";
import { scrollEdges, scrollFadeMask } from "./scroll-fade";

it("fades only the ends of a scroller that hide content", () => {
  const fits = scrollEdges({ scrollLeft: 0, scrollWidth: 300, clientWidth: 300 });
  expect(fits).toEqual({ start: false, end: false });
  expect(scrollFadeMask(fits)).toBeUndefined();
  // Chips wider than the pane: the end fades until the row is scrolled to it.
  const clipped = scrollEdges({ scrollLeft: 0, scrollWidth: 420, clientWidth: 300 });
  expect(clipped).toEqual({ start: false, end: true });
  expect(scrollFadeMask(clipped)).toBe(
    "linear-gradient(to right, black 0, black calc(100% - 2rem), transparent 100%)",
  );
  const middle = scrollEdges({ scrollLeft: 60, scrollWidth: 420, clientWidth: 300 });
  expect(middle).toEqual({ start: true, end: true });
  const end = scrollEdges({ scrollLeft: 119.5, scrollWidth: 420, clientWidth: 300 });
  expect(end).toEqual({ start: true, end: false });
  expect(scrollFadeMask(end)).toBe(
    "linear-gradient(to right, transparent 0, black 1.5rem, black 100%)",
  );
});

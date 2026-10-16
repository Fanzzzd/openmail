import { expect, it } from "vitest";
import { searchSlotClass } from "./search-slot";

/** The basis a grown slot takes in a header `bar` px wide, read from its clamp(). */
function grownWidth(className: string, bar: number): number {
  const match = /basis-\[clamp\(([\d.]+)rem,100cqw_-_([\d.]+)rem,([\d.]+)rem\)\]!/.exec(className);
  if (!match) throw new Error(`no grown basis in ${className}`);
  const [min, offset, max] = match.slice(1).map((value) => Number(value) * 16);
  return Math.min(Math.max(min!, bar - offset!), max!);
}

// At a 1320 px window the field stayed 320 px with ~300 px of header unused, so chips
// truncated to "label:…" and "from:NO…".
it("grows search with a query into the header's spare room, up to the field's 520 px", () => {
  const withQuery = searchSlotClass(true, "from:nora label:travel", true);
  expect(withQuery).not.toContain("focus-within:basis-[");
  expect(grownWidth(withQuery, 1300)).toBe(520);
  expect(grownWidth(withQuery, 1100)).toBe(460);
  // Up to 960 px the toolbar needs the room: search holds 20rem and the toolbar folds actions.
  expect(grownWidth(withQuery, 960)).toBe(320);
  expect(grownWidth(withQuery, 700)).toBe(320);
});

it("grows an empty field only while focused, and fills the header without a toolbar", () => {
  const empty = searchSlotClass(true, "", true);
  expect(empty).toContain("flex-[0_1_14rem]");
  expect(empty).toContain("focus-within:basis-[clamp(");
  expect(grownWidth(empty, 1200)).toBe(520);
  expect(searchSlotClass(false, "from:nora", true)).toContain("flex-1");
});

// At 1320 px with nothing selected the toolbar shows no actions, yet search still reserved 40rem
// and left ~490 px empty, so "label:r…" truncated.
it("reserves only 14rem for the toolbar while no message is selected", () => {
  const none = searchSlotClass(true, "label:receipts", false);
  const selected = searchSlotClass(true, "label:receipts", true);
  expect(grownWidth(none, 1000)).toBe(520);
  expect(grownWidth(selected, 1000)).toBe(360);
  expect(grownWidth(none, 500)).toBe(320);
});

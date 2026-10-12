import { expect, it } from "vitest";
import { settleStartupSelection } from "./window-selection";
import { singleSelection } from "../lib/selection";
it("keeps a restored id while loading, then clears a missing id after the first list", () => {
  const selection = singleSelection("missing");
  expect(settleStartupSelection("missing", selection, false, new Set()).selection).toBe(selection);
  const settled = settleStartupSelection("missing", selection, true, new Set(["other"]));
  expect(settled.startupId).toBeNull();
  expect(settled.selection.ids.size).toBe(0);
});
it("releases startup restoration once a present message has loaded without losing selection", () => {
  const selection = singleSelection("present");
  expect(settleStartupSelection("present", selection, true, new Set(["present"]))).toEqual({
    startupId: null,
    selection,
  });
});

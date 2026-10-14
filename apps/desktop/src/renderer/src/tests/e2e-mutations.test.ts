import { expect, it } from "vitest";
import { cases, missingAnchors } from "../../../../scripts/e2e-mutations.mjs";

// The mutation script runs by hand (docs/testing.md); this keeps its anchors from rotting
// when the code they point at moves.
it("every e2e mutation anchor is still in its file", () => {
  expect(cases.length).toBeGreaterThan(0);
  expect(missingAnchors()).toEqual([]);
});

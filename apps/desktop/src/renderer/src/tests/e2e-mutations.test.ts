import { expect, it } from "vitest";
import { cases, missingAnchors, missingTitles } from "../../../../scripts/e2e-mutations.mjs";

// The mutation script runs by hand (docs/testing.md); this keeps its anchors from rotting
// when the code they point at moves.
it("every e2e mutation anchor is still in its file", () => {
  expect(cases.length).toBeGreaterThan(0);
  expect(missingAnchors()).toEqual([]);
});

// The script runs a case's titled tests and requires each to fail, so a renamed test must be
// renamed in its cases too.
it("every e2e mutation case names tests that exist", () => {
  expect(missingTitles()).toEqual([]);
});

import { expect, it } from "vitest";
import { keyboardInsets } from "./keyboard-inset";

it("measures the keyboard from the visual viewport, and ignores pinch zoom", () => {
  // No keyboard: the visual viewport is the layout viewport.
  expect(keyboardInsets({ height: 844, offsetTop: 0, scale: 1, layoutHeight: 844 })).toEqual({
    top: 0,
    bottom: 0,
  });
  // iOS keyboard up, page scrolled 40 px to keep the field in view.
  expect(keyboardInsets({ height: 500, offsetTop: 40, scale: 1, layoutHeight: 844 })).toEqual({
    top: 40,
    bottom: 304,
  });
  expect(keyboardInsets({ height: 300, offsetTop: 100, scale: 2, layoutHeight: 844 })).toEqual({
    top: 0,
    bottom: 0,
  });
});

import { expect, it } from "vitest";
import { moveToolbarAction } from "./toolbar-order";

it("keyboard movement preserves selected actions, their boundaries, and the input ordering", () => {
  const actions = ["archive", "reply", "star"] as const;
  expect(moveToolbarAction(actions, "reply", -1)).toEqual(["reply", "archive", "star"]);
  expect(moveToolbarAction(actions, "reply", 1)).toEqual(["archive", "star", "reply"]);
  expect(moveToolbarAction(actions, "archive", -1)).toEqual(actions);
  expect(moveToolbarAction(actions, "star", 1)).toEqual(actions);
  expect(moveToolbarAction(actions, "trash", 1)).toEqual(actions);
  expect(actions).toEqual(["archive", "reply", "star"]);
});

import { expect, it } from "vitest";
import { fittingCount, shownActions, withAnchor } from "./toolbar-fit";

const actions = ["archive", "trash", "spam", "label"];

it("fits actions by their measured widths beside the 28 px menu button", () => {
  // Unmeasured toolbars show everything.
  expect(fittingCount(actions, {}, 0)).toBe(4);
  // Icon buttons take 28 px plus a 2 px gap: 28 + 4 × 30 = 148.
  expect(fittingCount(actions, {}, 148)).toBe(4);
  expect(fittingCount(actions, {}, 147)).toBe(3);
  expect(fittingCount(actions, {}, 57)).toBe(0);
  expect(fittingCount(actions, {}, 58)).toBe(1);
  // A measured text button counts at its own width: 28 + 3 × 30 + 92 + 2 = 212.
  expect(fittingCount(actions, { label: 92 }, 212)).toBe(4);
  expect(fittingCount(actions, { label: 92 }, 211)).toBe(3);
});

it("shows an open picker's button without hiding an action that has room", () => {
  // No limit: the picker joins the end and every action stays.
  expect(shownActions(withAnchor(["archive", "trash"], "label"), undefined, "label")).toEqual([
    "archive",
    "trash",
    "label",
  ]);
  expect(shownActions(withAnchor(actions, "label"), undefined, "label")).toEqual(actions);
  // A limit with room for the picker keeps every action.
  expect(shownActions(withAnchor(["archive", "trash"], "label"), 3, "label")).toEqual([
    "archive",
    "trash",
    "label",
  ]);
  // A picker past the limit takes the last shown action's place.
  expect(shownActions(actions, 2, "label")).toEqual(["archive", "label"]);
  expect(shownActions(withAnchor(["archive", "trash"], "move"), 2, "move")).toEqual([
    "archive",
    "move",
  ]);
  // Without room at all, the picker still gets its button.
  expect(shownActions(actions, 0, "label")).toEqual(["label"]);
  // Without a picker the limit cuts the list.
  expect(shownActions(actions, 2, undefined)).toEqual(["archive", "trash"]);
  expect(shownActions(actions, undefined, undefined)).toEqual(actions);
});

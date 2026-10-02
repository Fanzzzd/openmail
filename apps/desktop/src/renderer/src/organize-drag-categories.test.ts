import { expect, it } from "vitest";
import { sidebarDropOperation } from "./organize-drag";
it("dropping on a category adds it without moving the message or removing a folder", () => {
  expect(sidebarDropOperation("category:Work", "INBOX")).toEqual({
    kind: "categories",
    add: ["Work"],
    remove: [],
  });
  expect(sidebarDropOperation("Folder", "category:Work")).toEqual({
    kind: "move",
    labelId: "Folder",
    removeLabelId: null,
  });
  expect(sidebarDropOperation("mailbox:snoozed", "INBOX")).toBeNull();
});

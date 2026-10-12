import { describe, expect, it } from "vitest";
import {
  EMPTY_SELECTION,
  settleStartupSelection,
  singleSelection,
  selectRow,
  selectAll,
  moveSelection,
  selectionAfterRemoval,
  batchScope,
  trimSelection,
  selectionForQuery,
  toggleFocused,
  moveCursor,
  checkingRows,
  requiresBatchDeleteConfirmation,
} from "./selection";

const rows = ["a", "b", "c", "d", "e", "f"];
describe("message selection", () => {
  it("toggles IDs with command-click, including deselecting the focused row", () => {
    let selection = selectRow(singleSelection("b"), rows, "e", { toggle: true });
    expect([...selection.ids]).toEqual(["b", "e"]);
    selection = selectRow(selection, rows, "e", { toggle: true });
    expect([...selection.ids]).toEqual(["b"]);
    expect(selection.focus).toBe("b");
    expect(selectRow(selection, rows, "c")).toEqual(singleSelection("c"));
  });
  it("shift-click ranges follow the anchor in either direction and command-shift adds", () => {
    const selection = selectRow(singleSelection("d"), rows, "b", { range: true });
    expect([...selection.ids]).toEqual(["b", "c", "d"]);
    expect(selection.anchor).toBe("d");
    expect([...selectRow(selection, rows, "f", { range: true }).ids]).toEqual(["d", "e", "f"]);
    expect([...selectRow(selection, rows, "f", { range: true, toggle: true }).ids]).toEqual([
      "b",
      "c",
      "d",
      "e",
      "f",
    ]);
  });
  it("shift arrows extend and contract, plain arrows collapse the range", () => {
    let selection = singleSelection("c");
    selection = moveSelection(selection, rows, 1, true);
    selection = moveSelection(selection, rows, 1, true);
    expect([...selection.ids]).toEqual(["c", "d", "e"]);
    selection = moveSelection(selection, rows, -1, true);
    expect([...selection.ids]).toEqual(["c", "d"]);
    expect(moveSelection(selection, rows, -1, false)).toEqual(singleSelection("c"));
    expect(moveSelection(singleSelection("a"), rows, -1, true)).toEqual(singleSelection("a"));
    expect(moveSelection(EMPTY_SELECTION, [], 1, true)).toBe(EMPTY_SELECTION);
  });
  it("retains stable IDs across keyset page growth, reorder and a replaced window", () => {
    const firstPage = Array.from({ length: 100 }, (_, i) => `m${i}`);
    const pages = Array.from({ length: 300 }, (_, i) => `m${i}`);
    const selection = selectAll(singleSelection("m99"), firstPage);
    const next = selectRow(selection, pages, "m299", { toggle: true });
    expect(next.ids.has("m99")).toBe(true);
    expect(next.ids.has("m299")).toBe(true);
    const replaced = pages.slice(200).toReversed();
    expect(selectAll(next, replaced).ids.has("m0")).toBe(false);
    const range = selectRow(next, firstPage, "m30", { range: true });
    expect(range.ids.has("m299")).toBe(true);
    expect(range.ids.has("m30")).toBe(true);
  });
  it("chooses beyond the whole removed range, with edge fallback or no selection", () => {
    const selection = selectRow(singleSelection("b"), rows, "d", { range: true });
    expect(selectionAfterRemoval(selection, rows, selection.ids, "below")).toEqual(
      singleSelection("e"),
    );
    expect(selectionAfterRemoval(selection, rows, selection.ids, "above")).toEqual(
      singleSelection("a"),
    );
    expect(selectionAfterRemoval(selection, rows, selection.ids, "none")).toBe(EMPTY_SELECTION);
    const tail = selectRow(singleSelection("e"), rows, "f", { range: true });
    expect(selectionAfterRemoval(tail, rows, tail.ids, "below")).toEqual(singleSelection("d"));
    const head = selectRow(singleSelection("a"), rows, "b", { range: true });
    expect(selectionAfterRemoval(head, rows, head.ids, "above")).toEqual(singleSelection("c"));
    const all = selectAll(EMPTY_SELECTION, rows);
    expect(selectionAfterRemoval(all, rows, all.ids, "below")).toBe(EMPTY_SELECTION);
  });
  it("preserves selected rows outside an account-specific operation or a context target", () => {
    const selection = selectAll(EMPTY_SELECTION, rows);
    expect([...selectionAfterRemoval(selection, rows, new Set(["b", "c"]), "below").ids]).toEqual([
      "a",
      "d",
      "e",
      "f",
    ]);
    expect(selectionAfterRemoval(singleSelection("a"), rows, new Set(["b"]), "none")).toEqual(
      singleSelection("a"),
    );
    expect(selectionAfterRemoval(EMPTY_SELECTION, rows, new Set(["b"]), "below")).toBe(
      EMPTY_SELECTION,
    );
  });
});

it("search/filter changes cannot keep hidden targets or add them back with select-all", () => {
  const inbox = Array.from({ length: 200 }, (_, index) => `m${index}`);
  const all = selectAll(EMPTY_SELECTION, inbox);
  const visible = inbox.slice(0, 5);
  const changed = selectionForQuery(all, "inbox", "search");
  expect(changed).toBe(EMPTY_SELECTION);
  const five = selectAll(changed, visible);
  expect([...five.ids]).toEqual(visible);
  expect(selectionForQuery(five, "search", "unread-filter")).toBe(EMPTY_SELECTION);
  expect([...trimSelection(all, new Set(visible)).ids]).toEqual(visible);
  expect([...selectAll(all, visible).ids]).toEqual(visible);
});

it("one visible row set determines loaded count, action IDs and delete confirmation", () => {
  const visible = new Map(
    rows.map((id) => [
      id,
      {
        id,
        accountId: "a",
        threadId: id,
        subject: id,
        from: { name: "", address: "" },
        date: 0,
        snippet: "",
        labels: [],
        isUnread: false,
        isStarred: false,
        hasAttachments: false,
        threadCount: 1,
        participants: [],
      },
    ]),
  );
  const selection = selectAll(EMPTY_SELECTION, [...rows, "hidden"]);
  const scope = batchScope(selection, visible);
  expect(scope.count).toBe(6);
  expect(scope.ids).toEqual(rows);
  expect(scope.rows.map((row) => row.id)).toEqual(scope.ids);
  expect(batchScope(selection, visible, "missing").count).toBe(0);
  expect(batchScope(selection, visible, undefined, "another-account").count).toBe(0);
  expect(requiresBatchDeleteConfirmation(50)).toBe(false);
  expect(requiresBatchDeleteConfirmation(51)).toBe(true);
});

it("selection after delete/archive follows the current ascending/descending sort order", () => {
  const ascending = ["old", "middle", "new"];
  const descending = ascending.toReversed();
  const removed = new Set(["middle"]);
  expect(selectionAfterRemoval(singleSelection("middle"), ascending, removed, "below").focus).toBe(
    "new",
  );
  expect(selectionAfterRemoval(singleSelection("middle"), descending, removed, "below").focus).toBe(
    "old",
  );
  expect(selectionAfterRemoval(singleSelection("middle"), ascending, removed, "above").focus).toBe(
    "old",
  );
  expect(selectionAfterRemoval(singleSelection("middle"), descending, removed, "above").focus).toBe(
    "new",
  );
});
it("removing the last loaded row waits for the next page instead of jumping upward", () => {
  const before = singleSelection("m99");
  const loaded = Array.from({ length: 100 }, (_, index) => `m${index}`);
  expect(selectionAfterRemoval(before, loaded, new Set(["m99"]), "below", true)).toBe(
    EMPTY_SELECTION,
  );
});

it("keeps a route's thread id while loading, then clears a missing id after the first list", () => {
  const selection = singleSelection("missing");
  expect(settleStartupSelection("missing", selection, false, new Set()).selection).toBe(selection);
  const settled = settleStartupSelection("missing", selection, true, new Set(["other"]));
  expect(settled.startupId).toBeNull();
  expect(settled.selection.ids.size).toBe(0);
});
it("releases a route's thread once a present message has loaded without losing selection", () => {
  const selection = singleSelection("present");
  expect(settleStartupSelection("present", selection, true, new Set(["present"]))).toEqual({
    startupId: null,
    selection,
  });
});

it("Gmail's X checks rows under a cursor that J and K move without clearing them", () => {
  // X on the open row unchecks it; the cursor stays there.
  let selection = toggleFocused(singleSelection("b"));
  expect([...selection.ids]).toEqual([]);
  expect(selection.focus).toBe("b");
  expect(checkingRows(selection)).toBe(true);
  selection = toggleFocused(selection);
  expect([...selection.ids]).toEqual(["b"]);
  expect(checkingRows(selection)).toBe(false);
  selection = toggleFocused(moveCursor(toggleFocused(selection), rows, 1));
  expect([...selection.ids]).toEqual(["c"]);
  selection = toggleFocused(moveCursor(moveCursor(selection, rows, 1), rows, 1));
  expect([...selection.ids]).toEqual(["c", "e"]);
  expect(checkingRows(selection)).toBe(true);
  selection = moveCursor(selection, rows, 1);
  expect(selection.focus).toBe("f");
  expect([...selection.ids]).toEqual(["c", "e"]);
  // The cursor survives list reconciliation while its row is visible.
  expect(trimSelection(selection, new Set(rows))).toBe(selection);
  expect(trimSelection(selection, new Set(["c", "e"])).focus).toBe("c");
  expect(moveCursor(selection, rows, 1).focus).toBe("f");
});

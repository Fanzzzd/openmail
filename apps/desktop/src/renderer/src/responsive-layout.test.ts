import { expect, it } from "vitest";
import { MEDIUM_MIN, PANE_MIN, WIDE_MIN } from "../../shared/layout";
import { isBackKey, layoutMode, visiblePanes } from "./responsive-layout";

it("picks the layout from the panes' minimum widths", () => {
  expect(WIDE_MIN).toBe(960);
  expect(MEDIUM_MIN).toBe(PANE_MIN.list + PANE_MIN.reader);
  expect(layoutMode(1600)).toBe("wide");
  expect(layoutMode(960)).toBe("wide");
  expect(layoutMode(959)).toBe("medium");
  expect(layoutMode(640)).toBe("medium");
  expect(layoutMode(639)).toBe("narrow");
  expect(layoutMode(480)).toBe("narrow");
});

it("shows both panes unless the window is narrow, and never a hidden reading pane", () => {
  const state = { readingPane: true, readerViewKey: null, viewKey: "inbox", selectedId: "a" };
  expect(visiblePanes("wide", state)).toEqual({ list: true, reader: true });
  expect(visiblePanes("medium", state)).toEqual({ list: true, reader: true });
  expect(visiblePanes("narrow", state)).toEqual({ list: true, reader: false });
  const opened = { ...state, readerViewKey: "inbox" };
  expect(visiblePanes("narrow", opened)).toEqual({ list: false, reader: true });
  // Another view, or no selection left, returns to the list.
  expect(visiblePanes("narrow", { ...opened, viewKey: "sent" })).toEqual({
    list: true,
    reader: false,
  });
  expect(visiblePanes("narrow", { ...opened, selectedId: null })).toEqual({
    list: true,
    reader: false,
  });
  expect(visiblePanes("wide", { ...opened, readingPane: false })).toEqual({
    list: true,
    reader: false,
  });
});

it("goes back on Escape and Cmd+[ only", () => {
  const key = (
    k: string,
    mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {},
  ) =>
    isBackKey({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
  expect(key("Escape")).toBe(true);
  expect(key("[", { metaKey: true })).toBe(true);
  expect(key("[")).toBe(false);
  expect(key("[", { metaKey: true, shiftKey: true })).toBe(false);
  expect(key("Escape", { metaKey: true })).toBe(false);
  expect(key("ArrowLeft")).toBe(false);
});

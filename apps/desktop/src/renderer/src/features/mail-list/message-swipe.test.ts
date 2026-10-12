import { afterEach, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { DEFAULT_PREFS } from "@openmail/core/schema";
import { attachMessageSwipe, swipeAction, swipeMailOp } from "./message-swipe";

afterEach(() => vi.useRealTimers());
it("short and long thresholds use independent actions in each direction", () => {
  const actions = {
    leftShort: "star",
    leftLong: "snooze",
    rightShort: "archive",
    rightLong: "trash",
  } as const;
  expect(
    [-59, -60, -179, -180, 59, 60, 179, 180].map((distance) => swipeAction(distance, actions)),
  ).toEqual(["none", "star", "star", "snooze", "none", "archive", "archive", "trash"]);
  expect(swipeAction(300, { ...actions, rightLong: "none" })).toBe("none");
  expect(swipeMailOp("read", { isUnread: false, isStarred: true })).toEqual({
    kind: "read",
    value: false,
  });
  expect(swipeMailOp("star", { isUnread: true, isStarred: true })).toEqual({
    kind: "star",
    value: false,
  });
});
it("native wheel events settle once, retain vertical scrolling and pinch zoom, and cleanup cancels pending work", () => {
  vi.useFakeTimers();
  const { document } = parseHTML("<button></button>");
  const row = document.querySelector("button");
  const view = document.defaultView;
  if (!view) throw new Error("Missing test window");
  expect(row).not.toBeNull();
  if (!row) return;
  const commit = vi.fn(),
    preview = vi.fn();
  const detach = attachMessageSwipe(row, { actions: DEFAULT_PREFS.swipeActions, preview, commit });
  const wheel = (deltaX: number, deltaY = 0, ctrlKey = false) => {
    const event = new view.Event("wheel", { cancelable: true });
    Object.defineProperties(event, {
      deltaX: { value: deltaX },
      deltaY: { value: deltaY },
      deltaMode: { value: 0 },
      ctrlKey: { value: ctrlKey },
    });
    row.dispatchEvent(event);
    return event;
  };
  expect(wheel(30).defaultPrevented).toBe(true);
  wheel(40);
  vi.advanceTimersByTime(179);
  expect(commit).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(commit.mock.calls).toEqual([["archive"]]);
  wheel(-90);
  wheel(-100);
  vi.advanceTimersByTime(180);
  expect(commit.mock.calls).toEqual([["archive"], ["star"]]);
  expect(wheel(5, 50).defaultPrevented).toBe(false);
  wheel(150, 1);
  vi.advanceTimersByTime(180);
  expect(wheel(300, 0, true).defaultPrevented).toBe(false);
  vi.advanceTimersByTime(180);
  expect(commit).toHaveBeenCalledTimes(2);
  wheel(80);
  detach();
  vi.advanceTimersByTime(180);
  expect(commit).toHaveBeenCalledTimes(2);
  wheel(200);
  vi.advanceTimersByTime(180);
  expect(commit).toHaveBeenCalledTimes(2);
});

it("waits for dominant movement, ignores line/shift scrolling and accumulates all accepted pixels", () => {
  vi.useFakeTimers();
  const { document } = parseHTML("<button></button>"),
    view = document.defaultView,
    row = document.querySelector("button");
  if (!row || !view) throw new Error("Missing wheel test fixture");
  const commit = vi.fn(),
    preview = vi.fn();
  const detach = attachMessageSwipe(row, { actions: DEFAULT_PREFS.swipeActions, preview, commit });
  const wheel = (deltaX: number, deltaY = 0, deltaMode = 0, shiftKey = false) => {
    const e = new view.Event("wheel", { cancelable: true });
    Object.defineProperties(e, {
      deltaX: { value: deltaX },
      deltaY: { value: deltaY },
      deltaMode: { value: deltaMode },
      shiftKey: { value: shiftKey },
    });
    row.dispatchEvent(e);
    return e;
  };
  expect(wheel(2, 1).defaultPrevented).toBe(false);
  wheel(0, 30);
  wheel(60, 0);
  vi.advanceTimersByTime(180);
  expect(commit).not.toHaveBeenCalled();
  wheel(80, 0, 1);
  wheel(80, 0, 0, true);
  vi.advanceTimersByTime(180);
  expect(commit).not.toHaveBeenCalled();
  wheel(35);
  wheel(45);
  wheel(40);
  wheel(35);
  wheel(30);
  wheel(25);
  wheel(20);
  vi.advanceTimersByTime(180);
  expect(commit.mock.calls).toEqual([["trash"]]);
  wheel(80);
  detach();
  expect(preview).toHaveBeenLastCalledWith(0, "none");
});

it("dragging back before release cancels even after crossing the short or long threshold", () => {
  vi.useFakeTimers();
  const { document } = parseHTML("<button></button>"),
    row = document.querySelector("button"),
    view = document.defaultView;
  if (!row || !view) throw new Error("Missing wheel fixture");
  const commit = vi.fn();
  const detach = attachMessageSwipe(row, {
    actions: DEFAULT_PREFS.swipeActions,
    preview: vi.fn(),
    commit,
  });
  const wheel = (deltaX: number) => {
    const e = new view.Event("wheel", { cancelable: true });
    Object.defineProperties(e, {
      deltaX: { value: deltaX },
      deltaY: { value: 0 },
      deltaMode: { value: 0 },
    });
    row.dispatchEvent(e);
  };
  wheel(100);
  wheel(-80);
  vi.advanceTimersByTime(180);
  expect(commit).not.toHaveBeenCalled();
  wheel(100);
  wheel(110);
  wheel(-100);
  wheel(-110);
  vi.advanceTimersByTime(180);
  expect(commit).not.toHaveBeenCalled();
  wheel(40);
  wheel(50);
  wheel(40);
  wheel(-80);
  vi.advanceTimersByTime(180);
  expect(commit).not.toHaveBeenCalled();
  detach();
});

it("trackpad jitter accumulates the full swipe and an easing swipe back reaches zero", () => {
  vi.useFakeTimers();
  const { document } = parseHTML("<button></button>"),
    row = document.querySelector("button"),
    view = document.defaultView;
  if (!row || !view) throw new Error("Missing trackpad fixture");
  const commit = vi.fn(),
    preview = vi.fn();
  const detach = attachMessageSwipe(row, { actions: DEFAULT_PREFS.swipeActions, preview, commit });
  const wheel = (deltaX: number) => {
    const event = new view.Event("wheel", { cancelable: true });
    Object.defineProperties(event, {
      deltaX: { value: deltaX },
      deltaY: { value: 0 },
      deltaMode: { value: 0 },
    });
    row.dispatchEvent(event);
  };
  for (const delta of [11, 8, 15, 9, 17, 12, 20, 14, 25, 19, 30, 20]) wheel(delta);
  expect(preview).toHaveBeenLastCalledWith(-200, "trash");
  vi.advanceTimersByTime(180);
  expect(commit.mock.calls).toEqual([["trash"]]);
  commit.mockClear();
  for (const delta of [45, 45, 45, -45, -35, -25, -20, -10]) wheel(delta);
  expect(preview).toHaveBeenLastCalledWith(0, "none");
  vi.advanceTimersByTime(180);
  expect(commit).not.toHaveBeenCalled();
  detach();
});

it("ignores wheel swipes while the window is in the background", () => {
  vi.useFakeTimers();
  const { document } = parseHTML("<button></button>");
  const row = document.querySelector("button");
  const view = document.defaultView;
  if (!view || !row) throw new Error("Missing test row");
  let focused = false;
  Object.defineProperty(document, "hasFocus", { value: () => focused, configurable: true });
  const commit = vi.fn(),
    preview = vi.fn();
  attachMessageSwipe(row, { actions: DEFAULT_PREFS.swipeActions, preview, commit });
  const wheel = (deltaX: number) => {
    const event = new view.Event("wheel", { cancelable: true });
    Object.defineProperties(event, {
      deltaX: { value: deltaX },
      deltaY: { value: 0 },
      deltaMode: { value: 0 },
    });
    row.dispatchEvent(event);
    return event;
  };
  // A long left swipe trashes by default; in the background it does nothing.
  expect(wheel(150).defaultPrevented).toBe(false);
  wheel(150);
  vi.advanceTimersByTime(500);
  expect(commit).not.toHaveBeenCalled();
  // Focus lost mid-gesture cancels it.
  focused = true;
  wheel(150);
  focused = false;
  wheel(150);
  vi.advanceTimersByTime(500);
  expect(commit).not.toHaveBeenCalled();
  focused = true;
  wheel(150);
  wheel(150);
  vi.advanceTimersByTime(180);
  expect(commit.mock.calls).toEqual([["trash"]]);
});

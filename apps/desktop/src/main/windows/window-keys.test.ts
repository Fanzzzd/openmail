import { afterAll, beforeEach, expect, it, vi } from "vitest";
const controls = vi.hoisted(() => {
  vi.resetModules();
  const make = (id: number, visible = true, minimized = false, destroyed = false) => ({
    id,
    isVisible: () => visible,
    isMinimized: () => minimized,
    isDestroyed: () => destroyed,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    isFullScreen: () => false,
    setFullScreen: vi.fn(),
  });
  return { make, windows: [make(1), make(2)], current: 1, main: vi.fn(), tab: vi.fn() };
});
vi.mock("electron", () => ({
  app: { isPackaged: true },
  BrowserWindow: { getAllWindows: () => controls.windows },
  Menu: { sendActionToFirstResponder: controls.tab },
}));
vi.mock("./windows", () => ({
  focusMainWindow: controls.main,
  windowOf: () => controls.windows.find((win) => win.id === controls.current),
}));
import { nativeTabMenu, switchWindow } from "./window-keys";
afterAll(() => {
  vi.doUnmock("electron");
  vi.doUnmock("./windows");
  vi.resetModules();
});
beforeEach(() => {
  controls.windows = [controls.make(1), controls.make(2)];
  controls.current = 1;
  controls.main.mockClear();
});
it("next/previous window restore minimized windows, skip hidden helpers and wrap", () => {
  const minimized = controls.make(3, false, true);
  controls.windows.push(controls.make(99, false), minimized, controls.make(100, true, false, true));
  switchWindow(1, "previousWindow");
  expect(minimized.restore).toHaveBeenCalledOnce();
  expect(minimized.focus).toHaveBeenCalledOnce();
  switchWindow(1, "nextWindow");
  expect(controls.windows[1]?.focus).toHaveBeenCalledOnce();
  controls.current = 3;
  switchWindow(1, "nextWindow");
  expect(controls.windows[0]?.focus).toHaveBeenCalledOnce();
});
it("focus main uses the main-window owner instead of cycling reader windows", () => {
  switchWindow(1, "focusMainWindow");
  expect(controls.main).toHaveBeenCalledOnce();
  expect(controls.windows.every((win) => win.focus.mock.calls.length === 0)).toBe(true);
});

it("full screen affects the requesting window and native tabs use the central keymap", () => {
  switchWindow(1, "toggleFullScreen");
  expect(controls.windows[0]?.setFullScreen).toHaveBeenCalledWith(true);
  if (process.platform === "darwin") {
    switchWindow(1, "nextTab");
    switchWindow(1, "previousTab");
    expect(controls.tab).toHaveBeenCalledWith("selectNextTab:");
    expect(controls.tab).toHaveBeenCalledWith("selectPreviousTab:");
    expect(nativeTabMenu("gmail")).toContainEqual({
      role: "selectNextTab",
      accelerator: "Alt+CommandOrControl+Right",
    });
  } else expect(nativeTabMenu("gmail")).toEqual([]);
});

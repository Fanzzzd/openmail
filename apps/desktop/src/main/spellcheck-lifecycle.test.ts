import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: new EventEmitter(),
  BrowserWindow: { getAllWindows: () => [] },
  Menu: {},
}));
import { app } from "electron";
import type { DesktopLabels } from "../shared/desktop-labels";
import { installSpellingMenu } from "./spellcheck";

it("closed windows release their spelling listener and cleanup closure", () => {
  const stop = installSpellingMenu(vi.fn<() => DesktopLabels["spelling"]>(), vi.fn());
  const checked = vi.fn(() => false);
  for (let i = 0; i < 1000; i++) {
    const win = Object.assign(new EventEmitter(), {
      webContents: new EventEmitter(),
      isDestroyed: checked,
    });
    app.emit("browser-window-created", undefined, win);
    expect(win.webContents.listenerCount("context-menu")).toBe(1);
    win.emit("closed");
    expect(win.webContents.listenerCount("context-menu")).toBe(0);
    expect(win.listenerCount("closed")).toBe(0);
  }
  checked.mockClear();
  stop();
  // The old array retained 1,000 closures and revisited every closed window.
  expect(checked).not.toHaveBeenCalled();
  expect(app.listenerCount("browser-window-created")).toBe(0);
});

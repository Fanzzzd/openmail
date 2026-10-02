import { BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";
import { focusMainWindow, windowOf } from "./windows";
import { shortcutAccelerator, type ShortcutSet } from "../shared/shortcuts";
import { adjacentWindowId } from "../shared/window-keys";

export function switchWindow(
  clientId: number,
  action:
    | "nextWindow"
    | "previousWindow"
    | "focusMainWindow"
    | "toggleFullScreen"
    | "nextTab"
    | "previousTab",
): void {
  if (action === "nextTab" || action === "previousTab") {
    if (process.platform === "darwin") {
      const win = windowOf(clientId);
      if (!win || win.isDestroyed()) return;
      win.focus();
      Menu.sendActionToFirstResponder(
        action === "nextTab" ? "selectNextTab:" : "selectPreviousTab:",
      );
    }
    return;
  }
  if (action === "toggleFullScreen") {
    const win = windowOf(clientId);
    if (win && !win.isDestroyed()) win.setFullScreen(!win.isFullScreen());
    return;
  }
  if (action === "focusMainWindow") {
    focusMainWindow();
    return;
  }
  const windows = BrowserWindow.getAllWindows().filter(
    (win) => !win.isDestroyed() && (win.isVisible() || win.isMinimized()),
  );
  const id = adjacentWindowId(
    windows.map((win) => win.id),
    windowOf(clientId)?.id ?? null,
    action === "nextWindow" ? 1 : -1,
  );
  const win = windows.find((item) => item.id === id);
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

export function nativeTabMenu(set: ShortcutSet): MenuItemConstructorOptions[] {
  return process.platform === "darwin"
    ? [
        { role: "toggleTabBar" },
        { role: "selectNextTab", accelerator: shortcutAccelerator(set, "nextTab") },
        { role: "selectPreviousTab", accelerator: shortcutAccelerator(set, "previousTab") },
        { role: "mergeAllWindows" },
        { role: "moveTabToNewWindow" },
      ]
    : [];
}

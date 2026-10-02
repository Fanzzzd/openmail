import { BrowserWindow } from "electron";
import { focusMainWindow, windowOf } from "./windows";
import { adjacentWindowId } from "../shared/window-keys";

export function switchWindow(
  clientId: number,
  action: "nextWindow" | "previousWindow" | "focusMainWindow",
): void {
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

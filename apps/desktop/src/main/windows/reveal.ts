import { app, type BrowserWindow, type Notification } from "electron";

/**
 * How a development build puts its windows on screen. Automated runs must not disturb the person
 * at the keyboard:
 *
 * - `hidden` (OPENMAIL_HIDDEN_WINDOWS=1): windows are created, load and paint, but are never
 *   shown or focused, and notifications are not posted. A harness drives the renderer over CDP.
 * - `background` (OPENMAIL_BACKGROUND_WINDOWS=1): windows appear behind the active app without
 *   taking focus. They are still on screen, so harnesses that need a visible window run on a
 *   virtual display (see docs/testing.md#windows-in-automated-runs).
 *
 * Packaged builds ignore both variables. Every show, focus, maximize or full-screen call in the
 * main process goes through this module so a mode cannot be bypassed.
 */
export type WindowMode = "normal" | "background" | "hidden";

export function windowMode(): WindowMode {
  if (app.isPackaged) return "normal";
  if (process.env.OPENMAIL_HIDDEN_WINDOWS === "1") return "hidden";
  if (process.env.OPENMAIL_BACKGROUND_WINDOWS === "1") return "background";
  return "normal";
}

/** Windows never take focus: true in both the background and the hidden mode. */
export const backgroundWindows = () => windowMode() !== "normal";

/** Windows are never shown. */
export const hiddenWindows = () => windowMode() === "hidden";

/**
 * On macOS a background or hidden run is an accessory app: no Dock icon, and the system does not
 * activate it when a window appears. Call before the app is ready.
 */
export function prepareBackgroundWindows() {
  if (backgroundWindows() && process.platform === "darwin") app.setActivationPolicy("accessory");
}

/** Shows `win`, without focus while background windows are on, and not at all when hidden. */
export function revealWindow(win: BrowserWindow) {
  const mode = windowMode();
  if (mode === "hidden") return;
  if (mode === "background") win.showInactive();
  else win.show();
}

/** Shows and focuses `win`; background windows only show, inactive, and hidden ones do neither. */
export function revealAndFocus(win: BrowserWindow) {
  const mode = windowMode();
  if (mode === "hidden") return;
  if (mode === "background") {
    win.showInactive();
    return;
  }
  win.show();
  win.focus();
}

/** Focuses `win` when windows may take focus. */
export function focusWindow(win: BrowserWindow) {
  if (!backgroundWindows()) win.focus();
}

/** Maximizes `win`. Electron shows a hidden window to maximize it, so a hidden run skips it. */
export function maximizeWindow(win: BrowserWindow) {
  if (!hiddenWindows()) win.maximize();
}

/** Enters or leaves full screen, which also shows the window; a hidden run skips it. */
export function setWindowFullScreen(win: BrowserWindow, on: boolean) {
  if (!hiddenWindows()) win.setFullScreen(on);
}

/** Adds `tab` to `win`'s tab group, which orders the tab in; a hidden run keeps it separate. */
export function addWindowTab(win: BrowserWindow, tab: BrowserWindow) {
  if (!hiddenWindows()) win.addTabbedWindow(tab);
}

/** Posts `notification`. A hidden run posts nothing: a banner would appear on the screen. */
export function showNotification(notification: Notification) {
  if (!hiddenWindows()) notification.show();
}

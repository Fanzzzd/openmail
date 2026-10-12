import { app, type BrowserWindow } from "electron";

/**
 * Development harnesses (screenshots, smoke runs) set OPENMAIL_BACKGROUND_WINDOWS=1 so the app
 * never takes focus from the person at the keyboard: windows appear behind the active app, and
 * stray keys or trackpad swipes keep going to what they were using. Packaged builds ignore it.
 */
export function backgroundWindows(): boolean {
  return !app.isPackaged && process.env.OPENMAIL_BACKGROUND_WINDOWS === "1";
}

/**
 * On macOS a background run is an accessory app: no Dock icon, and the system does not activate
 * it when its first window appears. Call before the app is ready.
 */
export function prepareBackgroundWindows() {
  if (backgroundWindows() && process.platform === "darwin") app.setActivationPolicy("accessory");
}

/** Shows `win`, without focus while background windows are on. */
export function revealWindow(win: BrowserWindow) {
  if (backgroundWindows()) win.showInactive();
  else win.show();
}

/** Shows and focuses `win`; with background windows on it only shows it, inactive. */
export function revealAndFocus(win: BrowserWindow) {
  if (backgroundWindows()) {
    win.showInactive();
    return;
  }
  win.show();
  win.focus();
}

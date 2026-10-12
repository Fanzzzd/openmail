/**
 * The traffic lights' vertical position. A window's renderer reports the
 * height of the header row the lights sit in, and main centres the buttons
 * in it. The renderer reads the buttons' real bounds back through the Window
 * Controls Overlay API, which `titleBarOverlay` turns on.
 */
import type { BrowserWindow } from "electron";

import { TITLEBAR_HEIGHT, trafficLightPosition } from "../../shared/window-chrome";

/** What window-chrome needs of a BrowserWindow. */
export type ChromeWindow = Pick<BrowserWindow, "isDestroyed" | "setWindowButtonPosition"> & {
  webContents: Pick<BrowserWindow["webContents"], "getZoomFactor">;
};

/** macOS window options: a hidden title bar, the lights centred in the default header. */
export const trafficLightOptions = () => ({
  titleBarStyle: "hiddenInset" as const,
  // `true`, not a height: a numeric height misplaces the buttons on macOS 26 (electron#49183).
  titleBarOverlay: true,
  trafficLightPosition: trafficLightPosition(TITLEBAR_HEIGHT),
});

const placed = new WeakMap<ChromeWindow, string>();

/** Centres the lights in a header row `height` CSS pixels tall. */
export function setTitlebarHeight(
  win: ChromeWindow | null,
  height: number,
  mac = process.platform === "darwin",
) {
  if (!mac || !win || win.isDestroyed()) return;
  const position = trafficLightPosition(height, win.webContents.getZoomFactor());
  const key = `${position.x},${position.y}`;
  if (placed.get(win) === key) return;
  placed.set(win, key);
  win.setWindowButtonPosition(position);
}

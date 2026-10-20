import type { BrowserWindow, Notification } from "electron";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktopRoot } from "../../renderer/src/test-support/paths";

const electron = vi.hoisted(() => {
  const trays: unknown[] = [];
  return {
    app: { isPackaged: false, setActivationPolicy: vi.fn() },
    dialog: { showErrorBox: vi.fn() },
    trays,
    Tray: class {
      constructor(readonly icon: unknown) {
        trays.push(this);
      }
    },
  };
});
vi.mock("electron", () => electron);

import {
  addWindowTab,
  createTray,
  focusWindow,
  hiddenWindows,
  maximizeWindow,
  prepareBackgroundWindows,
  revealAndFocus,
  revealWindow,
  setWindowFullScreen,
  showNotification,
  showStartupError,
  windowMode,
} from "./reveal";

const fakeWindow = () => ({
  show: vi.fn(),
  showInactive: vi.fn(),
  focus: vi.fn(),
  maximize: vi.fn(),
  setFullScreen: vi.fn(),
  addTabbedWindow: vi.fn(),
});
type FakeWindow = ReturnType<typeof fakeWindow>;
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double for BrowserWindow
const asWindow = (win: FakeWindow) => win as unknown as BrowserWindow;

/** Every reveal.ts entry point on fresh windows; returns the calls each window received. */
function exercise() {
  const win = fakeWindow();
  const tab = fakeWindow();
  const notification = { show: vi.fn() };
  revealWindow(asWindow(win));
  revealAndFocus(asWindow(win));
  focusWindow(asWindow(win));
  maximizeWindow(asWindow(win));
  setWindowFullScreen(asWindow(win), true);
  addWindowTab(asWindow(win), asWindow(tab));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double for Notification
  showNotification(notification as unknown as Notification);
  return { win, notification };
}

beforeEach(() => {
  electron.app.isPackaged = false;
  electron.app.setActivationPolicy.mockClear();
  electron.dialog.showErrorBox.mockClear();
  electron.trays.length = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

it("hidden windows are never shown or focused, and post no notifications", () => {
  vi.stubEnv("OPENMAIL_HIDDEN_WINDOWS", "1");
  // The hidden mode wins over the background mode.
  vi.stubEnv("OPENMAIL_BACKGROUND_WINDOWS", "1");
  expect(windowMode()).toBe("hidden");
  const { win, notification } = exercise();
  for (const call of Object.values(win)) expect(call).not.toHaveBeenCalled();
  expect(notification.show).not.toHaveBeenCalled();
  prepareBackgroundWindows();
  if (process.platform === "darwin")
    expect(electron.app.setActivationPolicy).toHaveBeenCalledWith("accessory");
});

it("background windows show inactive and never take focus", () => {
  vi.stubEnv("OPENMAIL_BACKGROUND_WINDOWS", "1");
  expect(windowMode()).toBe("background");
  const { win, notification } = exercise();
  expect(win.showInactive).toHaveBeenCalledTimes(2);
  expect(win.show).not.toHaveBeenCalled();
  expect(win.focus).not.toHaveBeenCalled();
  expect(win.maximize).toHaveBeenCalled();
  expect(notification.show).toHaveBeenCalled();
});

it("packaged builds ignore both variables", () => {
  electron.app.isPackaged = true;
  vi.stubEnv("OPENMAIL_HIDDEN_WINDOWS", "1");
  vi.stubEnv("OPENMAIL_BACKGROUND_WINDOWS", "1");
  expect(windowMode()).toBe("normal");
  expect(hiddenWindows()).toBe(false);
  const { win, notification } = exercise();
  expect(win.show).toHaveBeenCalledTimes(2);
  expect(win.focus).toHaveBeenCalledTimes(2);
  expect(win.showInactive).not.toHaveBeenCalled();
  expect(win.maximize).toHaveBeenCalled();
  expect(win.setFullScreen).toHaveBeenCalledWith(true);
  expect(win.addTabbedWindow).toHaveBeenCalled();
  expect(notification.show).toHaveBeenCalled();
  prepareBackgroundWindows();
  expect(electron.app.setActivationPolicy).not.toHaveBeenCalled();
});

it("a development build without either variable shows and focuses as usual", () => {
  vi.stubEnv("OPENMAIL_HIDDEN_WINDOWS", "");
  vi.stubEnv("OPENMAIL_BACKGROUND_WINDOWS", "");
  expect(windowMode()).toBe("normal");
  const { win } = exercise();
  expect(win.show).toHaveBeenCalledTimes(2);
  expect(win.focus).toHaveBeenCalledTimes(2);
});

it("a hidden run has no menu-bar icon; other modes create it", () => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double for NativeImage
  const icon = vi.fn(() => ({}) as Electron.NativeImage);
  vi.stubEnv("OPENMAIL_HIDDEN_WINDOWS", "1");
  expect(createTray(icon)).toBeUndefined();
  expect(icon).not.toHaveBeenCalled();
  expect(electron.trays).toEqual([]);
  vi.stubEnv("OPENMAIL_HIDDEN_WINDOWS", "");
  vi.stubEnv("OPENMAIL_BACKGROUND_WINDOWS", "1");
  expect(createTray(icon)).toBeDefined();
  expect(electron.trays).toHaveLength(1);
});

it("a hidden run writes a startup error to stderr instead of a native error box", () => {
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    vi.stubEnv("OPENMAIL_HIDDEN_WINDOWS", "1");
    showStartupError("Not enough space", "Free 12 MB");
    expect(electron.dialog.showErrorBox).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith("Not enough space\nFree 12 MB\n");
    stderr.mockClear();
    vi.stubEnv("OPENMAIL_HIDDEN_WINDOWS", "");
    showStartupError("Not enough space", "Free 12 MB");
    expect(electron.dialog.showErrorBox).toHaveBeenCalledWith("Not enough space", "Free 12 MB");
    expect(stderr).not.toHaveBeenCalled();
  } finally {
    stderr.mockRestore();
  }
});

/** Main-process sources, without tests and the standalone Electron test drivers. */
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
  });
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

it("only reveal.ts shows, focuses, maximizes or activates windows in the main process", () => {
  const main = path.join(desktopRoot, "src/main");
  const pattern =
    /\.(show|showInactive|focus|maximize|setFullScreen|addTabbedWindow|moveTop)\(|\bapp\.(focus|show)\(|\bdock\??\.show\(/;
  const found = sources(main)
    .filter((file) => path.basename(file) !== "reveal.ts")
    .filter((file) => pattern.test(code(readFileSync(file, "utf8"))))
    .map((file) => path.relative(main, file));
  expect(found).toEqual([]);
});

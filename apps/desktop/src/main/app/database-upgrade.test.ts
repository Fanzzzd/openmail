import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  windows: new Set<object>(),
  load: vi.fn(async (_url: string) => {
    /* The local page loads immediately; window lifetime uses real events below. */
  }),
  show: vi.fn(),
  quit: vi.fn(),
  options: undefined as unknown,
  openHandler: undefined as (() => unknown) | undefined,
  contents: undefined as EventEmitter | undefined,
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  const app = Object.assign(new EventEmitter(), { quit: state.quit, isPackaged: true });
  class Window extends EventEmitter {
    static getAllWindows() {
      return [...state.windows];
    }
    private destroyed = false;
    webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: (handler: () => unknown) => {
        state.openHandler = handler;
      },
    });
    constructor(options: unknown) {
      super();
      state.windows.add(this);
      state.options = options;
      state.contents = this.webContents;
      app.emit("browser-window-created", undefined, this);
    }
    loadURL = state.load;
    show = state.show;
    isDestroyed = () => this.destroyed;
    close() {
      this.destroy();
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      state.windows.delete(this);
      this.emit("closed");
      // Electron's documented default: no window-all-closed listener means quit.
      if (!state.windows.size && !app.emit("window-all-closed")) app.quit();
    }
  }
  return { app, BrowserWindow: Window };
});
vi.mock("./native-i18n", () => ({
  nativeRecoveryLabels: async () => ({ upgrading: "Upgrading <local> database…" }),
}));

beforeEach(async () => {
  vi.resetModules();
  const { app } = await import("electron");
  app.removeAllListeners();
  state.windows.clear();
  vi.clearAllMocks();
});
afterEach(async () => {
  const { app } = await import("electron");
  app.removeAllListeners();
  state.windows.clear();
});

it("paints a sandboxed upgrade state before returning its cleanup callback", async () => {
  const { showDatabaseUpgrade } = await import("./database-upgrade");
  const dismiss = await showDatabaseUpgrade();
  expect(state.options).toMatchObject({
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
  });
  expect(state.show).toHaveBeenCalledOnce();
  const html = decodeURIComponent(state.load.mock.calls[0]?.[0] ?? "");
  expect(html).toContain("Upgrading &lt;local&gt; database…");
  expect(html).toContain("default-src 'none'");
  expect(html).toContain('role="progressbar"');
  dismiss();
  expect(state.windows.size).toBe(0);
});

it("uses the shared window hardening and denies drops, redirects, frames, popups and webviews", async () => {
  const { WINDOW_SECURITY } = await import("../security/security-policy");
  const { showDatabaseUpgrade } = await import("./database-upgrade");
  await showDatabaseUpgrade();
  expect(state.options).toMatchObject({
    webPreferences: { ...WINDOW_SECURITY, javascript: false, spellcheck: false, devTools: false },
  });
  const contents = state.contents;
  if (!contents) throw new Error("Missing upgrade window");
  for (const name of [
    "will-navigate",
    "will-redirect",
    "will-frame-navigate",
    "will-attach-webview",
  ]) {
    const event = { preventDefault: vi.fn() };
    contents.emit(name, event);
    expect(event.preventDefault, name).toHaveBeenCalledOnce();
  }
  expect(state.openHandler?.()).toEqual({ action: "deny" });
});

it("default window closure quits without a listener, but dismissing the upgrade must not quit", async () => {
  const { app, BrowserWindow } = await import("electron");
  const control = new BrowserWindow();
  control.close();
  expect(state.quit).toHaveBeenCalledOnce();
  state.quit.mockClear();
  const { showDatabaseUpgrade } = await import("./database-upgrade");
  const dismiss = await showDatabaseUpgrade();
  dismiss();
  expect(state.windows.size).toBe(0);
  expect(state.quit).not.toHaveBeenCalled();
  expect(app.listenerCount("window-all-closed")).toBe(1);
});

it("manually closing the upgrade window does not quit or interrupt pending migration work", async () => {
  const { BrowserWindow, app } = await import("electron");
  const { showDatabaseUpgrade } = await import("./database-upgrade");
  const dismiss = await showDatabaseUpgrade();
  const interrupted = vi.fn();
  app.on("will-quit", interrupted);
  const progress = new EventEmitter();
  const completed = new Promise<string>((resolve) => {
    progress.once("committed", resolve);
  });
  BrowserWindow.getAllWindows()[0]?.close();
  expect(state.quit).not.toHaveBeenCalled();
  expect(interrupted).not.toHaveBeenCalled();
  progress.emit("committed", "committed");
  expect(await completed).toBe("committed");
  dismiss();
  expect(state.quit).not.toHaveBeenCalled();
});

it("keeps the temporary listener until DesktopLive has a main window and its own listener", async () => {
  const { app, BrowserWindow } = await import("electron");
  const { showDatabaseUpgrade, finishDatabaseUpgradeStartup } = await import("./database-upgrade");
  const dismiss = await showDatabaseUpgrade();
  dismiss();
  expect(state.quit).not.toHaveBeenCalled();
  const desktopClosed = vi.fn();
  app.on("window-all-closed", desktopClosed);
  const main = new BrowserWindow();
  finishDatabaseUpgradeStartup();
  finishDatabaseUpgradeStartup();
  expect(app.listenerCount("window-all-closed")).toBe(1);
  expect(app.listenerCount("will-quit")).toBe(0);
  main.close();
  expect(desktopClosed).toHaveBeenCalledOnce();
  expect(state.quit).not.toHaveBeenCalled();
});

it("cleans the upgrade hold on an explicit quit", async () => {
  const { app } = await import("electron");
  const { showDatabaseUpgrade } = await import("./database-upgrade");
  await showDatabaseUpgrade();
  app.emit("will-quit");
  expect(app.listenerCount("window-all-closed")).toBe(0);
  expect(app.listenerCount("will-quit")).toBe(0);
});

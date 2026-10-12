import type { BrowserWindowConstructorOptions } from "electron";

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { windowStateFile } from "./window-state";
const native = vi.hoisted(() => ({ options: new Array<unknown>(), reload: vi.fn(), next: 0 }));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true,
    getPreferredSystemLanguages: () => ["en"],
    getLocale: () => "en",
  });
  class Window extends EventEmitter {
    static all: Window[] = [];
    static getAllWindows = () => Window.all;
    static getFocusedWindow = () => Window.all.at(-1) ?? null;
    dead = false;
    show = vi.fn();
    focus = vi.fn();
    webContents = Object.assign(new EventEmitter(), {
      id: ++native.next,
      setWindowOpenHandler: vi.fn(),
      reload: native.reload,
    });
    constructor(readonly options: BrowserWindowConstructorOptions) {
      super();
      Window.all.push(this);
      native.options.push(options);
    }
    getNormalBounds() {
      return {
        x: this.options.x ?? 0,
        y: this.options.y ?? 24,
        width: this.options.width ?? 800,
        height: this.options.height ?? 600,
      };
    }
    isMaximized() {
      return false;
    }
    isMinimized() {
      return false;
    }
    restore() {
      this.show();
    }
    isDestroyed() {
      return this.dead;
    }
    loadFile = vi.fn(async () => true);
    loadURL = vi.fn(async () => true);
    close() {
      const event = {
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      this.emit("close", event);
      if (!event.defaultPrevented && !this.dead) {
        this.dead = true;
        this.emit("closed");
        Window.all = Window.all.filter((w) => w !== this);
      }
    }
  }
  return {
    app,
    BrowserWindow: Window,
    nativeTheme: { shouldUseDarkColors: false },
    screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 24, width: 1920, height: 1056 } }] },
    shell: { openExternal: vi.fn() },
  };
});
const dirs: string[] = [];
beforeEach(() => {
  vi.resetModules();
  native.options.length = 0;
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});
function file() {
  const dir = mkdtempSync(join(tmpdir(), "openmail-window-safety-"));
  dirs.push(dir);
  return join(dir, "windows.json");
}
it("retains the last main route when the last window closes before Quit", async () => {
  const w = await import("./windows");
  const state = file();
  w.configureWindowRecovery(state, () => false);
  const main = w.createMainWindow();
  w.setWindowRoute(main, "/mail/work/sent?thread=m");
  main.close();
  expect(windowStateFile(state).read()[0]?.href).toBe("/mail/work/sent?thread=m");
  expect(windowStateFile(state).read()).toHaveLength(1);
});
it("safe mode ignores all saved windows and selection", async () => {
  const state = file();
  windowStateFile(state).write([
    {
      key: "old",
      kind: "main",
      bounds: { x: 50, y: 50, width: 960, height: 700 },
      maximized: false,
      selection: { space: "work", mailbox: "sent", messageId: "m" },
    },
    {
      key: "draft",
      kind: "compose",
      target: "draft-1",
      bounds: { x: 50, y: 50, width: 600, height: 700 },
      maximized: false,
    },
  ]);
  const w = await import("./windows");
  w.configureWindowRecovery(state, () => false, { safeMode: true });
  w.restoreWindows();
  expect(native.options).toHaveLength(1);
  const saved = windowStateFile(state).read();
  expect(saved).toHaveLength(1);
  expect(saved[0]?.href).toBeUndefined();
});
it("coalesces resize/move writes and flushes the final bounds on close", async () => {
  vi.useFakeTimers();
  const w = await import("./windows");
  const state = file();
  w.configureWindowRecovery(state, () => false);
  const main = w.createMainWindow();
  const original = windowStateFile(state).read()[0]?.bounds;
  vi.spyOn(main, "getNormalBounds").mockReturnValue({ x: 200, y: 200, width: 1100, height: 750 });
  main.emit("resize");
  main.emit("move");
  main.emit("resize");
  expect(windowStateFile(state).read()[0]?.bounds).toEqual(original);
  await vi.advanceTimersByTimeAsync(200);
  expect(windowStateFile(state).read()[0]?.bounds.width).toBe(1100);
  main.close();
  expect(windowStateFile(state).read()).toHaveLength(1);
});
it("never opens a second editor for an inline draft; asks its owner to transfer first", async () => {
  const w = await import("./windows");
  const main = w.createMainWindow();
  const other = w.createMainWindow();
  expect(w.claimInlineDraft(main, "draft-one")).toBe(true);
  const pop = vi.fn();
  w.setInlinePopOutHandler(pop);
  const count = native.options.length;
  expect(w.openComposeWindow("draft-one")).toBe(main);
  expect(pop).toHaveBeenCalledWith(main, "draft-one");
  expect(native.options).toHaveLength(count);
  expect(w.claimInlineDraft(other, "draft-one")).toBe(false);
  const detached = w.openComposeWindow("draft-one", undefined, main);
  expect(detached).not.toBe(main);
  expect(w.claimInlineDraft(main, "draft-one")).toBe(false);
  expect(w.openComposeWindow("draft-one")).toBe(detached);
  expect(native.options).toHaveLength(count + 1);
  w.approveComposeClose(detached);
  expect(w.claimInlineDraft(main, "draft-one")).toBe(true);
});
it("ignores clean-exit events and respects the pending-send guard before reload", async () => {
  const w = await import("./windows");
  const crash = vi.fn(() => false);
  w.configureWindowRecovery(file(), crash);
  const main = w.createMainWindow();
  const guard = vi.fn(async () => false);
  w.setRendererReloadGuard(guard);
  for (const reason of ["clean-exit"])
    main.webContents.emit("render-process-gone", {}, { reason, exitCode: 0 });
  expect(crash).not.toHaveBeenCalled();
  expect(guard).not.toHaveBeenCalled();
  main.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 139 });
  await Promise.resolve();
  expect(guard).toHaveBeenCalledOnce();
  expect(native.reload).not.toHaveBeenCalled();
  guard.mockResolvedValueOnce(true);
  main.webContents.emit("render-process-gone", {}, { reason: "oom", exitCode: 137 });
  await Promise.resolve();
  expect(native.reload).toHaveBeenCalledOnce();
});

it("retains a standalone draft claim through a renderer crash and re-registers on reload", async () => {
  const w = await import("./windows");
  w.configureWindowRecovery(file(), () => false);
  const compose = w.openComposeWindow("crash-draft");
  const main = w.createMainWindow();
  const count = native.options.length;
  compose.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 139 });
  await Promise.resolve();
  expect(w.claimInlineDraft(main, "crash-draft")).toBe(false);
  expect(w.openComposeWindow("crash-draft")).toBe(compose);
  expect(native.options).toHaveLength(count);
  w.releaseDraftEditors(compose);
  expect(w.registerComposeDraft(compose, "crash-draft")).toBe(true);
  expect(w.claimInlineDraft(main, "crash-draft")).toBe(false);
});

it("reloads killed renderers and releases inline claims without adding a loop crash", async () => {
  const w = await import("./windows");
  const counted = vi.fn(() => false);
  w.configureWindowRecovery(file(), counted);
  const main = w.createMainWindow();
  const other = w.createMainWindow();
  expect(w.claimInlineDraft(main, "killed-inline")).toBe(true);
  main.webContents.emit("render-process-gone", {}, { reason: "killed", exitCode: 9 });
  await Promise.resolve();
  expect(counted).not.toHaveBeenCalled();
  expect(native.reload).toHaveBeenCalledOnce();
  expect(w.claimInlineDraft(other, "killed-inline")).toBe(true);
});

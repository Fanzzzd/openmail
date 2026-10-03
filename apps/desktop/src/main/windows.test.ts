import type { BrowserWindowConstructorOptions } from "electron";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowStateFile } from "./window-state";
import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";

const created = vi.hoisted(() => {
  vi.resetModules();
  vi.doUnmock("./windows");
  return new Array<unknown>();
});
vi.mock("electron", () => ({
  app: Object.assign(new EventEmitter(), {
    isPackaged: true,
    getPreferredSystemLanguages: () => ["en"],
    getLocale: () => "en",
  }),
  screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 24, width: 1920, height: 1056 } }] },
  nativeTheme: { shouldUseDarkColors: false },
  shell: { openExternal: vi.fn(() => Promise.resolve()) },
  BrowserWindow: class FakeWindow extends EventEmitter {
    static all: FakeWindow[] = [];
    static getAllWindows = () => FakeWindow.all;
    isDestroyed = () => false;
    addTabbedWindow = vi.fn();
    show = vi.fn();
    focus = vi.fn();
    setTitle = vi.fn();
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
    constructor(readonly options: BrowserWindowConstructorOptions) {
      super();
      created.push(options);
      FakeWindow.all.push(this);
    }
    once = vi.fn();
    loadFile = vi.fn(() => Promise.resolve());
    loadURL = vi.fn(() => Promise.resolve());
    webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: vi.fn(),
    });
  },
}));

import { BrowserWindow, shell } from "electron";
import {
  createMainWindow,
  lockNavigation,
  openMessageWindow,
  openThreadWindow,
  openComposeWindow,
  setComposeCloseHandler,
  retainComposeRecipients,
  takeComposeRecipients,
} from "./windows";

it("blocks subframe navigation without opening unrequested pages externally", () => {
  const win = new BrowserWindow({ show: false });
  lockNavigation(win);
  for (const url of [
    "https://evil.example/from-svg",
    "http://example.com/self",
    "mailto:a@example.com",
    "javascript:alert(1)",
    "file:///tmp/private",
  ]) {
    vi.mocked(shell).openExternal.mockClear();
    const event = {
      preventDefault: vi.fn(),
      isMainFrame: false,
      url,
      frame: { url: "about:srcdoc" },
    };
    win.webContents.emit("will-frame-navigate", event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(vi.mocked(shell).openExternal.mock.calls).toEqual([]);
  }
  const main = { preventDefault: vi.fn(), isMainFrame: true, url: "https://evil.example" };
  win.webContents.emit("will-frame-navigate", main);
  expect(main.preventDefault).toHaveBeenCalledOnce();
});

it("locks navigation, redirects, webviews and title changes for every app window kind", () => {
  for (const make of [
    () => createMainWindow(),
    () => openComposeWindow("security-draft"),
    () => openThreadWindow("security-thread"),
    () => openMessageWindow("security-message"),
  ]) {
    const win = make();
    expect(created.at(-1)).toMatchObject({
      title: "OpenMail",
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        webviewTag: false,
        spellcheck: true,
      },
    });
    for (const name of ["will-navigate", "will-redirect", "will-attach-webview"]) {
      const event = { preventDefault: vi.fn() };
      win.webContents.emit(name, event);
      expect(event.preventDefault).toHaveBeenCalledOnce();
    }
    win.emit("closed");
  }
});

it("retains the existing external popup route and never creates a popup window", () => {
  const win = new BrowserWindow({ show: false });
  lockNavigation(win);
  const handler = vi.mocked(win.webContents).setWindowOpenHandler.mock.calls[0]?.[0];
  expect(handler).toBeDefined();
  for (const url of ["https://example.com", "mailto:a@example.com", "javascript:alert(1)"]) {
    vi.mocked(shell).openExternal.mockClear();
    expect(
      handler?.({
        url,
        frameName: "",
        features: "",
        disposition: "new-window",
        referrer: { url: "", policy: "default" },
      }),
    ).toEqual({ action: "deny" });
    if (url.startsWith("javascript:")) expect(vi.mocked(shell).openExternal.mock.calls).toEqual([]);
    else expect(vi.mocked(shell).openExternal.mock.calls).toEqual([[new URL(url).href]]);
  }
});

it("allows local reader documents to load while blocking navigation of the main window", () => {
  const win = new BrowserWindow({ show: false });
  lockNavigation(win);
  for (const url of ["about:srcdoc", "about:blank"]) {
    const frame = { preventDefault: vi.fn(), isMainFrame: false, url };
    win.webContents.emit("will-frame-navigate", frame);
    expect(frame.preventDefault).not.toHaveBeenCalled();
    const main = { preventDefault: vi.fn(), isMainFrame: true, url };
    win.webContents.emit("will-frame-navigate", main);
    expect(main.preventDefault).toHaveBeenCalledOnce();
  }
});

it("single-message windows force single scope independently of conversation settings", () => {
  const id = "gmail:me@example.com/older";
  const single = openMessageWindow(id);
  expect({
    query: Object.fromEntries(
      new URL(vi.mocked(single).loadURL.mock.calls[0]?.[0] ?? "").searchParams,
    ),
  }).toEqual({
    query: { systemLanguages: JSON.stringify(["en", "en"]), thread: id, single: "1" },
  });
  const thread = openThreadWindow(id);
  expect({
    query: Object.fromEntries(
      new URL(vi.mocked(thread).loadURL.mock.calls[0]?.[0] ?? "").searchParams,
    ),
  }).toEqual({
    query: { systemLanguages: JSON.stringify(["en", "en"]), thread: id },
  });
});

it("compose windows share the locked sandbox and request a renderer draft close before closing", () => {
  const close = vi.fn();
  setComposeCloseHandler(close);
  const win = openComposeWindow("draft-20");
  expect(created.at(-1)).toMatchObject({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      preload: expect.stringContaining("preload/index.cjs"),
    },
  });
  expect(
    Object.fromEntries(new URL(vi.mocked(win).loadURL.mock.calls[0]?.[0] ?? "").searchParams),
  ).toEqual({ systemLanguages: JSON.stringify(["en", "en"]), compose: "draft-20" });
  expect(vi.mocked(win.webContents).setWindowOpenHandler.mock.calls).toHaveLength(1);
  const recipients = { to: "Alice <unfinished", cc: "Bob,", bcc: "private" };
  retainComposeRecipients(win, recipients);
  expect(takeComposeRecipients(win)).toEqual(recipients);
  expect(takeComposeRecipients(win)).toBeNull();
  const event = { preventDefault: vi.fn() };
  win.emit("close", event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledWith(win);
});

it("restores each window kind and does not lose the set while quitting", async () => {
  vi.resetModules();
  const { app } = await import("electron");
  const windows = await import("./windows");
  const dir = mkdtempSync(join(tmpdir(), "openmail-restore-"));
  const file = join(dir, "windows.json");
  const selection = {
    space: "work",
    mailbox: "all",
    label: { id: "folder-1", accountId: "account" },
    messageId: "message-900",
  } as const;
  const bounds = { x: 100, y: 100, width: 960, height: 700 };
  const saved = [
    { key: "main", kind: "main", bounds, maximized: false, selection },
    { key: "reader", kind: "message", bounds, maximized: false, target: "message-1" },
    { key: "compose", kind: "compose", bounds, maximized: false, target: "draft-1" },
  ] as const;
  try {
    windowStateFile(file).write(saved);
    windows.configureWindowRecovery(file, () => false);
    windows.restoreWindows();
    const restored = BrowserWindow.getAllWindows().slice(-3);
    expect({
      query: Object.fromEntries(
        new URL(vi.mocked(restored[0]!).loadURL.mock.calls[0]?.[0] ?? "").searchParams,
      ),
    }).toEqual({
      query: {
        systemLanguages: JSON.stringify(["en", "en"]),
        selection: JSON.stringify(selection),
      },
    });
    expect({
      query: Object.fromEntries(
        new URL(vi.mocked(restored[1]!).loadURL.mock.calls[0]?.[0] ?? "").searchParams,
      ),
    }).toEqual({
      query: { systemLanguages: JSON.stringify(["en", "en"]), thread: "message-1", single: "1" },
    });
    expect({
      query: Object.fromEntries(
        new URL(vi.mocked(restored[2]!).loadURL.mock.calls[0]?.[0] ?? "").searchParams,
      ),
    }).toEqual({
      query: { systemLanguages: JSON.stringify(["en", "en"]), compose: "draft-1" },
    });
    app.emit("before-quit", { defaultPrevented: false });
    for (const win of restored) win.emit("closed");
    expect(windowStateFile(file).read()).toEqual(saved);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("only main windows opt into native macOS tabs, and the tab button creates another main window", () => {
  const main = createMainWindow();
  const reader = openThreadWindow("gmail:me@example.com/m");
  if (process.platform === "darwin") {
    expect(created.at(-2)).toMatchObject({ tabbingIdentifier: "openmail-main" });
    expect(created.at(-1)).not.toHaveProperty("tabbingIdentifier");
    const addTab = vi.spyOn(main, "addTabbedWindow");
    main.emit("new-window-for-tab");
    expect(addTab).toHaveBeenCalledOnce();
    expect(created.at(-1)).toMatchObject({ tabbingIdentifier: "openmail-main" });
  } else expect(created.at(-2)).not.toHaveProperty("tabbingIdentifier");
  main.emit("closed");
  reader.emit("closed");
});

it("sanitizes reader window titles and keeps main and compose titles fixed", () => {
  const subject = `Subject\n\u0000\u007f\u0080${"📬".repeat(250)}`;
  for (const [kind, win] of [
    ["main", createMainWindow()],
    ["compose", openComposeWindow("title-draft")],
    ["thread", openThreadWindow("title-thread")],
    ["message", openMessageWindow("title-message")],
  ] as const) {
    const title = vi.spyOn(win, "setTitle");
    const event = { preventDefault: vi.fn() };
    win.emit("page-title-updated", event, subject);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    if (kind === "thread" || kind === "message") {
      expect(title).toHaveBeenCalledWith(`Subject${"📬".repeat(193)}`);
      win.emit("page-title-updated", event, "\n\u0000");
      expect(title).toHaveBeenLastCalledWith("OpenMail");
    } else expect(title).not.toHaveBeenCalled();
  }
});

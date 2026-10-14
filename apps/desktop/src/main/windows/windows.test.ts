import type { BrowserWindowConstructorOptions } from "electron";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowStateFile } from "./window-state";
import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";

const created = vi.hoisted(() => {
  vi.resetModules();
  vi.doUnmock("./windows");
  return new Array<BrowserWindowConstructorOptions>();
});
vi.mock("electron", () => ({
  app: Object.assign(new EventEmitter(), {
    isPackaged: true,
    getPreferredSystemLanguages: () => ["en"],
    getLocale: () => "en",
    getSystemLocale: () => "en-GB",
  }),
  screen: {
    getAllDisplays: () => [{ workArea: { x: 0, y: 24, width: 1920, height: 1056 } }],
    // A second display to the right of the primary one.
    getDisplayMatching: (rect: { x: number }) => ({
      workArea:
        rect.x >= 1920
          ? { x: 1920, y: 25, width: 2560, height: 1415 }
          : { x: 0, y: 24, width: 1920, height: 1056 },
    }),
  },
  nativeTheme: { shouldUseDarkColors: false },
  systemPreferences: { getUserDefault: () => false },
  shell: { openExternal: vi.fn(() => Promise.resolve()) },
  BrowserWindow: class FakeWindow extends EventEmitter {
    static all: FakeWindow[] = [];
    static getAllWindows = () => FakeWindow.all;
    isDestroyed = () => false;
    addTabbedWindow = vi.fn();
    show = vi.fn();
    focus = vi.fn();
    setTitle = vi.fn();
    getBounds() {
      return this.getNormalBounds();
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
        devTools: false,
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

it("denies popup links so they cannot bypass reader confirmation", () => {
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
    expect(vi.mocked(shell).openExternal.mock.calls).toEqual([]);
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
  expect(page(single)).toEqual({
    query: { systemLanguages: JSON.stringify(["en", "en"]), region: "en-GB" },
    hash: "#/thread/gmail%3Ame%40example.com%2Folder?single=1",
  });
  const thread = openThreadWindow(id);
  expect(page(thread)).toEqual({
    query: { systemLanguages: JSON.stringify(["en", "en"]), region: "en-GB" },
    hash: "#/thread/gmail%3Ame%40example.com%2Folder",
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
  expect(page(win)).toEqual({
    query: { systemLanguages: JSON.stringify(["en", "en"]), region: "en-GB" },
    hash: "#/compose/draft-20",
  });
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

it("restores each window kind from the old and new saved formats", async () => {
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
  const route = "/mail/work/all?label=account%2Ffolder-1&thread=message-900";
  const bounds = { x: 100, y: 100, width: 960, height: 700 };
  // Files written before routes carry `selection`; reading them yields `href`.
  writeFileSync(
    file,
    JSON.stringify([
      { key: "main", kind: "main", bounds, maximized: false, selection },
      { key: "new", kind: "main", bounds, maximized: false, href: "/mail/all/sent?q=x" },
      { key: "bad", kind: "main", bounds, maximized: false, href: "https://evil.example/" },
      { key: "reader", kind: "message", bounds, maximized: false, target: "message-1" },
      { key: "compose", kind: "compose", bounds, maximized: false, target: "draft-1" },
    ]),
  );
  try {
    windows.configureWindowRecovery(file, () => false);
    windows.restoreWindows();
    const restored = BrowserWindow.getAllWindows().slice(-5);
    const query = { systemLanguages: JSON.stringify(["en", "en"]), region: "en-GB" };
    expect(restored.map(page)).toEqual([
      { query, hash: `#${route}` },
      { query, hash: "#/mail/all/sent?q=x" },
      { query, hash: "" },
      { query, hash: "#/thread/message-1?single=1" },
      { query, hash: "#/compose/draft-1" },
    ]);
    app.emit("before-quit", { defaultPrevented: false });
    for (const win of restored) win.emit("closed");
    expect(windowStateFile(file).read()).toEqual([
      { key: "main", kind: "main", bounds, maximized: false, href: route },
      { key: "new", kind: "main", bounds, maximized: false, href: "/mail/all/sent?q=x" },
      { key: "bad", kind: "main", bounds, maximized: false },
      {
        key: "reader",
        kind: "message",
        bounds,
        maximized: false,
        target: "message-1",
        href: "/thread/message-1?single=1",
      },
      {
        key: "compose",
        kind: "compose",
        bounds,
        maximized: false,
        target: "draft-1",
        href: "/compose/draft-1",
      },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("keeps only mail routes that a main window reports", async () => {
  vi.resetModules();
  const windows = await import("./windows");
  const dir = mkdtempSync(join(tmpdir(), "openmail-route-"));
  const file = join(dir, "windows.json");
  try {
    windows.configureWindowRecovery(file, () => false);
    const main = windows.createMainWindow();
    const reader = windows.openThreadWindow("message-1");
    const saved = () =>
      windowStateFile(file)
        .read()
        .map((state) => state.href);
    windows.setWindowRoute(main, "/mail/work/sent?thread=m");
    expect(saved()).toEqual(["/mail/work/sent?thread=m", "/thread/message-1"]);
    for (const href of [
      "/thread/other",
      "/compose/draft",
      "https://evil.example/",
      "//evil.example/mail/all/inbox",
      "/mail/all/nowhere",
    ]) {
      windows.setWindowRoute(main, href);
      expect(saved()[0]).toBe("/mail/work/sent?thread=m");
    }
    windows.setWindowRoute(reader, "/mail/all/inbox");
    expect(saved()[1]).toBe("/thread/message-1");
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

function page(win: BrowserWindow) {
  const url = new URL(vi.mocked(win).loadURL.mock.calls[0]?.[0] ?? "");
  return { query: Object.fromEntries(url.searchParams), hash: url.hash };
}

it("thread, message and compose pop-outs open centred on the display of the window they came from", () => {
  const parent = new BrowserWindow({ x: 2400, y: 200, width: 1320, height: 860 });
  for (const open of [
    () => openThreadWindow("thread-on-second", parent),
    () => openMessageWindow("message-on-second", parent),
    () => openComposeWindow("draft-on-second", undefined, undefined, parent),
  ]) {
    created.length = 0;
    open();
    const options = created[0];
    expect(options?.x).toBeGreaterThanOrEqual(1920);
    expect((options?.x ?? 0) + (options?.width ?? 0)).toBeLessThanOrEqual(1920 + 2560);
    expect(options?.y).toBeGreaterThanOrEqual(25);
  }
  // Without a parent the window keeps Electron's placement.
  created.length = 0;
  openThreadWindow("thread-without-parent");
  expect(created[0]?.x).toBeUndefined();
});

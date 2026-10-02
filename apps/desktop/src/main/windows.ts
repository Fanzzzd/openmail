/**
 * App windows. The main window and thread windows load the same renderer
 * with the same preload and security settings; a `thread` query parameter
 * makes the renderer show only the reader for that thread.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, nativeTheme, shell } from "electron";

const here = path.dirname(fileURLToPath(import.meta.url));
const MAC = process.platform === "darwin";
// build/ is not packaged: the bundle icon comes from build/icon.icns. In dev the
// dock and window would otherwise show Electron's icon.
export const DEV_ICON = app.isPackaged ? undefined : path.join(here, "../../build/icon.png");

/** Mail links open in the system browser; nothing navigates the app's own windows. */
export function lockNavigation(win: BrowserWindow) {
  // The message iframe is sandboxed with `allow-popups` and a `_blank` base
  // target, so every link click lands here.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  // Allow the local reader document to initialize, never remote content in any frame.
  win.webContents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame && (event.url === "about:srcdoc" || event.url === "about:blank")) return;
    event.preventDefault();
  });
}

interface WindowOptions {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  /** Extra query parameters for the renderer. */
  query?: Record<string, string>;
}

function createAppWindow(options: WindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    width: options.width,
    height: options.height,
    minWidth: options.minWidth,
    minHeight: options.minHeight,
    show: false,
    title: "OpenMail",
    ...(MAC
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 18, y: 18 },
          // The sidebar is transparent and shows this material through.
          vibrancy: "sidebar" as const,
          visualEffectState: "followWindow" as const,
          backgroundColor: "#00000000",
        }
      : {
          backgroundColor: nativeTheme.shouldUseDarkColors ? "#171717" : "#ffffff",
          ...(DEV_ICON ? { icon: DEV_ICON } : {}),
        }),
    webPreferences: {
      preload: path.join(here, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
    },
  });
  lockNavigation(win);

  // A renderer killed for memory or by a crash leaves a blank window. Log why
  // and reload, unless it died again within a minute, which would loop.
  let lastGone = 0;
  win.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[renderer gone] ${details.reason} (exit code ${details.exitCode})`);
    const now = Date.now();
    if (details.reason !== "clean-exit" && now - lastGone > 60_000 && !win.isDestroyed()) {
      win.webContents.reload();
    }
    lastGone = now;
  });

  // The renderer picks its UI language from the OS language unless the person
  // chose one in Settings.
  const query = {
    system: app.getPreferredSystemLanguages()[0] ?? app.getLocale(),
    ...options.query,
  };
  if (process.env.ELECTRON_RENDERER_URL) {
    win.webContents.on("console-message", ({ level, message }) => {
      if (level === "warning" || level === "error") console.log(`[renderer ${level}] ${message}`);
    });
    const url = new URL(process.env.ELECTRON_RENDERER_URL);
    url.search = new URLSearchParams(query).toString();
    void win.loadURL(url.toString());
  } else {
    void win.loadFile(path.join(here, "../renderer/index.html"), { query });
  }
  win.once("ready-to-show", () => win.show());
  return win;
}

const mainWindows = new Set<BrowserWindow>();

export function createMainWindow(): BrowserWindow {
  const win = createAppWindow({ width: 1320, height: 860, minWidth: 960, minHeight: 600 });
  mainWindows.add(win);
  win.once("closed", () => mainWindows.delete(win));
  return win;
}

export function isMainWindow(win: BrowserWindow): boolean {
  return mainWindows.has(win);
}

export function focusMainWindow(): BrowserWindow {
  const focused = BrowserWindow.getFocusedWindow();
  const win =
    focused && mainWindows.has(focused) ? focused : ([...mainWindows].at(-1) ?? createMainWindow());
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return win;
}

/** A window showing one thread, by any message id in it. */
export function openThreadWindow(messageId: string): BrowserWindow {
  return createAppWindow({
    width: 820,
    height: 860,
    minWidth: 480,
    minHeight: 400,
    query: { thread: messageId },
  });
}

/** A window whose view and actions are scoped to one message, regardless of grouping. */
export function openMessageWindow(messageId: string): BrowserWindow {
  return createAppWindow({
    width: 820,
    height: 860,
    minWidth: 480,
    minHeight: 400,
    query: { thread: messageId, single: "1" },
  });
}

/** The window a renderer (RPC client id = webContents id) lives in. */
export function windowOf(webContentsId: number): BrowserWindow | null {
  return (
    BrowserWindow.getAllWindows().find((w) => w.webContents.id === webContentsId) ??
    BrowserWindow.getFocusedWindow()
  );
}

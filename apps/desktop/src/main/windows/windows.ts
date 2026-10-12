/**
 * App windows. Every window loads the same renderer with the same preload and
 * security settings; the hash route (shared/routes) picks the screen, such as
 * `#/thread/<id>` for a window with only the reader for that thread.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, nativeTheme, screen } from "electron";
import { randomUUID } from "node:crypto";
import { WINDOW_MIN } from "../../shared/layout";
import { appHref, composeHref, parseAppHref, threadHref } from "../../shared/routes";
import type { ComposeRecipients, SavedWindow } from "../../shared/window-state";
import { backgroundWindows, revealAndFocus, revealWindow } from "./reveal";
import { visibleBounds, windowStateFile } from "./window-state";

import {
  APP_PAGE,
  developmentPage,
  readerWindowTitle,
  WINDOW_SECURITY,
} from "../security/security-policy";
import { trustRenderer } from "../security/security";
import { APP_TITLE, DEV_ICON } from "../app/app-identity";

const here = path.dirname(fileURLToPath(import.meta.url));
const MAC = process.platform === "darwin";

/** Mail links open in the system browser; nothing navigates the app's own windows. */
export function lockNavigation(win: BrowserWindow, kind: SavedWindow["kind"] = "main") {
  win.on("page-title-updated", (event, title) => {
    event.preventDefault();
    if (kind === "thread" || kind === "message") win.setTitle(readerWindowTitle(title));
  });
  // Reader links are intercepted by the parent and reviewed through OpenMailLink.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("will-redirect", (event) => event.preventDefault());
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  // Allow the local reader document to initialize, never remote content in any frame.
  win.webContents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame && (event.url === "about:srcdoc" || event.url === "about:blank")) return;
    event.preventDefault();
  });
}

const composeRecipients = new WeakMap<BrowserWindow, ComposeRecipients>();
export function retainComposeRecipients(win: BrowserWindow, recipients: ComposeRecipients) {
  composeRecipients.set(win, recipients);
}
export function takeComposeRecipients(win: BrowserWindow | null): ComposeRecipients | null {
  if (!win) return null;
  const recipients = composeRecipients.get(win) ?? null;
  composeRecipients.delete(win);
  return recipients;
}
const draftEditors = new Map<string, { win: BrowserWindow; kind: "inline" | "window" }>();
let inlinePopOut: ((win: BrowserWindow, id: string) => void) | undefined;
export const setInlinePopOutHandler = (handler: (win: BrowserWindow, id: string) => void) => {
  inlinePopOut = handler;
};
export function releaseDraftEditors(win: BrowserWindow, inlineOnly = false) {
  for (const [id, editor] of draftEditors)
    if (editor.win === win && (!inlineOnly || editor.kind === "inline")) draftEditors.delete(id);
}
export function registerComposeDraft(win: BrowserWindow | null, id: string): boolean {
  if (!win || !isComposeWindow(win)) return false;
  const current = draftEditors.get(id);
  if (current && current.win !== win) {
    current.win.show();
    current.win.focus();
    return false;
  }
  draftEditors.set(id, { win, kind: "window" });
  return true;
}
export function claimInlineDraft(win: BrowserWindow | null, id: string | null): boolean {
  if (!win) return false;
  const existing = id ? draftEditors.get(id) : undefined;
  if (existing && (existing.win !== win || existing.kind !== "inline")) {
    existing.win.show();
    existing.win.focus();
    return false;
  }
  for (const [key, editor] of draftEditors)
    if (editor.win === win && editor.kind === "inline") draftEditors.delete(key);
  if (id) draftEditors.set(id, { win, kind: "inline" });
  return true;
}
const tracked = new Map<BrowserWindow, SavedWindow>();
let snapshot: ReturnType<typeof windowStateFile> | undefined;
let quitting = false;
let ignoreSavedWindows = false;
let lastMain: SavedWindow | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let reloadGuard: ((win: BrowserWindow) => Promise<boolean>) | undefined;
export const setRendererReloadGuard = (guard: (win: BrowserWindow) => Promise<boolean>) => {
  reloadGuard = guard;
};
let rendererCrash: ((code: number) => boolean) | undefined;
export function configureWindowRecovery(
  file: string,
  crash: (code: number) => boolean,
  options: { safeMode?: boolean } = {},
) {
  snapshot = windowStateFile(file);
  rendererCrash = crash;
  ignoreSavedWindows = options.safeMode ?? false;
  lastMain = ignoreSavedWindows
    ? undefined
    : snapshot.read().findLast((state) => state.kind === "main");
  app.on("before-quit", (event) => {
    saveWindows();
    quitting = true;
    queueMicrotask(() => {
      if (event.defaultPrevented) quitting = false;
    });
  });
}
const saveWindows = () => {
  clearTimeout(saveTimer);
  if (!snapshot || quitting) return;
  const windows = [...tracked.values()];
  lastMain = windows.findLast((state) => state.kind === "main") ?? lastMain;
  if (!windows.some((state) => state.kind === "main") && lastMain) windows.push(lastMain);
  if (!windows.length) return;
  try {
    snapshot.write(windows);
  } catch {
    /* Recovery storage failure is non-fatal. */
  }
};
/** A main window's renderer reports its route; only mail routes are kept for restore. */
export function setWindowRoute(win: BrowserWindow | null, href: string) {
  const state = win ? tracked.get(win) : undefined;
  const route = parseAppHref(href);
  if (!win || state?.kind !== "main" || route?.kind !== "mail") return;
  const next = appHref(route);
  if (state.href === next) return;
  tracked.set(win, { ...state, href: next });
  saveWindows();
}
export function restoreWindows() {
  const saved = ignoreSavedWindows ? [] : (snapshot?.read() ?? []);
  if (!saved.length) {
    createMainWindow();
    return;
  }
  for (const state of saved) {
    if (state.kind === "main") createMainWindow(state);
    else if (state.target) {
      if (state.kind === "compose") openComposeWindow(state.target, state);
      else
        createAppWindow({
          width: 820,
          height: 860,
          minWidth: WINDOW_MIN.width,
          minHeight: WINDOW_MIN.height,
          kind: state.kind,
          target: state.target,
          restored: state,
          href: threadHref(state.target, state.kind === "message"),
        });
    }
  }
  if (![...tracked.values()].some((s) => s.kind === "main")) createMainWindow();
}
export const isComposeWindow = (win: BrowserWindow) => tracked.get(win)?.kind === "compose";
export const approveComposeClose = (win: BrowserWindow | null) => {
  if (win) {
    allowedClose.add(win);
    win.close();
  }
};
let composeClose: ((win: BrowserWindow) => void) | undefined;
export const setComposeCloseHandler = (handler: (win: BrowserWindow) => void) => {
  composeClose = handler;
};
const allowedClose = new WeakSet<BrowserWindow>();

interface WindowOptions {
  kind?: SavedWindow["kind"];
  target?: string;
  restored?: SavedWindow;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  /** The renderer route, from shared/routes; unset lands on the default view. */
  href?: string;
}

function createAppWindow(options: WindowOptions): BrowserWindow {
  const restored = options.restored;
  const bounds = restored
    ? visibleBounds(restored.bounds, screen.getAllDisplays(), {
        width: options.minWidth,
        height: options.minHeight,
      })
    : undefined;
  const win = new BrowserWindow({
    width: options.width,
    height: options.height,
    ...bounds,
    minWidth: options.minWidth,
    minHeight: options.minHeight,
    show: false,
    title: APP_TITLE,
    ...(MAC
      ? {
          ...(options.kind === undefined || options.kind === "main"
            ? { tabbingIdentifier: "openmail-main" }
            : {}),
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
      ...WINDOW_SECURITY,
      devTools: !app.isPackaged,
      // A background window sits behind other apps; keep it painting so harnesses can capture it.
      ...(backgroundWindows() ? { backgroundThrottling: false } : {}),
    },
  });
  trustRenderer(
    win.webContents,
    options.kind ?? "main",
    app.isPackaged,
    process.env.ELECTRON_RENDERER_URL,
  );
  lockNavigation(win, options.kind ?? "main");
  if (MAC && (options.kind === undefined || options.kind === "main")) {
    win.on("new-window-for-tab", () => {
      if (!win.isDestroyed()) win.addTabbedWindow(createMainWindow());
    });
  }

  {
    const state: SavedWindow = {
      key: restored?.key ?? randomUUID(),
      kind: options.kind ?? "main",
      ...(options.target ? { target: options.target } : {}),
      bounds:
        bounds ??
        (snapshot
          ? win.getNormalBounds()
          : { x: 0, y: 0, width: options.width, height: options.height }),
      maximized: restored?.maximized ?? false,
      ...(options.href ? { href: options.href } : {}),
    };
    tracked.set(win, state);
    const update = () => {
      const previous = tracked.get(win);
      if (previous && snapshot)
        tracked.set(win, {
          ...previous,
          bounds: win.getNormalBounds(),
          maximized: win.isMaximized(),
        });
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveWindows, 200);
    };
    win.on("resize", update);
    win.on("move", update);
    win.on("maximize", update);
    win.on("unmaximize", update);
    win.once("closed", () => {
      const closed = tracked.get(win);
      if (closed?.kind === "main") lastMain = closed;
      tracked.delete(win);
      releaseDraftEditors(win);
      saveWindows();
    });
    saveWindows();
  }
  if (options.kind === "compose")
    win.on("close", (event) => {
      if (event.defaultPrevented || quitting || allowedClose.has(win)) return;
      event.preventDefault();
      composeClose?.(win);
    });
  win.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return;
    releaseDraftEditors(win, true);
    if (details.reason === "killed" || !rendererCrash?.(details.exitCode))
      void (reloadGuard?.(win) ?? Promise.resolve(true)).then((approved) => {
        if (approved && !win.isDestroyed()) win.webContents.reload();
        return approved;
      });
  });

  // The renderer picks its UI language from the OS language unless the person
  // chose one in Settings. It reads this before the router starts, so it stays
  // in the query; the route goes after `#`.
  const url = new URL(
    developmentPage(app.isPackaged, process.env.ELECTRON_RENDERER_URL) ?? APP_PAGE,
  );
  url.search = new URLSearchParams({
    systemLanguages: JSON.stringify([...app.getPreferredSystemLanguages(), app.getLocale()]),
  }).toString();
  if (options.href) url.hash = options.href;
  void win.loadURL(url.href);
  win.once("ready-to-show", () => {
    if (restored?.maximized) win.maximize();
    revealWindow(win);
  });
  return win;
}

const mainWindows = new Set<BrowserWindow>();

export function createMainWindow(restored?: SavedWindow): BrowserWindow {
  const win = createAppWindow({
    width: 1320,
    height: 860,
    // Below WIDE_MIN the sidebar becomes a drawer; below MEDIUM_MIN one pane shows at a time.
    minWidth: WINDOW_MIN.width,
    minHeight: WINDOW_MIN.height,
    restored,
    // window-state.ts keeps only mail routes for main windows.
    ...(restored?.href ? { href: restored.href } : {}),
  });
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
  revealAndFocus(win);
  return win;
}

/** A window showing one thread, by any message id in it. */
export function openThreadWindow(messageId: string): BrowserWindow {
  return createAppWindow({
    width: 820,
    height: 860,
    minWidth: WINDOW_MIN.width,
    minHeight: WINDOW_MIN.height,
    kind: "thread",
    target: messageId,
    href: threadHref(messageId),
  });
}

/** A window whose view and actions are scoped to one message, regardless of grouping. */
export function openMessageWindow(messageId: string): BrowserWindow {
  return createAppWindow({
    width: 820,
    height: 860,
    minWidth: WINDOW_MIN.width,
    minHeight: WINDOW_MIN.height,
    kind: "message",
    target: messageId,
    href: threadHref(messageId, true),
  });
}

/** The window a renderer (RPC client id = webContents id) lives in. */
export function windowOf(webContentsId: number): BrowserWindow | null {
  return BrowserWindow.getAllWindows().find((w) => w.webContents.id === webContentsId) ?? null;
}

export function openComposeWindow(
  draftId: string,
  restored?: SavedWindow,
  transfer?: BrowserWindow | null,
): BrowserWindow {
  const editor = draftEditors.get(draftId);
  if (editor && (editor.kind === "window" || editor.win !== transfer)) {
    editor.win.show();
    editor.win.focus();
    if (editor.kind === "inline") inlinePopOut?.(editor.win, draftId);
    return editor.win;
  }
  const win = createAppWindow({
    width: 760,
    height: 800,
    minWidth: WINDOW_MIN.width,
    minHeight: WINDOW_MIN.height,
    kind: "compose",
    target: draftId,
    restored,
    href: composeHref(draftId),
  });
  draftEditors.set(draftId, { win, kind: "window" });
  return win;
}

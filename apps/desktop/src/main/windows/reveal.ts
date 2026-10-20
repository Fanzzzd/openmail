import { execFile } from "node:child_process";
import path from "node:path";
import {
  app,
  type BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  type Menu,
  type MessageBoxOptions,
  type MessageBoxReturnValue,
  type NativeImage,
  type Notification,
  type OpenDialogOptions,
  type OpenDialogReturnValue,
  type PopupOptions,
  type SaveDialogOptions,
  type SaveDialogReturnValue,
  type ShareMenu,
  shell,
  Tray,
  type WebContents,
  type WebContentsPrintOptions,
} from "electron";

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
 * main process goes through this module so a mode cannot be bypassed, and so do native dialogs,
 * Quick Look, printing, the menu-bar icon, notifications, popup and share menus, opening a URL,
 * file or Finder window in another app, and the clipboard. A hidden run answers each dialog,
 * panel and menu as if the person cancelled it, opens nothing in another app, and keeps
 * clipboard writes in memory.
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

/**
 * Creates the menu-bar icon from `icon()`. A hidden run creates none and returns undefined: the
 * icon would appear in the menu bar of the person at the keyboard.
 */
export function createTray(icon: () => NativeImage): Tray | undefined {
  return hiddenWindows() ? undefined : new Tray(icon());
}

/**
 * Reports a startup failure before the process exits non-zero. A hidden run writes it to stderr
 * instead of a native error box, which would appear on screen and wait for a click.
 */
export function showStartupError(title: string, detail: string) {
  if (hiddenWindows()) process.stderr.write(`${title}\n${detail}\n`);
  else dialog.showErrorBox(title, detail);
}

/** Shows a native message box. A hidden run answers with `cancelId` and logs the question. */
export function showMessageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue> {
  if (!hiddenWindows()) return dialog.showMessageBox(options);
  process.stderr.write(`Hidden windows: answered Cancel to "${options.message}"\n`);
  return Promise.resolve({ response: options.cancelId ?? 0, checkboxChecked: false });
}

/** Shows the native open panel, attached to `parent` when there is one. A hidden run cancels. */
export function showOpenDialog(
  parent: BrowserWindow | null | undefined,
  options: OpenDialogOptions,
): Promise<OpenDialogReturnValue> {
  if (hiddenWindows()) return Promise.resolve({ canceled: true, filePaths: [] });
  return parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options);
}

/** Shows the native save panel, attached to `parent` when there is one. A hidden run cancels. */
export function showSaveDialog(
  parent: BrowserWindow | null | undefined,
  options: SaveDialogOptions,
): Promise<SaveDialogReturnValue> {
  if (hiddenWindows()) return Promise.resolve({ canceled: true, filePath: "" });
  return parent ? dialog.showSaveDialog(parent, options) : dialog.showSaveDialog(options);
}

/**
 * Opens `file` in Quick Look over `win`. A hidden run opens nothing and still reports the preview
 * as shown, so the caller does not fall back to opening the file in another app.
 */
export function previewFile(win: BrowserWindow, file: string) {
  if (!hiddenWindows()) win.previewFile(file);
}

/** Opens the print panel for `contents`. A hidden run reports a cancelled print. */
export function printContents(
  contents: WebContents,
  options: WebContentsPrintOptions,
  done: (success: boolean, reason: string) => void,
) {
  if (hiddenWindows()) done(false, "cancelled");
  else contents.print(options, done);
}

const skipped = (what: string) => {
  process.stderr.write(`Hidden windows: did not ${what}\n`);
};

/**
 * Opens `url` in its default app. A hidden run opens nothing, logs the scheme and host only (a
 * mail link can carry a token in its path or query) and resolves as if the app opened.
 */
export function openExternalUrl(url: string): Promise<void> {
  if (!hiddenWindows()) return shell.openExternal(url);
  const parsed = URL.parse(url);
  skipped(`open a ${parsed ? `${parsed.protocol}//${parsed.host}` : "malformed"} URL`);
  return Promise.resolve();
}

/**
 * Opens `file` in its default app; resolves to Electron's error message, or "" on success. A
 * hidden run opens nothing and resolves to "".
 */
export function openPath(file: string): Promise<string> {
  if (!hiddenWindows()) return shell.openPath(file);
  skipped(`open ${path.basename(file)}`);
  return Promise.resolve("");
}

/** Shows `file` in a Finder window. A hidden run shows nothing. */
export function showItemInFolder(file: string) {
  if (!hiddenWindows()) shell.showItemInFolder(file);
  else skipped(`show ${path.basename(file)} in Finder`);
}

/**
 * Runs macOS `open` with `args`, which starts or raises another app, and rejects with execFile's
 * error. A hidden run starts nothing and resolves.
 */
export function openWithMacOS(
  args: readonly string[],
  options: { timeout: number; maxBuffer?: number },
): Promise<void> {
  if (hiddenWindows()) {
    skipped(`run open ${args.filter((arg) => arg.startsWith("-")).join(" ")}`);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/open", args, options, (error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Pops up a context or share menu. A hidden run shows nothing and closes it at once: `callback`
 * runs as it would after the person dismissed the menu.
 */
export function popupMenu(menu: Menu | ShareMenu, options: PopupOptions) {
  if (!hiddenWindows()) {
    menu.popup(options);
    return;
  }
  skipped("pop up a menu");
  options.callback?.();
}

/**
 * What a hidden run copied: the system clipboard belongs to the person at the keyboard. Reads in
 * the same run return it, so a copy and paste still round-trips; before any write it is empty.
 */
let memory: { items: ClipboardItem[]; text: string } = { items: [], text: "" };

/** The clipboard's items. A hidden run reads its own writes only. */
export function readClipboard(): Promise<ClipboardItem[]> {
  return hiddenWindows() ? Promise.resolve([...memory.items]) : clipboard.read();
}

/** The clipboard's plain text. A hidden run reads its own writes only. */
export async function readClipboardText(): Promise<string> {
  if (!hiddenWindows()) return clipboard.readText();
  if (memory.text) return memory.text;
  const item = memory.items.find((entry) => entry.types.includes("text/plain"));
  const value = await item?.getType("text/plain");
  return value instanceof Blob ? value.text() : "";
}

/** Replaces the clipboard's content with `items`. A hidden run keeps them in memory. */
export function writeClipboard(items: ClipboardItem[]): Promise<void> {
  if (!hiddenWindows()) return clipboard.write(items);
  memory = { items: [...items], text: "" };
  return Promise.resolve();
}

/** Replaces the clipboard's content with `text`. A hidden run keeps it in memory. */
export function writeClipboardText(text: string): Promise<void> {
  if (!hiddenWindows()) return clipboard.writeText(text);
  memory = { items: [new ClipboardItem({ "text/plain": text })], text };
  return Promise.resolve();
}

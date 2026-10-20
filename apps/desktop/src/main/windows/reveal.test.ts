import type { BrowserWindow, Notification } from "electron";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktopRoot } from "../../renderer/src/test-support/paths";

const electron = vi.hoisted(() => {
  const trays: unknown[] = [];
  return {
    app: { isPackaged: false, setActivationPolicy: vi.fn() },
    dialog: {
      showErrorBox: vi.fn(),
      showMessageBox: vi.fn(async () => ({ response: 1, checkboxChecked: false })),
      showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ["/picked"] })),
      showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: "/saved" })),
    },
    shell: {
      openExternal: vi.fn(() => Promise.resolve()),
      openPath: vi.fn(async () => "No application"),
      showItemInFolder: vi.fn(),
    },
    clipboard: {
      read: vi.fn(async () => [{ types: ["text/plain"] }]),
      readText: vi.fn(async () => "the user's text"),
      write: vi.fn(() => Promise.resolve()),
      writeText: vi.fn(() => Promise.resolve()),
    },
    ClipboardItem: class {
      readonly types: string[];
      constructor(readonly items: Record<string, string>) {
        this.types = Object.keys(items);
      }
      async getType(type: string) {
        return new Blob([this.items[type] ?? ""]);
      }
    },
    trays,
    Tray: class {
      constructor(readonly icon: unknown) {
        trays.push(this);
      }
    },
  };
});
vi.mock("electron", () => electron);
const execFile = vi.hoisted(() =>
  vi.fn((_file: string, _args: string[], _options: object, done: (error: Error | null) => void) =>
    done(null),
  ),
);
vi.mock("node:child_process", () => ({ execFile }));

import {
  addWindowTab,
  createTray,
  focusWindow,
  hiddenWindows,
  openExternalUrl,
  openPath,
  openWithMacOS,
  popupMenu,
  readClipboard,
  readClipboardText,
  showItemInFolder,
  writeClipboard,
  writeClipboardText,
  maximizeWindow,
  prepareBackgroundWindows,
  previewFile,
  printContents,
  revealAndFocus,
  revealWindow,
  setWindowFullScreen,
  showMessageBox,
  showNotification,
  showOpenDialog,
  showSaveDialog,
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
  for (const call of Object.values(electron.dialog)) call.mockClear();
  for (const call of Object.values(electron.shell)) call.mockClear();
  for (const call of Object.values(electron.clipboard)) call.mockClear();
  execFile.mockClear();
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

it("a hidden run answers native dialogs, Quick Look and printing as cancelled", async () => {
  const win = { previewFile: vi.fn() };
  const contents = { print: vi.fn() };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double for BrowserWindow
  const asParent = win as unknown as BrowserWindow;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double for WebContents
  const asContents = contents as unknown as Electron.WebContents;
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    vi.stubEnv("OPENMAIL_HIDDEN_WINDOWS", "1");
    const ask = { message: "Quit?", buttons: ["Cancel", "Quit"], cancelId: 0 };
    expect((await showMessageBox(ask)).response).toBe(0);
    expect(stderr).toHaveBeenCalledWith('Hidden windows: answered Cancel to "Quit?"\n');
    expect(await showOpenDialog(asParent, {})).toEqual({ canceled: true, filePaths: [] });
    expect((await showSaveDialog(null, {})).canceled).toBe(true);
    previewFile(asParent, "/tmp/a.pdf");
    const done = vi.fn();
    printContents(asContents, {}, done);
    expect(done).toHaveBeenCalledWith(false, "cancelled");
    for (const call of Object.values(electron.dialog)) expect(call).not.toHaveBeenCalled();
    expect(win.previewFile).not.toHaveBeenCalled();
    expect(contents.print).not.toHaveBeenCalled();

    vi.stubEnv("OPENMAIL_HIDDEN_WINDOWS", "");
    expect((await showMessageBox(ask)).response).toBe(1);
    expect((await showOpenDialog(asParent, {})).filePaths).toEqual(["/picked"]);
    expect(electron.dialog.showOpenDialog).toHaveBeenCalledWith(asParent, {});
    expect((await showSaveDialog(undefined, {})).filePath).toBe("/saved");
    expect(electron.dialog.showSaveDialog).toHaveBeenCalledWith({});
    previewFile(asParent, "/tmp/a.pdf");
    expect(win.previewFile).toHaveBeenCalledWith("/tmp/a.pdf");
    printContents(asContents, {}, done);
    expect(contents.print).toHaveBeenCalledWith({}, done);
  } finally {
    stderr.mockRestore();
  }
});

it("a hidden run opens nothing in another app and pops no menu; other runs pass every call on", async () => {
  const menu = { popup: vi.fn() };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double for Menu
  const asMenu = menu as unknown as Electron.Menu;
  const callback = vi.fn();
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    vi.stubEnv("OPENMAIL_HIDDEN_WINDOWS", "1");
    await expect(
      openExternalUrl("https://example.com/reset?token=secret"),
    ).resolves.toBeUndefined();
    expect(stderr).toHaveBeenCalledWith("Hidden windows: did not open a https://example.com URL\n");
    expect(stderr.mock.calls.join("")).not.toContain("secret");
    await expect(openPath("/tmp/batch/report.pdf")).resolves.toBe("");
    showItemInFolder("/tmp/batch/report.pdf");
    await expect(
      openWithMacOS(["-a", "/Applications/Preview.app", "--", "/tmp/a.pdf"], { timeout: 1 }),
    ).resolves.toBeUndefined();
    popupMenu(asMenu, { callback });
    expect(callback).toHaveBeenCalledTimes(1);
    for (const call of Object.values(electron.shell)) expect(call).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    expect(menu.popup).not.toHaveBeenCalled();

    vi.stubEnv("OPENMAIL_HIDDEN_WINDOWS", "");
    stderr.mockClear();
    await openExternalUrl("https://example.com/");
    expect(electron.shell.openExternal.mock.calls).toEqual([["https://example.com/"]]);
    await expect(openPath("/tmp/a.pdf")).resolves.toBe("No application");
    expect(electron.shell.openPath).toHaveBeenCalledWith("/tmp/a.pdf");
    showItemInFolder("/tmp/a.pdf");
    expect(electron.shell.showItemInFolder).toHaveBeenCalledWith("/tmp/a.pdf");
    const options = { timeout: 15_000 };
    await openWithMacOS(["-b", "com.apple.AddressBook", "/tmp/c.vcf"], options);
    expect(execFile).toHaveBeenCalledWith(
      "/usr/bin/open",
      ["-b", "com.apple.AddressBook", "/tmp/c.vcf"],
      options,
      expect.any(Function),
    );
    const failure = new Error("exit 1");
    execFile.mockImplementationOnce((_file, _args, _options, done) => done(failure));
    await expect(openWithMacOS(["-a", "Nope"], options)).rejects.toBe(failure);
    const popup = { window: undefined, callback };
    popupMenu(asMenu, popup);
    expect(menu.popup.mock.calls).toEqual([[popup]]);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(stderr).not.toHaveBeenCalled();
  } finally {
    stderr.mockRestore();
  }
});

it("a hidden run keeps clipboard writes in memory and reads them back", async () => {
  vi.stubEnv("OPENMAIL_HIDDEN_WINDOWS", "1");
  // Nothing from the person's clipboard leaks into the run.
  expect(await readClipboard()).toEqual([]);
  expect(await readClipboardText()).toBe("");
  await writeClipboardText("https://mail.google.com/mail/u/0/#all/abc");
  expect(await readClipboardText()).toBe("https://mail.google.com/mail/u/0/#all/abc");
  expect((await readClipboard()).map((item) => item.types)).toEqual([["text/plain"]]);
  const items = [new electron.ClipboardItem({ "text/uri-list": "file:///tmp/a.pdf" })];
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double for ClipboardItem
  await writeClipboard(items as unknown as Electron.ClipboardItem[]);
  expect(await readClipboard()).toEqual(items);
  expect(await readClipboardText()).toBe("");
  for (const call of Object.values(electron.clipboard)) expect(call).not.toHaveBeenCalled();

  vi.stubEnv("OPENMAIL_HIDDEN_WINDOWS", "");
  expect(await readClipboardText()).toBe("the user's text");
  expect(await readClipboard()).toEqual([{ types: ["text/plain"] }]);
  await writeClipboardText("link");
  expect(electron.clipboard.writeText).toHaveBeenCalledWith("link");
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double for ClipboardItem
  await writeClipboard(items as unknown as Electron.ClipboardItem[]);
  expect(electron.clipboard.write).toHaveBeenCalledWith(items);
});

/** Main-process sources, without tests and the standalone Electron test drivers. */
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
  });

/** Window methods that show, focus or raise a window. Only reveal.ts may name them. */
const WINDOW_METHODS = new Set([
  "show",
  "showInactive",
  "focus",
  "maximize",
  "setFullScreen",
  "addTabbedWindow",
  "moveTop",
  "setAlwaysOnTop",
]);
/**
 * Members that put native UI on screen: Quick Look, the print panel, the Dock bounce, the error
 * box, a popup or share menu, and DevTools.
 */
const NATIVE_UI = new Set([
  "previewFile",
  "print",
  "bounce",
  "showErrorBox",
  "popup",
  "openDevTools",
  "toggleDevTools",
]);
/** `shell` methods that open a URL, a file or a Finder window in another app. */
const SHELL_METHODS = new Set(["openExternal", "openPath", "showItemInFolder"]);
/** Electron modules whose methods the scan checks by receiver. */
const MODULES = new Set(["dialog", "shell", "clipboard"]);
/** Constructors whose object appears on screen: the menu-bar icon and notification banners. */
const NATIVE_OBJECTS = new Set(["Tray", "Notification"]);
/** Electron exports the scan follows through aliases. */
const TRACKED = new Set([...MODULES, ...NATIVE_OBJECTS, "BrowserWindow"]);
/** macOS `open`, which starts or raises another app. */
const OPEN_COMMAND = "/usr/bin/open";
/**
 * A deliberate exception: `// reveal-ok: <why this is safe in a hidden run>` on the flagged line
 * or the line above it. The reason must say something.
 */
const ALLOW = /\/\/\s*reveal-ok:\s*\S.{9,}/;

const memberName = (node: ts.Node) =>
  ts.isPropertyAccessExpression(node)
    ? node.name.text
    : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
      ? node.argumentExpression.text
      : undefined;
const propertyKey = (name: ts.PropertyName | ts.BindingName, source: ts.SourceFile) =>
  name.getText(source).replace(/["']/g, "");

/**
 * Local names for the Electron exports in TRACKED: `import { dialog as d } from "electron"`,
 * `const { shell: s } = electron` and `const c = electron.clipboard`, chained.
 */
function moduleAliases(source: ts.SourceFile) {
  const aliases = new Map<string, string>();
  const resolve = (node: ts.Expression): string | undefined =>
    ts.isIdentifier(node) ? (aliases.get(node.text) ?? node.text) : memberName(node);
  const visit = (node: ts.Node) => {
    if (ts.isImportSpecifier(node) && node.propertyName) {
      const imported = node.propertyName.text;
      if (TRACKED.has(imported)) aliases.set(node.name.text, imported);
    }
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name) && node.propertyName) {
      const key = propertyKey(node.propertyName, source);
      if (TRACKED.has(key)) aliases.set(node.name.text, key);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const target = resolve(node.initializer);
      if (target !== undefined && TRACKED.has(target)) aliases.set(node.name.text, target);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return resolve;
}

/** The rule a `module.member` access breaks, if any. */
function moduleRule(module: string | undefined, member: string) {
  if (module === "dialog" && member.startsWith("show")) return `dialog.${member}`;
  if (module === "shell" && SHELL_METHODS.has(member)) return `shell.${member}`;
  if (module === "clipboard" && (member.startsWith("write") || member === "clear"))
    return `clipboard.${member}`;
  return null;
}

/**
 * Every place in `text` that could put a window or native UI on screen without reveal.ts:
 * a BrowserWindow without `show: false`, any access to a window show or focus method (called,
 * optional-called, bracketed, destructured or passed on), native dialogs, Quick Look, printing,
 * the Dock, the tray, notifications, popup and share menus, DevTools, opening a URL, a file or a
 * Finder window in another app, macOS `open`, and clipboard writes. Electron modules are
 * followed through aliases. Returns "line: rule" entries.
 */
function bypasses(text: string): string[] {
  const source = ts.createSourceFile("scan.ts", text, ts.ScriptTarget.Latest, true);
  const lines = text.split("\n");
  const found: string[] = [];
  const resolve = moduleAliases(source);
  const flag = (node: ts.Node, rule: string) => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
    if (ALLOW.test(lines[line] ?? "") || ALLOW.test(lines[line - 1] ?? "")) return;
    found.push(`${line + 1}: ${rule}`);
  };
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node)) {
      const name = resolve(node.expression);
      if (name === "BrowserWindow") {
        const options = node.arguments?.[0];
        const hidden =
          options !== undefined &&
          ts.isObjectLiteralExpression(options) &&
          options.properties.some(
            (property) =>
              ts.isPropertyAssignment(property) &&
              propertyKey(property.name, source) === "show" &&
              property.initializer.kind === ts.SyntaxKind.FalseKeyword,
          );
        if (!hidden) flag(node, "new BrowserWindow without show: false");
      } else if (name !== undefined && NATIVE_OBJECTS.has(name)) flag(node, `new ${name}`);
    }
    const name = memberName(node);
    if (
      name !== undefined &&
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
    ) {
      const rule = moduleRule(resolve(node.expression), name);
      if (WINDOW_METHODS.has(name) || NATIVE_UI.has(name)) flag(node, `.${name}`);
      else if (rule) flag(node, rule);
    }
    // Destructuring takes the method off its object: `const { showMessageBox } = dialog`.
    if (ts.isBindingElement(node)) {
      const key = propertyKey(node.propertyName ?? node.name, source);
      const declaration = node.parent.parent;
      const from =
        ts.isVariableDeclaration(declaration) && declaration.initializer
          ? resolve(declaration.initializer)
          : undefined;
      if (
        WINDOW_METHODS.has(key) ||
        NATIVE_UI.has(key) ||
        SHELL_METHODS.has(key) ||
        key.startsWith("show") ||
        moduleRule(from, key)
      )
        flag(node, `destructured ${key}`);
    }
    if (ts.isStringLiteralLike(node) && node.text === OPEN_COMMAND) flag(node, OPEN_COMMAND);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

it("the bypass scan catches each way around reveal.ts", () => {
  const caught = [
    "new BrowserWindow({ width: 200 })",
    "new BrowserWindow()",
    "new BrowserWindow(options)",
    "new BrowserWindow({ show: true })",
    "new BrowserWindow({ show: visible })",
    "new electron.BrowserWindow({ width: 200 })",
    "win.show()",
    "win.show?.()",
    "win?.show()",
    'win["focus"]()',
    "win.focus.call(win)",
    "const raise = win.moveTop; raise()",
    "win.showInactive()",
    "win.maximize()",
    "win.setFullScreen(true)",
    "win.setAlwaysOnTop(true)",
    "win.addTabbedWindow(tab)",
    "win.previewFile(file)",
    "win.webContents.print()",
    "dialog.showMessageBox({})",
    'dialog["showOpenDialog"]({})',
    "electron.dialog.showSaveDialog({})",
    "dialog.showErrorBox('a', 'b')",
    "const { showErrorBox } = dialog",
    "const { show: reveal } = win",
    "new Tray(icon)",
    "new Notification({ title: 'x' })",
    "app.dock.bounce()",
    "app.dock?.show()",
    "app.focus({ steal: true })",
    "app.show()",
    "// reveal-ok:\nnew Tray(icon)",
    "// reveal-ok: short\nnew Tray(icon)",
    "shell.openExternal(url)",
    "electron.shell.openPath(file)",
    'shell["showItemInFolder"](file)',
    "const { openExternal } = shell",
    "const { openPath: open } = electron.shell",
    "new ShareMenu({ urls: [url] }).popup({ window: win })",
    "Menu.buildFromTemplate([]).popup({})",
    "menu.popup?.()",
    "win.webContents.openDevTools()",
    "contents.toggleDevTools()",
    "clipboard.writeText('x')",
    "clipboard.write([])",
    "electron.clipboard.writeImage(image)",
    "clipboard.clear()",
    "const { writeText } = clipboard",
    "import { dialog as d } from 'electron'; d.showMessageBox({})",
    "const { dialog: d } = electron; d.showOpenDialog({})",
    "const { dialog: d } = require('electron'); d.showSaveDialog({})",
    "const d = electron.dialog; d.showErrorBox('a', 'b')",
    "import { shell as s } from 'electron'; s.openExternal(url)",
    "import { clipboard as c } from 'electron'; const k = c; k.write([])",
    "import { clipboard as c } from 'electron'; const { writeText } = c",
    "import { Tray as T } from 'electron'; new T(icon)",
    "execFile('/usr/bin/open', ['-a', app, '--', file])",
  ];
  for (const fixture of caught) expect(bypasses(fixture), fixture).not.toEqual([]);
  const clean = [
    "new BrowserWindow({ width: 200, show: false })",
    "new BrowserWindow({ ...bounds, 'show': false })",
    "revealWindow(win); revealAndFocus(win); showNotification(notification)",
    "const options = { show: false, focus: true }",
    "// reveal-ok: constructs only, showNotification posts it\nnew Notification({ title: 'x' })",
    "new Tray(icon) // reveal-ok: this fixture checks the same-line form",
    "clipboard.read(); clipboard.readText(); clipboard.has('text/plain')",
    "deps.openPath(file); downloads.showItem(file)",
    "openExternalUrl(url); openPath(file); showItemInFolder(file); popupMenu(menu, {})",
    "readClipboardText(); writeClipboard(items); writeClipboardText(link)",
    "openWithMacOS(['-a', app, '--', file], { timeout: 15_000 })",
    "stream.write(chunk); const { write } = stream",
    "import { shell } from 'electron'; shell.trashItem(file)",
    "const { dialog } = electron; const options = { title: dialog.title }",
  ];
  for (const fixture of clean) expect(bypasses(fixture), fixture).toEqual([]);
});

it("only reveal.ts shows, focuses, maximizes or activates windows in the main process", () => {
  const main = path.join(desktopRoot, "src/main");
  const found = sources(main)
    .filter((file) => path.basename(file) !== "reveal.ts")
    .flatMap((file) =>
      bypasses(readFileSync(file, "utf8")).map((entry) => `${path.relative(main, file)}:${entry}`),
    );
  expect(found).toEqual([]);
});

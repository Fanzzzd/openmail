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
/** Members that put native UI on screen: Quick Look, the print panel, the Dock bounce. */
const NATIVE_UI = new Set(["previewFile", "print", "bounce", "showErrorBox"]);
/** Constructors whose object appears on screen: the menu-bar icon and notification banners. */
const NATIVE_OBJECTS = new Set(["Tray", "Notification"]);
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
const lastName = (node: ts.Expression) => (ts.isIdentifier(node) ? node.text : memberName(node));

/**
 * Every place in `text` that could put a window or native UI on screen without reveal.ts:
 * a BrowserWindow without `show: false`, any access to a window show or focus method (called,
 * optional-called, bracketed, destructured or passed on), native dialogs, Quick Look, printing, the Dock, the
 * tray and notifications. Returns "line: rule" entries.
 */
function bypasses(text: string): string[] {
  const source = ts.createSourceFile("scan.ts", text, ts.ScriptTarget.Latest, true);
  const lines = text.split("\n");
  const found: string[] = [];
  const flag = (node: ts.Node, rule: string) => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
    if (ALLOW.test(lines[line] ?? "") || ALLOW.test(lines[line - 1] ?? "")) return;
    found.push(`${line + 1}: ${rule}`);
  };
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node)) {
      const name = lastName(node.expression);
      if (name === "BrowserWindow") {
        const options = node.arguments?.[0];
        const hidden =
          options !== undefined &&
          ts.isObjectLiteralExpression(options) &&
          options.properties.some(
            (property) =>
              ts.isPropertyAssignment(property) &&
              property.name.getText(source).replace(/["']/g, "") === "show" &&
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
      if (WINDOW_METHODS.has(name) || NATIVE_UI.has(name)) flag(node, `.${name}`);
      else if (name.startsWith("show") && lastName(node.expression) === "dialog")
        flag(node, `dialog.${name}`);
    }
    // Destructuring takes the method off its object: `const { showMessageBox } = dialog`.
    if (ts.isBindingElement(node)) {
      const key = (node.propertyName ?? node.name).getText(source);
      if (WINDOW_METHODS.has(key) || NATIVE_UI.has(key) || key.startsWith("show"))
        flag(node, `destructured ${key}`);
    }
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
  ];
  for (const fixture of caught) expect(bypasses(fixture), fixture).not.toEqual([]);
  const clean = [
    "new BrowserWindow({ width: 200, show: false })",
    "new BrowserWindow({ ...bounds, 'show': false })",
    "revealWindow(win); revealAndFocus(win); showNotification(notification)",
    "const options = { show: false, focus: true }",
    "// reveal-ok: constructs only, showNotification posts it\nnew Notification({ title: 'x' })",
    "new Tray(icon) // reveal-ok: this fixture checks the same-line form",
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

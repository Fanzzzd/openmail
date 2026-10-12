import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ sent: vi.fn() }));
vi.mock("electron", () => ({
  app: new EventEmitter(),
  BrowserWindow: { getAllWindows: () => [] },
  session: { defaultSession: {} },
  Menu: {},
}));
vi.mock("./window-ui", () => ({ sendWindowUi: native.sent }));

const fakeWindow = (id: number) => {
  const contents = Object.assign(new EventEmitter(), {
    id,
    mainFrame: {},
    executeJavaScript: vi.fn(() => Promise.resolve(false)),
    isDestroyed: () => false,
    replaceMisspelling: vi.fn(),
    cut: vi.fn(),
    copy: vi.fn(),
    paste: vi.fn(),
    selectAll: vi.fn(),
    session: { addWordToSpellCheckerDictionary: vi.fn() },
  });
  return Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false });
};

it("right-clicks become a TextMenu event; commands act on the main process's own record", async () => {
  vi.doUnmock("./spellcheck");
  vi.resetModules();
  const { app } = await import("electron");
  const { installSpellingMenu, textMenuCommand, configureSpelling } = await import("./spellcheck");
  const save = vi.fn();
  const stop = installSpellingMenu(save);
  configureSpelling({ spellcheck: true, spellcheckLanguages: [] });
  const win = fakeWindow(3);
  app.emit("browser-window-created", undefined, win);
  try {
    win.webContents.emit("context-menu", undefined, {
      isEditable: true,
      frame: {},
      x: 10,
      y: 20,
      misspelledWord: "helo",
      dictionarySuggestions: ["hello", "help"],
      editFlags: { canCut: false, canCopy: true, canPaste: true },
    });
    await vi.waitFor(() => expect(native.sent).toHaveBeenCalledTimes(1));
    expect(native.sent).toHaveBeenCalledWith(3, {
      _tag: "TextMenu",
      menu: {
        x: 10,
        y: 20,
        misspelledWord: "helo",
        suggestions: ["hello", "help"],
        spellcheck: true,
        canCut: false,
        canCopy: true,
        canPaste: true,
        writingTools: false,
      },
    });

    textMenuCommand(win, { kind: "replace", word: "hello" });
    expect(win.webContents.replaceMisspelling).toHaveBeenCalledWith("hello");
    // A renderer cannot inject text that Chromium did not suggest.
    textMenuCommand(win, { kind: "replace", word: "<script>" });
    expect(win.webContents.replaceMisspelling).toHaveBeenCalledTimes(1);

    textMenuCommand(win, { kind: "learn" });
    expect(win.webContents.session.addWordToSpellCheckerDictionary).toHaveBeenCalledWith("helo");

    textMenuCommand(win, { kind: "toggleSpellcheck" });
    expect(save).toHaveBeenCalledWith({ spellcheck: false });

    for (const kind of ["cut", "copy", "paste", "selectAll"] as const) {
      textMenuCommand(win, { kind });
      expect(win.webContents[kind]).toHaveBeenCalledTimes(1);
    }

    // Another window has no recorded right-click, so nothing is replaced or learned there.
    const other = fakeWindow(4);
    textMenuCommand(other, { kind: "replace", word: "hello" });
    textMenuCommand(other, { kind: "learn" });
    expect(other.webContents.replaceMisspelling).not.toHaveBeenCalled();
    expect(other.webContents.session.addWordToSpellCheckerDictionary).not.toHaveBeenCalled();

    win.webContents.emit("context-menu", undefined, {
      isEditable: false,
      frame: {},
      x: 0,
      y: 0,
      misspelledWord: "",
      dictionarySuggestions: [],
      editFlags: { canCut: false, canCopy: false, canPaste: false },
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(native.sent).toHaveBeenCalledTimes(1);
  } finally {
    stop();
  }
});

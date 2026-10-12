import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";

const native = vi.hoisted(() => {
  vi.resetModules();
  return { popup: vi.fn(), sent: vi.fn() };
});
vi.mock("electron", () => ({
  app: new EventEmitter(),
  BrowserWindow: { getAllWindows: () => [] },
  session: { defaultSession: {} },
  Menu: { buildFromTemplate: () => ({ popup: native.popup }) },
}));
vi.mock("./window-ui", () => ({ sendWindowUi: native.sent }));

it.skipIf(process.platform !== "darwin")(
  "offers Writing Tools only for the compose body in the main frame, and pops it at that frame",
  async () => {
    vi.doUnmock("./spellcheck");
    vi.resetModules();
    const { app } = await import("electron");
    const { installSpellingMenu, popupWritingTools, textMenuCommand } =
      await import("./spellcheck");
    const frame = {};
    const script = vi.fn<(script: string) => Promise<boolean>>(() => Promise.resolve(true));
    const contents = Object.assign(new EventEmitter(), {
      id: 7,
      mainFrame: frame,
      executeJavaScript: script,
      isDestroyed: () => false,
      replaceMisspelling: vi.fn(),
      cut: vi.fn(),
      copy: vi.fn(),
      paste: vi.fn(),
      selectAll: vi.fn(),
      session: { addWordToSpellCheckerDictionary: vi.fn() },
    });
    const win = Object.assign(new EventEmitter(), {
      webContents: contents,
      isDestroyed: () => false,
    });
    const stop = installSpellingMenu(vi.fn());
    app.emit("browser-window-created", undefined, win);
    const params = {
      isEditable: true,
      frame,
      x: 50,
      y: 100,
      misspelledWord: "",
      dictionarySuggestions: [],
      editFlags: { canCut: true, canCopy: true, canPaste: true },
    };
    const lastMenu = () => native.sent.mock.lastCall?.[1]?.menu;
    try {
      contents.emit("context-menu", undefined, params);
      await vi.waitFor(() => expect(lastMenu()).toMatchObject({ writingTools: true, x: 50 }));
      expect(script.mock.lastCall?.[0]).toContain("data-openmail-compose-body");
      // IO seam: the fake window stands in for a BrowserWindow.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const target = win as unknown as Electron.BrowserWindow;
      textMenuCommand(win, { kind: "writingTools" }, (state) => popupWritingTools(target, state));
      expect(native.popup.mock.lastCall?.[0]).toEqual({ window: win, frame, x: 50, y: 100 });

      script.mockResolvedValue(false);
      native.sent.mockClear();
      native.popup.mockClear();
      contents.emit("context-menu", undefined, params);
      await vi.waitFor(() => expect(lastMenu()).toMatchObject({ writingTools: false }));
      textMenuCommand(win, { kind: "writingTools" }, (state) => popupWritingTools(target, state));
      expect(native.popup).not.toHaveBeenCalled();

      script.mockClear();
      native.sent.mockClear();
      contents.emit("context-menu", undefined, { ...params, frame: {} });
      await vi.waitFor(() => expect(lastMenu()).toMatchObject({ writingTools: false }));
      expect(script).not.toHaveBeenCalled();

      native.sent.mockClear();
      contents.emit("context-menu", undefined, { ...params, isEditable: false });
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
      expect(native.sent).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  },
);

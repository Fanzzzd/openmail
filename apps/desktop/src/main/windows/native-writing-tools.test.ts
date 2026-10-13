import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { waitLimit } from "../../../../../packages/core/test-support/test-time.js";

const native = vi.hoisted(() => {
  vi.resetModules();
  return { sent: vi.fn() };
});
vi.mock("electron", () => ({
  app: new EventEmitter(),
  BrowserWindow: { getAllWindows: () => [] },
  session: { defaultSession: {} },
  Menu: { buildFromTemplate: vi.fn() },
}));
vi.mock("./window-ui", () => ({ sendWindowUi: native.sent }));

it.skipIf(process.platform !== "darwin")(
  "offers Writing Tools only for the compose body in the main frame, and pops it at that frame",
  async () => {
    vi.doUnmock("./spellcheck");
    vi.resetModules();
    const { app } = await import("electron");
    const { installSpellingMenu, textMenuCommand } = await import("./spellcheck");
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
      await vi.waitFor(
        () => expect(lastMenu()).toMatchObject({ writingTools: true, x: 50 }),
        waitLimit,
      );
      expect(script.mock.lastCall?.[0]).toContain("data-openmail-compose-body");
      const openWritingTools = vi.fn<(state: { frame?: unknown; x: number; y: number }) => void>();
      textMenuCommand(win, { kind: "writingTools" }, openWritingTools);
      expect(openWritingTools.mock.lastCall?.[0]).toMatchObject({ frame, x: 50, y: 100 });

      script.mockResolvedValue(false);
      native.sent.mockClear();
      openWritingTools.mockClear();
      contents.emit("context-menu", undefined, params);
      await vi.waitFor(() => expect(lastMenu()).toMatchObject({ writingTools: false }), waitLimit);
      textMenuCommand(win, { kind: "writingTools" }, openWritingTools);
      expect(openWritingTools).not.toHaveBeenCalled();

      script.mockClear();
      native.sent.mockClear();
      contents.emit("context-menu", undefined, { ...params, frame: {} });
      await vi.waitFor(() => expect(lastMenu()).toMatchObject({ writingTools: false }), waitLimit);
      expect(script).not.toHaveBeenCalled();

      // A read-only right-click sends nothing: the editable one after it is the only new menu.
      native.sent.mockClear();
      contents.emit("context-menu", undefined, { ...params, isEditable: false, x: 1 });
      contents.emit("context-menu", undefined, { ...params, x: 2 });
      await vi.waitFor(() => expect(native.sent).toHaveBeenCalledTimes(1), waitLimit);
      expect(lastMenu()).toMatchObject({ x: 2 });
    } finally {
      stop();
    }
  },
);

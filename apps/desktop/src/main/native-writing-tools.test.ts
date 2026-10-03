import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";

const native = vi.hoisted(() => {
  vi.resetModules();
  return { popup: vi.fn() };
});
vi.mock("electron", () => ({
  app: new EventEmitter(),
  BrowserWindow: { getAllWindows: () => [] },
  session: { defaultSession: {} },
  Menu: { buildFromTemplate: () => ({ popup: native.popup }) },
}));

it.skipIf(process.platform !== "darwin")(
  "enables Apple menu extensions only for the compose body in the main frame",
  async () => {
    vi.doUnmock("./spellcheck");
    vi.resetModules();
    const { app } = await import("electron");
    const { installSpellingMenu } = await import("./spellcheck");
    const frame = {};
    const script = vi.fn<(script: string) => Promise<boolean>>(() => Promise.resolve(true));
    const contents = Object.assign(new EventEmitter(), {
      mainFrame: frame,
      executeJavaScript: script,
      isDestroyed: () => false,
    });
    const win = Object.assign(new EventEmitter(), {
      webContents: contents,
      isDestroyed: () => false,
    });
    const stop = installSpellingMenu(
      () => ({ add: "Add", check: "Check", noSuggestions: "None" }),
      vi.fn(),
    );
    app.emit("browser-window-created", undefined, win);
    const params = {
      isEditable: true,
      frame,
      x: 50,
      y: 100,
      misspelledWord: "",
      dictionarySuggestions: [],
    };
    try {
      contents.emit("context-menu", undefined, params);
      await vi.waitFor(() =>
        expect(native.popup.mock.lastCall?.[0]).toEqual({ window: win, frame }),
      );
      expect(script.mock.lastCall?.[0]).toContain("data-openmail-compose-body");
      script.mockResolvedValue(false);
      native.popup.mockClear();
      contents.emit("context-menu", undefined, params);
      await vi.waitFor(() => expect(native.popup.mock.lastCall?.[0]).toEqual({ window: win }));
      script.mockClear();
      native.popup.mockClear();
      contents.emit("context-menu", undefined, { ...params, frame: {} });
      await vi.waitFor(() => expect(native.popup.mock.lastCall?.[0]).toEqual({ window: win }));
      expect(script).not.toHaveBeenCalled();
      native.popup.mockClear();
      contents.emit("context-menu", undefined, { ...params, isEditable: false });
      expect(native.popup).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  },
);

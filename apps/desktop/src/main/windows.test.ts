import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: true },
  nativeTheme: { shouldUseDarkColors: false },
  shell: { openExternal: vi.fn(() => Promise.resolve()) },
  BrowserWindow: class {
    webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: vi.fn(),
    });
  },
}));

import { BrowserWindow, shell } from "electron";
import { lockNavigation } from "./windows";

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

it("retains the existing external popup route and never creates a popup window", () => {
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
    if (url.startsWith("javascript:")) expect(vi.mocked(shell).openExternal.mock.calls).toEqual([]);
    else expect(vi.mocked(shell).openExternal.mock.calls).toEqual([[url]]);
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

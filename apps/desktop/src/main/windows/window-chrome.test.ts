import { expect, it, vi } from "vitest";

import { setTitlebarHeight, trafficLightOptions, type ChromeWindow } from "./window-chrome";

const fakeWindow = (zoom = 1) => ({
  isDestroyed: () => false,
  setWindowButtonPosition: vi.fn<ChromeWindow["setWindowButtonPosition"]>(),
  webContents: { getZoomFactor: () => zoom },
});

it("opens windows with the lights centred in the default 52 px header and the overlay API on", () => {
  expect(trafficLightOptions()).toEqual({
    titleBarStyle: "hiddenInset",
    titleBarOverlay: true,
    trafficLightPosition: { x: 18, y: 19 },
  });
});

it("centres the lights in the reported header, once per position", () => {
  const win = fakeWindow();
  setTitlebarHeight(win, 44, true);
  setTitlebarHeight(win, 44, true);
  expect(win.setWindowButtonPosition.mock.calls).toEqual([[{ x: 18, y: 15 }]]);
  setTitlebarHeight(win, 52, true);
  expect(win.setWindowButtonPosition).toHaveBeenLastCalledWith({ x: 18, y: 19 });
});

it("converts the CSS header height to window points under page zoom", () => {
  const win = fakeWindow(1.5);
  setTitlebarHeight(win, 52, true);
  expect(win.setWindowButtonPosition).toHaveBeenCalledWith({ x: 18, y: 32 });
});

it("leaves windows alone off the Mac and once destroyed", () => {
  const win = fakeWindow();
  setTitlebarHeight(win, 44, false);
  setTitlebarHeight(null, 44, true);
  setTitlebarHeight({ ...win, isDestroyed: () => true }, 44, true);
  expect(win.setWindowButtonPosition).not.toHaveBeenCalled();
});

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { TitlebarArea } from "../../../shared/window-chrome";
import { SETTLE_MS, titlebarAreaStore } from "./titlebar-area";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const lights = { x: 96, y: 0, height: 52 };
// What Electron reports for one frame after each resize on macOS 26.
const resizing = { x: 87, y: 0, height: 52 };

function overlay(initial: TitlebarArea | null) {
  let rect = initial;
  const store = titlebarAreaStore(() => rect);
  const changes = vi.fn();
  store.subscribe(changes);
  return {
    store,
    changes,
    report: (next: TitlebarArea | null) => {
      rect = next;
      store.update();
    },
  };
}

it("keeps the area through the one-frame rect Electron reports after every resize", () => {
  const { store, changes, report } = overlay(lights);
  const before = store.get();
  for (let step = 0; step < 20; step++) {
    report(resizing);
    expect(store.get()).toBe(before);
    vi.advanceTimersByTime(16);
    report({ ...lights });
    expect(store.get()).toBe(before);
    vi.advanceTimersByTime(16);
  }
  vi.advanceTimersByTime(SETTLE_MS);
  expect(store.get()).toBe(before);
  expect(changes).not.toHaveBeenCalled();
});

it("follows the lights once a new rect holds", () => {
  const { store, changes, report } = overlay(lights);
  report({ x: 70, y: 0, height: 38 });
  vi.advanceTimersByTime(SETTLE_MS - 1);
  expect(store.get()).toEqual(lights);
  vi.advanceTimersByTime(1);
  expect(store.get()).toEqual({ x: 70, y: 0, height: 38 });
  expect(changes).toHaveBeenCalledTimes(1);
});

it("drops and restores the lights at once around full screen", () => {
  const { store, changes, report } = overlay(lights);
  report(null);
  expect(store.get()).toBeNull();
  expect(changes).toHaveBeenCalledTimes(1);
  // Leaving full screen can land on the resize frame; the settled read corrects it.
  report(resizing);
  expect(store.get()).toEqual(resizing);
  report(lights);
  vi.advanceTimersByTime(SETTLE_MS);
  expect(store.get()).toEqual(lights);
  expect(changes).toHaveBeenCalledTimes(3);
});

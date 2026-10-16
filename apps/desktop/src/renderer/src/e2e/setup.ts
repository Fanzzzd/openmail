import * as React from "react";
import { constVoid } from "effect/Function";
import { beforeAll, vi } from "vitest";
import { scaledMs } from "../../../../../../packages/core/test-support/test-time.js";

// See lazy-loads.ts. The second call, from React.lazy, gets the same cached module.
vi.mock("../ui/lazy-dialog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ui/lazy-dialog")>();
  const { lazyLoads } = await import("./lazy-loads");
  const lazyDialog: typeof actual.lazyDialog = (load) => {
    lazyLoads.push(load());
    return actual.lazyDialog(load);
  };
  return { lazyDialog };
});

/**
 * React's act environment is on exactly while an act() scope is open.
 *
 * The flows import @testing-library/react/pure. Its act() sets
 * IS_REACT_ACT_ENVIRONMENT for the call and restores the previous value when
 * the call ends, so overlapping acts (an eventually() poll while an RPC reply
 * renders) leave it false inside an open scope, and React logs "not configured
 * to support act" for each update: about 3,500 lines a run. Setting it to true
 * for good is worse: RPC replies and Effect atoms update the tree between
 * polls, outside any act, and React logs "not wrapped in act" for each one:
 * about 70,000 lines. The flows wait for those updates with eventually(), so
 * neither warning points at a real fault.
 */
const reactInternals: object = Reflect.get(
  React,
  "__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE",
);
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  get: () => Reflect.get(reactInternals, "actQueue") !== null,
  // Testing Library's act() writes the flag; the getter already answers for it.
  set: constVoid,
});

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: constVoid,
    removeListener: constVoid,
    addEventListener: constVoid,
    removeEventListener: constVoid,
    dispatchEvent: () => false,
  }),
});
class ResizeObserverStub {
  observe = constVoid;
  unobserve = constVoid;
  disconnect = constVoid;
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);
HTMLElement.prototype.scrollIntoView = constVoid;
// jsdom has no layout; its window.scrollTo only logs "Not implemented".
window.scrollTo = constVoid;
/** The Mac's traffic lights as the Window Controls Overlay reports them on macOS 26. */
class WindowControlsOverlayStub extends EventTarget {
  visible = true;
  getTitlebarAreaRect = () => DOMRect.fromRect({ x: 96, y: 0, width: 904, height: 52 });
}
Object.defineProperty(navigator, "windowControlsOverlay", {
  configurable: true,
  value: new WindowControlsOverlayStub(),
});
HTMLElement.prototype.getBoundingClientRect = () => ({
  x: 0,
  y: 0,
  width: 1000,
  height: 800,
  top: 0,
  left: 0,
  bottom: 800,
  right: 1000,
  toJSON: () => ({}),
});
Object.defineProperty(HTMLElement.prototype, "innerText", {
  configurable: true,
  get() {
    return this.textContent;
  },
  set(value: string) {
    this.textContent = value;
  },
});

// Settings is a lazy chunk. Under load its first import can outlast a
// findByRole wait, so every e2e file loads it before its tests run.
beforeAll(async () => {
  await import("../features/settings/Settings");
}, scaledMs(60_000));

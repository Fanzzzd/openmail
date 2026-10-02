import { constVoid } from "effect/Function";
import { vi } from "vitest";

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

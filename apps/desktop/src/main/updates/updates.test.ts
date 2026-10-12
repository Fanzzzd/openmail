import { EventEmitter } from "node:events";
import { Effect } from "effect";
import { beforeEach, expect, it, vi } from "vitest";

type Window = EventEmitter & { isVisible(): boolean };
const native = vi.hoisted(() => ({ windows: new Map<number, Window>() }));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    app: new EventEmitter(),
    BrowserWindow: { getAllWindows: () => [...native.windows.values()] },
  };
});
import { app } from "electron";
import { shown } from "./updates";

beforeEach(() => {
  native.windows.clear();
  app.removeAllListeners();
});
it("update startup waits for the displayed window and releases its listeners", async () => {
  let finished = false;
  const pending = Effect.runPromise(shown).then(() => {
    finished = true;
    return true;
  });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  expect(finished).toBe(false);
  const window = Object.assign(new EventEmitter(), { isVisible: () => false });
  native.windows.set(1, window);
  app.emit("browser-window-created", null, window);
  window.emit("ready-to-show");
  await Promise.resolve();
  expect(finished).toBe(false);
  window.emit("show");
  await pending;
  expect(finished).toBe(true);
  expect(app.listenerCount("browser-window-created")).toBe(0);
  expect(window.listenerCount("show")).toBe(0);
});
it("an existing visible window allows update startup immediately", async () => {
  native.windows.set(1, Object.assign(new EventEmitter(), { isVisible: () => true }));
  await Effect.runPromise(shown);
  expect(app.listenerCount("browser-window-created")).toBe(0);
});

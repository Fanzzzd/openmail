import { EventEmitter } from "node:events";
import { Effect, Fiber, Stream } from "effect";
import { constVoid } from "effect/Function";
import { expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
}));
import type { PromptAnswer, WindowUiEvent } from "../shared/window-ui";
import { withDeadline } from "./deadline";
import { answerPrompt, askWindow, sendWindowUi, windowUiEvents } from "./window-ui";

const target = (id: number) =>
  Object.assign(new EventEmitter(), { webContents: { id }, isDestroyed: () => false });

/** Subscribes like a renderer and returns what it received. */
const listen = (id: number) => {
  const received: WindowUiEvent[] = [];
  const fiber = Effect.runFork(
    windowUiEvents(id).pipe(
      Stream.runForEach((event) => Effect.sync(() => received.push(event))),
      Effect.scoped,
    ),
  );
  return { received, stop: () => Effect.runPromise(Fiber.interrupt(fiber)) };
};
const tick = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
const quit = (id: string): WindowUiEvent => ({ _tag: "QuitPrompt", id });
const promptId = (event: WindowUiEvent | undefined) => (event && "id" in event ? event.id : "");

it("with no renderer listening, the native fallback answers", async () => {
  const fallback = vi.fn(() => Promise.resolve<PromptAnswer>("accept"));
  expect(await askWindow(target(1), quit, fallback)).toBe("accept");
  expect(await askWindow(null, quit, fallback)).toBe("accept");
  expect(fallback).toHaveBeenCalledTimes(2);
  expect(sendWindowUi(1, quit("x"))).toBe(false);
});

it("once painted the React prompt answers with no deadline, and only its own window can answer", async () => {
  const renderer = listen(2);
  await tick();
  const fallback = vi.fn(() => Promise.resolve<PromptAnswer>("accept"));
  const result = askWindow(target(2), quit, fallback, 50);
  await vi.waitFor(() => expect(renderer.received).toHaveLength(1), { interval: 1 });
  const id = promptId(renderer.received[0]);
  answerPrompt(2, id, "shown");
  answerPrompt(99, id, "accept");
  await new Promise((resolve) => {
    setTimeout(resolve, 100);
  });
  answerPrompt(2, id, "cancel");
  expect(await result).toBe("cancel");
  expect(fallback).not.toHaveBeenCalled();
  await renderer.stop();
});

it("an unpainted prompt is withdrawn and the native box asks instead", async () => {
  const renderer = listen(3);
  await tick();
  const fallback = vi.fn(() => Promise.resolve<PromptAnswer>("accept"));
  expect(await askWindow(target(3), quit, fallback, 10)).toBe("accept");
  await vi.waitFor(() => expect(renderer.received).toHaveLength(2));
  expect(renderer.received[1]).toEqual({ _tag: "PromptDone", id: promptId(renderer.received[0]) });
  await renderer.stop();
});

it("closing the window or losing its renderer cancels a shown prompt", async () => {
  const renderer = listen(4);
  await tick();
  const fallback = vi.fn(() => Promise.resolve<PromptAnswer>("accept"));
  const win = target(4);
  const closed = askWindow(win, quit, fallback, 1000);
  win.emit("closed");
  expect(await closed).toBe("cancel");
  expect(win.listenerCount("closed")).toBe(0);

  const reloaded = askWindow(target(4), quit, fallback, 1000);
  await vi.waitFor(() => expect(renderer.received).toHaveLength(2));
  answerPrompt(4, promptId(renderer.received[1]), "shown");
  await renderer.stop();
  expect(await reloaded).toBe("cancel");
  expect(fallback).not.toHaveBeenCalled();
  expect(sendWindowUi(4, quit("y"))).toBe(false);
});

it("withDeadline resolves timeout only when the promise is late", async () => {
  expect(await withDeadline(Promise.resolve(1), 10)).toBe(1);
  expect(await withDeadline(new Promise(constVoid), 5)).toBe("timeout");
});

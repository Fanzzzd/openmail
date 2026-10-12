import { constVoid } from "effect/Function";
import { expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, BrowserWindow: vi.fn(), ipcMain: {} }));
vi.mock("./security", () => ({ denyNavigation: vi.fn() }));
import type { RecoveryPrompt } from "../shared/recovery";
import { recoveryPrompt, type RecoverySurface } from "./recovery-window";

const prompt: RecoveryPrompt = {
  locale: "en",
  tone: "warning",
  message: "OpenMail closed unexpectedly",
  detail: "Reset the local cache?",
  buttons: ["Reset", "Keep"],
  defaultId: 1,
  cancelId: 1,
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  promise.catch(constVoid);
  return { promise, resolve, reject };
};
const surface = () => {
  const painted = deferred<void>();
  const answer = deferred<number>();
  const close = vi.fn();
  const value: RecoverySurface = { painted: painted.promise, answer: answer.promise, close };
  return { painted, answer, close, value };
};

it("the React window's answer wins once it has painted", async () => {
  const window = surface();
  const fallback = vi.fn(() => Promise.resolve(1));
  const result = recoveryPrompt(prompt, { open: () => window.value, fallback, paintMs: 50 });
  window.painted.resolve();
  window.answer.resolve(0);
  expect(await result).toBe(0);
  expect(fallback).not.toHaveBeenCalled();
});

it("a window that does not paint in time is closed and the native box asks instead", async () => {
  const window = surface();
  const fallback = vi.fn(() => Promise.resolve(0));
  expect(await recoveryPrompt(prompt, { open: () => window.value, fallback, paintMs: 10 })).toBe(0);
  expect(window.close).toHaveBeenCalled();
  expect(fallback).toHaveBeenCalledWith(prompt);
});

it("load failures, renderer crashes after paint, and a throwing open all fall back", async () => {
  const failedLoad = surface();
  failedLoad.painted.reject(new Error("did-fail-load"));
  const fallback = vi.fn(() => Promise.resolve(1));
  expect(
    await recoveryPrompt(prompt, { open: () => failedLoad.value, fallback, paintMs: 1000 }),
  ).toBe(1);

  const crashed = surface();
  const result = recoveryPrompt(prompt, { open: () => crashed.value, fallback, paintMs: 1000 });
  crashed.painted.resolve();
  await Promise.resolve();
  crashed.answer.reject(new Error("render-process-gone"));
  expect(await result).toBe(1);
  expect(crashed.close).toHaveBeenCalled();

  expect(
    await recoveryPrompt(prompt, {
      open: () => {
        throw new Error("no display");
      },
      fallback,
    }),
  ).toBe(1);
  expect(fallback).toHaveBeenCalledTimes(3);
});

/**
 * Vitest setup file: `vi.waitFor` and `vi.waitUntil` calls without their own `timeout` wait
 * `waitLimit`, scaled by `testTimeScale`, instead of Vitest's fixed one second. Desktop and the
 * CLI load it through `setupFiles`; `expect.poll` gets the same limit from `pollDefaults` in the
 * config. A call that passes a timeout keeps it.
 */
import { vi } from "vitest";
import { waitLimit } from "./test-time.js";

type WaitOptions = number | { readonly timeout?: number; readonly interval?: number };

const scaled = (options: WaitOptions | undefined) =>
  typeof options === "number" ? options : { ...waitLimit, ...options };

const waitFor = vi.waitFor.bind(vi);
const waitUntil = vi.waitUntil.bind(vi);
Object.assign(vi, {
  waitFor: <T>(callback: () => T | Promise<T>, options?: WaitOptions) =>
    waitFor(callback, scaled(options)),
  waitUntil: <T>(callback: () => T | Promise<T>, options?: WaitOptions) =>
    waitUntil(callback, scaled(options)),
});

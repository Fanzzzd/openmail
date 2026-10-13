import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { MAX_PROCESS_ERRORS, registerProcessErrorHandlers } from "./process-errors";

it("records uncaught exceptions and rejections once each, with a fixed reason", () => {
  const target = new EventEmitter();
  const log = vi.fn();
  const write = vi.fn();
  expect(registerProcessErrorHandlers(log, target, write)).toBe(true);
  expect(registerProcessErrorHandlers(log, target, write)).toBe(false);
  expect(target.listenerCount("uncaughtException")).toBe(1);
  expect(target.listenerCount("unhandledRejection")).toBe(1);
  target.emit("uncaughtException", new Error("boom /Users/someone/mail.db"));
  target.emit("unhandledRejection", "rejected");
  expect(log.mock.calls).toEqual([
    ["runtime-error", { reason: "uncaught-exception" }],
    ["runtime-error", { reason: "unhandled-rejection" }],
  ]);
  expect(write).toHaveBeenCalledWith(expect.stringContaining("boom"));
});

it("a fault in a loop is capped and a failing logger does not throw from the handler", () => {
  const target = new EventEmitter();
  const log = vi.fn(() => {
    throw new Error("disk full");
  });
  registerProcessErrorHandlers(log, target, vi.fn());
  for (let i = 0; i < MAX_PROCESS_ERRORS + 10; i++)
    expect(() => target.emit("uncaughtException", new Error("again"))).not.toThrow();
  expect(log).toHaveBeenCalledTimes(MAX_PROCESS_ERRORS);
});

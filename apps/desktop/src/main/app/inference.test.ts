import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock("electron", () => ({ utilityProcess: { fork: state.fork } }));
import { desktopSearchProcess } from "./inference";

class Child extends EventEmitter {
  pid: number | undefined;
  kill = vi.fn(() => true);
  postMessage = vi.fn();
}
let child: Child;
const signals: unknown[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  state.fork.mockReset();
  child = new Child();
  state.fork.mockReturnValue(child);
  // No test may signal a real process, even if an assertion fails before emitting exit.
  signals.length = 0;
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    signals.push([pid, signal]);
    return true;
  });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const launch = () => desktopSearchProcess("/fixed/core/search-worker.js", "/tmp/copy/mail.db");

it("uses Electron utilityProcess with only the core entry and database argument", async () => {
  child.pid = 42;
  const reader = launch();
  expect(state.fork).toHaveBeenCalledWith(
    "/fixed/core/search-worker.js",
    ["/tmp/copy/mail.db"],
    expect.objectContaining({
      serviceName: "OpenMail local search",
      stdio: "ignore",
      execArgv: ["--max-old-space-size=192"],
    }),
  );
  reader.send({ kind: "threads", query: { search: "meeting" } });
  expect(child.postMessage).toHaveBeenCalledWith(
    { kind: "threads", query: { search: "meeting" } },
    [],
  );
  const stopping = reader.kill();
  child.emit("exit", 0);
  await stopping;
});

it("a late IPC error after the request listener is removed never becomes unhandled", async () => {
  child.pid = 42;
  const reader = launch();
  const failed = vi.fn();
  const off = reader.onFailure(failed);
  child.postMessage.mockImplementationOnce(() => {
    throw new Error("IPC closing");
  });
  expect(() => reader.send({ kind: "threads" })).toThrow("IPC closing");
  off();
  const stopping = reader.kill();
  expect(() => child.emit("error", "FatalError", "IPC", "")).not.toThrow();
  expect(failed).not.toHaveBeenCalled();
  child.pid = undefined;
  child.emit("exit", 1);
  await stopping;
});

it("a failed launch with no pid settles shutdown, and any late spawn is killed", async () => {
  const reader = launch();
  const failed = vi.fn();
  reader.onFailure(failed);
  child.emit("error", "FatalError", "startup", "");
  expect(failed).toHaveBeenCalledOnce();
  await expect(reader.kill()).resolves.toBeUndefined();
  child.pid = 42;
  child.emit("spawn");
  expect(child.kill).toHaveBeenCalledOnce();
  child.pid = undefined;
  child.emit("exit", 1);
});

it("cancelling before spawn waits for exit and kills the child when it spawns", async () => {
  const reader = launch();
  child.kill.mockReturnValue(false);
  const stopping = reader.kill();
  child.pid = 42;
  child.emit("spawn");
  expect(child.kill).toHaveBeenCalledTimes(2);
  child.pid = undefined;
  child.emit("exit", 0);
  await stopping;
});

it("shutdown is idempotent and force-kills a busy native reader after 200 ms", async () => {
  child.pid = 42;
  const reader = launch();
  const first = reader.kill();
  const second = reader.kill();
  expect(first).toBe(second);
  expect(child.kill).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(200);
  expect(signals).toEqual([[42, "SIGKILL"]]);
  child.pid = undefined;
  child.emit("exit", 0);
  await first;
});

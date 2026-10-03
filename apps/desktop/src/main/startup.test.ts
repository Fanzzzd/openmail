import { Effect, Layer, Logger } from "effect";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  primary: true,
  failStart: false,
  warnStart: false,
  diagnosticLog: vi.fn(),
  localLog: vi.fn(),
  exit: vi.fn(),
  nodeMailbox: vi.fn(),
  vision: vi.fn(),
  urls: vi.fn(),
  focus: vi.fn(),
  register: vi.fn(),
  cleanup: vi.fn(),
}));
vi.mock("electron", () => ({
  app: Object.assign(new EventEmitter(), {
    commandLine: { getSwitchValue: () => "" },
    setPath: vi.fn(),
    getPath: vi.fn(() => "/tmp/openmail-test-temp"),
    requestSingleInstanceLock: () => native.primary,
    exit: native.exit,
    isReady: () => true,
    isPackaged: true,
    setAsDefaultProtocolClient: native.register,
  }),
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  shell: { openExternal: vi.fn() },
  powerMonitor: { isOnBatteryPower: () => false, getSystemIdleTime: () => 6 },
}));
vi.mock("@openmail/core", () => ({
  unavailableVision: {
    available: false,
    version: "unavailable",
    recognize: () => Effect.die("not used"),
  },
  dataDir: Effect.succeed("/tmp/openmail-startup-test"),
  NodeSystem: Layer.empty,
  NodeMailbox: (options: unknown) => {
    native.nodeMailbox(options);
    if (native.failStart)
      return Layer.effectDiscard(Effect.die(new Error("startup regression failure")));
    if (native.warnStart)
      return Layer.effectDiscard(Effect.logWarning("startup regression warning"));
    return Layer.empty;
  },
}));
vi.mock("./security-bootstrap", () => ({
  registerSecuritySchemes: vi.fn(),
  prepareSessionSecurity: vi.fn(),
}));
vi.mock("./attachment-temp", () => ({ cleanupAttachmentTemps: native.cleanup }));
vi.mock("./reliability", () => ({
  prepareReliability: vi.fn(async () => true),
  diagnosticsLogger: Logger.make(() => native.diagnosticLog()),
  localLog: native.localLog,
}));
vi.mock("./updates", () => ({ UpdatesLive: Layer.empty }));
vi.mock("./vision", () => ({ desktopVision: native.vision }));
vi.mock("./rpc-server", () => ({ RpcServerLive: Layer.empty }));
vi.mock("./system", () => ({
  DesktopLive: Layer.empty,
  receiveAppUrl: native.urls,
  ready: Effect.void,
}));
vi.mock("./windows", () => ({ DEV_ICON: undefined, focusMainWindow: native.focus }));

const originalResourcesPath = Object.getOwnPropertyDescriptor(process, "resourcesPath");
afterEach(() => {
  vi.restoreAllMocks();
  if (originalResourcesPath) Object.defineProperty(process, "resourcesPath", originalResourcesPath);
  else Reflect.deleteProperty(process, "resourcesPath");
});
beforeEach(async () => {
  Object.defineProperty(process, "resourcesPath", {
    configurable: true,
    value: "/tmp/openmail-test-resources",
  });
  native.cleanup.mockResolvedValue(undefined);
  native.vision.mockResolvedValue({
    available: false,
    version: "test",
    recognize: () => Effect.die("not used"),
  });
  const { app } = await import("electron");
  app.removeAllListeners();
  vi.resetModules();
  native.primary = true;
  native.failStart = false;
  native.warnStart = false;
  vi.clearAllMocks();
});
it("any already-created window can release startup after the first window closes", async () => {
  await import("./index");
  const { app } = await import("electron");
  await vi.waitFor(() => expect(native.nodeMailbox).toHaveBeenCalled());
  const first = new EventEmitter();
  const second = new EventEmitter();
  app.emit("browser-window-created", undefined, first);
  app.emit("browser-window-created", undefined, second);
  first.emit("closed");
  second.emit("ready-to-show");
  await vi.waitFor(() => expect(native.vision).toHaveBeenCalledOnce());
  expect(first.listenerCount("ready-to-show")).toBe(0);
  expect(second.listenerCount("closed")).toBe(0);
  expect(app.listenerCount("browser-window-created")).toBe(0);
  app.emit("will-quit", { preventDefault: vi.fn() });
  await vi.waitFor(() => expect(native.exit).toHaveBeenCalledWith(0));
});
it("the second process exits before building core or opening any data", async () => {
  native.primary = false;
  await import("./index");
  expect(native.exit).toHaveBeenCalledWith(0);
  expect(native.nodeMailbox).not.toHaveBeenCalled();
  expect(native.vision).not.toHaveBeenCalled();
  expect(native.cleanup).not.toHaveBeenCalled();
});
it("handles open-url and forwarded second-instance URLs and enables desktop-only polling", async () => {
  await import("./index");
  const { app } = await import("electron");
  const preventDefault = vi.fn();
  app.emit("open-url", { preventDefault }, "mailto:to@example.com?subject=hello");
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(native.urls).toHaveBeenCalledWith("mailto:to@example.com?subject=hello");
  app.emit("second-instance", {}, ["OpenMail", "openmail://message/id", "unrelated"]);
  expect(native.urls).toHaveBeenCalledWith("openmail://message/id");
  app.emit("second-instance", {}, ["OpenMail"]);
  expect(native.focus).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(native.nodeMailbox).toHaveBeenCalled());
  expect(native.vision).not.toHaveBeenCalled();
  const first = new EventEmitter();
  app.emit("browser-window-created", undefined, first);
  expect(native.vision).not.toHaveBeenCalled();
  first.emit("ready-to-show");
  await vi.waitFor(() => expect(native.vision).toHaveBeenCalled());
  expect(native.vision).toHaveBeenCalledWith(expect.stringContaining("native/vision"));
  expect(first.listenerCount("ready-to-show")).toBe(0);
  expect(app.listenerCount("browser-window-created")).toBe(0);
  expect(native.nodeMailbox).toHaveBeenCalledWith(
    expect.objectContaining({
      autoSync: "2 minutes",
      inboxPoll: "45 seconds",
      media: expect.objectContaining({
        vision: expect.objectContaining({ version: "test" }),
        onBattery: expect.any(Function),
        idle: expect.any(Function),
      }),
    }),
  );
  await vi.waitFor(() => expect(native.register).toHaveBeenCalledWith("openmail"));
  expect(native.cleanup).toHaveBeenCalledWith("/tmp/openmail-test-temp");
  app.emit("will-quit", { preventDefault });
  await vi.waitFor(() => expect(native.exit).toHaveBeenCalledWith(0));
});

it("development builds in different worktrees do not request the shared packaged lock", async () => {
  const { app } = await import("electron");
  Object.defineProperty(app, "isPackaged", { configurable: true, value: false });
  native.primary = false;
  await import("./index");
  await vi.waitFor(() => expect(native.nodeMailbox).toHaveBeenCalled());
  expect(native.exit).not.toHaveBeenCalled();
  app.emit("will-quit", { preventDefault: vi.fn() });
  await vi.waitFor(() => expect(native.exit).toHaveBeenCalledWith(0));
  Object.defineProperty(app, "isPackaged", { configurable: true, value: true });
});

it("startup defects remain visible on stderr while the file log receives only a fixed event", async () => {
  native.failStart = true;
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {
    /* Capture console output in this regression. */
  });
  await import("./index");
  await vi.waitFor(() => expect(native.exit).toHaveBeenCalledWith(1));
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining("startup regression failure"));
  expect(native.localLog).toHaveBeenCalledWith("startup-failed");
  expect(native.localLog.mock.calls[0]).toEqual(["startup-failed"]);
});
it("the diagnostics logger replaces the raw Effect logger", async () => {
  native.warnStart = true;
  const existing = vi.spyOn(Logger.defaultLogger, "log").mockImplementation(() => {
    /* Capture console output in this regression. */
  });
  await import("./index");
  await vi.waitFor(() => expect(native.nodeMailbox).toHaveBeenCalled());
  expect(existing).not.toHaveBeenCalled();
  expect(native.diagnosticLog).toHaveBeenCalled();
  (await import("electron")).app.emit("will-quit", { preventDefault: vi.fn() });
  await vi.waitFor(() => expect(native.exit).toHaveBeenCalledWith(0));
});

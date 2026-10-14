import { Effect, Layer, Logger } from "effect";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { waitLimit } from "../../../../../packages/core/test-support/test-time.js";

const native = vi.hoisted(() => ({
  primary: true,
  failStart: false,
  startError: undefined as Error | undefined,
  showErrorBox: vi.fn(),
  warnStart: false,
  diagnosticLog: vi.fn(),
  localLog: vi.fn(),
  finishCleanly: vi.fn(),
  exit: vi.fn(),
  nodeMailbox: vi.fn(),
  vision: vi.fn(),
  urls: vi.fn(),
  focus: vi.fn(),
  register: vi.fn(),
  cleanup: vi.fn(),
  printCleanup: vi.fn(),
  appendSwitch: vi.fn(),
}));
vi.mock("electron", () => ({
  app: Object.assign(new EventEmitter(), {
    commandLine: { getSwitchValue: () => "", appendSwitch: native.appendSwitch },
    setPath: vi.fn(),
    getPath: vi.fn(() => "/tmp/openmail-test-temp"),
    requestSingleInstanceLock: () => native.primary,
    exit: native.exit,
    isReady: () => true,
    isPackaged: true,
    setAsDefaultProtocolClient: native.register,
    getVersion: () => "0.0.0",
    setAboutPanelOptions: vi.fn(),
  }),
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  dialog: { showErrorBox: native.showErrorBox },
  shell: { openExternal: vi.fn() },
  powerMonitor: { isOnBatteryPower: () => false, getSystemIdleTime: () => 6 },
}));
vi.mock("@openmail/core", () => ({
  DatabaseUpgradeSpaceError: class extends Error {},
  DatabaseTooNewError: class DatabaseTooNewError extends Error {},
  unavailableVision: {
    available: false,
    version: "unavailable",
    recognize: () => Effect.die("not used"),
  },
  dataDir: Effect.succeed("/tmp/openmail-startup-test"),
  logWarning: (_code: string, ...message: unknown[]) => Effect.logWarning(...message),
  NodeSystem: Layer.empty,
  NodeMailbox: (options: unknown) => {
    native.nodeMailbox(options);
    if (native.failStart)
      return Layer.effectDiscard(
        Effect.die(native.startError ?? new Error("startup regression failure")),
      );
    if (native.warnStart)
      return Layer.effectDiscard(Effect.logWarning("startup regression warning"));
    return Layer.empty;
  },
}));
vi.mock("../security/security-bootstrap", () => ({
  registerSecuritySchemes: vi.fn(),
  prepareSessionSecurity: vi.fn(),
}));
vi.mock("../files/attachment-temp", () => ({
  cleanupAttachmentTemps: native.cleanup,
  cleanupPrintTemps: native.printCleanup,
}));
vi.mock("../files/opened-attachments", () => ({
  cleanupOpenedAttachments: vi.fn(() => Promise.resolve()),
}));
vi.mock("./reliability", () => ({
  prepareReliability: vi.fn(async () => true),
  diagnosticsLogger: Logger.make(() => native.diagnosticLog()),
  localLog: native.localLog,
  finishCleanly: native.finishCleanly,
}));
vi.mock("./native-i18n", () => ({
  nativeAuthorizePage: vi.fn(),
  osLocale: () => "en",
  nativeRecoveryLabels: async () => ({
    newerDatabaseTitle: "This library was opened by a newer OpenMail",
    newerDatabaseDetail: "Update OpenMail to the latest version to open it.",
  }),
}));
vi.mock("../updates/updates", () => ({ UpdatesLive: Layer.empty }));
vi.mock("./vision", () => ({ desktopVision: native.vision }));
vi.mock("../rpc/rpc-server", () => ({ RpcServerLive: Layer.empty }));
vi.mock("../remote/remote-access-live", () => ({ RemoteAccessLive: Layer.empty }));
vi.mock("../system/system", () => ({
  DesktopLive: Layer.empty,
  receiveAppUrl: native.urls,
  ready: Effect.void,
}));
vi.mock("../windows/windows", () => ({ focusMainWindow: native.focus }));

const originalResourcesPath = Object.getOwnPropertyDescriptor(process, "resourcesPath");
// main.ts installs process-wide handlers once; each test removes the ones it added.
const keptExceptions = process.listeners("uncaughtException");
const keptRejections = process.listeners("unhandledRejection");
afterEach(() => {
  for (const listener of process.listeners("uncaughtException"))
    if (!keptExceptions.includes(listener)) process.off("uncaughtException", listener);
  for (const listener of process.listeners("unhandledRejection"))
    if (!keptRejections.includes(listener)) process.off("unhandledRejection", listener);
  Reflect.deleteProperty(process, Symbol.for("openmail.processErrorHandlers"));
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
  native.printCleanup.mockResolvedValue(undefined);
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
  native.startError = undefined;
  native.warnStart = false;
  vi.clearAllMocks();
});
// The first test pays the cold transform of the main entry. That takes over 5 s
// when `pnpm test` runs the core suite on the same cores.
it("any already-created window can release startup after the first window closes", async () => {
  await import("../main");
  const { app } = await import("electron");
  await vi.waitFor(() => expect(native.nodeMailbox).toHaveBeenCalled(), waitLimit);
  const first = new EventEmitter();
  const second = new EventEmitter();
  app.emit("browser-window-created", undefined, first);
  app.emit("browser-window-created", undefined, second);
  first.emit("closed");
  second.emit("ready-to-show");
  await vi.waitFor(() => expect(native.vision).toHaveBeenCalledOnce(), waitLimit);
  expect(first.listenerCount("ready-to-show")).toBe(0);
  expect(second.listenerCount("closed")).toBe(0);
  expect(app.listenerCount("browser-window-created")).toBe(0);
  app.emit("will-quit", { preventDefault: vi.fn() });
  await vi.waitFor(() => expect(native.exit).toHaveBeenCalledWith(0), waitLimit);
}, 30_000);
it("the second process exits before building core or opening any data", async () => {
  native.primary = false;
  await import("../main");
  expect(native.exit).toHaveBeenCalledWith(0);
  expect(native.nodeMailbox).not.toHaveBeenCalled();
  expect(native.vision).not.toHaveBeenCalled();
  expect(native.cleanup).not.toHaveBeenCalled();
});
it("main turns off Chromium's soft navigation detector before any window", async () => {
  await import("../main");
  // Its CHECK on click timestamps killed the renderer when a zero-timestamp click closed a dialog.
  expect(native.appendSwitch).toHaveBeenCalledWith("disable-features", "SoftNavigationDetection");
});
it("a failed attachment temp sweep still runs the print temp sweep", async () => {
  native.cleanup.mockRejectedValue(new Error("attachment sweep failed"));
  await import("../main");
  await vi.waitFor(
    () => expect(native.printCleanup).toHaveBeenCalledWith("/tmp/openmail-test-temp"),
    waitLimit,
  );
});
it("handles open-url and forwarded second-instance URLs and enables desktop-only polling", async () => {
  await import("../main");
  const { app } = await import("electron");
  const preventDefault = vi.fn();
  app.emit("open-url", { preventDefault }, "mailto:to@example.com?subject=hello");
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(native.urls).toHaveBeenCalledWith("mailto:to@example.com?subject=hello");
  app.emit("second-instance", {}, ["OpenMail", "openmail://message/id", "unrelated"]);
  expect(native.urls).toHaveBeenCalledWith("openmail://message/id");
  app.emit("second-instance", {}, ["OpenMail"]);
  expect(native.focus).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(native.nodeMailbox).toHaveBeenCalled(), waitLimit);
  expect(native.vision).not.toHaveBeenCalled();
  const first = new EventEmitter();
  app.emit("browser-window-created", undefined, first);
  expect(native.vision).not.toHaveBeenCalled();
  first.emit("ready-to-show");
  await vi.waitFor(() => expect(native.vision).toHaveBeenCalled(), waitLimit);
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
  await vi.waitFor(() => expect(native.register).toHaveBeenCalledWith("openmail"), waitLimit);
  expect(native.cleanup).toHaveBeenCalledWith("/tmp/openmail-test-temp");
  expect(native.printCleanup).toHaveBeenCalledWith("/tmp/openmail-test-temp");
  app.emit("will-quit", { preventDefault });
  await vi.waitFor(() => expect(native.exit).toHaveBeenCalledWith(0), waitLimit);
});

it("development builds in different worktrees do not request the shared packaged lock", async () => {
  const { app } = await import("electron");
  Object.defineProperty(app, "isPackaged", { configurable: true, value: false });
  native.primary = false;
  await import("../main");
  await vi.waitFor(() => expect(native.nodeMailbox).toHaveBeenCalled(), waitLimit);
  expect(native.exit).not.toHaveBeenCalled();
  app.emit("will-quit", { preventDefault: vi.fn() });
  await vi.waitFor(() => expect(native.exit).toHaveBeenCalledWith(0), waitLimit);
  Object.defineProperty(app, "isPackaged", { configurable: true, value: true });
});

it("startup defects remain visible on stderr while the file log receives only a fixed event", async () => {
  native.failStart = true;
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {
    /* Capture console output in this regression. */
  });
  await import("../main");
  await vi.waitFor(() => expect(native.exit).toHaveBeenCalledWith(1), waitLimit);
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining("startup regression failure"));
  expect(native.localLog).toHaveBeenCalledWith("startup-failed");
  expect(native.localLog.mock.calls[0]).toEqual(["startup-failed"]);
});
it("a database from a newer OpenMail explains itself in a native dialog before exiting", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {
    /* Capture console output in this regression. */
  });
  const { DatabaseTooNewError } = await import("@openmail/core");
  native.failStart = true;
  native.startError = new DatabaseTooNewError(1000);
  await import("../main");
  await vi.waitFor(() => expect(native.exit).toHaveBeenCalledWith(1), waitLimit);
  expect(native.showErrorBox).toHaveBeenCalledWith(
    "This library was opened by a newer OpenMail",
    "Update OpenMail to the latest version to open it.",
  );
  // A refusal is a clean exit, so the next launch does not count it as a crash.
  expect(native.finishCleanly).toHaveBeenCalledBefore(native.exit);
});
it("the main process handles uncaught exceptions and unhandled rejections", async () => {
  const handled = Symbol.for("openmail.processErrorHandlers");
  Reflect.deleteProperty(process, handled);
  const before = process.listenerCount("uncaughtException");
  const rejections = process.listenerCount("unhandledRejection");
  await import("../main");
  expect(process.listenerCount("uncaughtException")).toBe(before + 1);
  expect(process.listenerCount("unhandledRejection")).toBe(rejections + 1);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  process.emit("unhandledRejection", new Error("lost promise"), Promise.resolve());
  expect(native.localLog).toHaveBeenCalledWith("runtime-error", {
    reason: "unhandled-rejection",
  });
  (await import("electron")).app.emit("will-quit", { preventDefault: vi.fn() });
});
it("the diagnostics logger replaces the raw Effect logger", async () => {
  native.warnStart = true;
  const existing = vi.spyOn(Logger.defaultLogger, "log").mockImplementation(() => {
    /* Capture console output in this regression. */
  });
  await import("../main");
  await vi.waitFor(() => expect(native.nodeMailbox).toHaveBeenCalled(), waitLimit);
  expect(existing).not.toHaveBeenCalled();
  expect(native.diagnosticLog).toHaveBeenCalled();
  (await import("electron")).app.emit("will-quit", { preventDefault: vi.fn() });
  await vi.waitFor(() => expect(native.exit).toHaveBeenCalledWith(0), waitLimit);
});

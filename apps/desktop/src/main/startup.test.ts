import { Effect, Layer } from "effect";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  primary: true,
  exit: vi.fn(),
  nodeMailbox: vi.fn(),
  vision: vi.fn(),
  urls: vi.fn(),
  focus: vi.fn(),
  register: vi.fn(),
}));
vi.mock("electron", () => ({
  app: Object.assign(new EventEmitter(), {
    requestSingleInstanceLock: () => native.primary,
    exit: native.exit,
    isReady: () => true,
    isPackaged: true,
    setAsDefaultProtocolClient: native.register,
  }),
  shell: { openExternal: vi.fn() },
  powerMonitor: { isOnBatteryPower: () => false, getSystemIdleTime: () => 6 },
}));
vi.mock("@openmail/core", () => ({
  NodeMailbox: (options: unknown) => {
    native.nodeMailbox(options);
    return Layer.empty;
  },
}));
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
  if (originalResourcesPath) Object.defineProperty(process, "resourcesPath", originalResourcesPath);
  else Reflect.deleteProperty(process, "resourcesPath");
});
beforeEach(async () => {
  Object.defineProperty(process, "resourcesPath", {
    configurable: true,
    value: "/tmp/openmail-test-resources",
  });
  native.vision.mockResolvedValue({
    available: false,
    version: "test",
    recognize: () => Effect.die("not used"),
  });
  const { app } = await import("electron");
  app.removeAllListeners();
  vi.resetModules();
  native.primary = true;
  vi.clearAllMocks();
});
it("the second process exits before building core or opening any data", async () => {
  native.primary = false;
  await import("./index");
  expect(native.exit).toHaveBeenCalledWith(0);
  expect(native.nodeMailbox).not.toHaveBeenCalled();
  expect(native.vision).not.toHaveBeenCalled();
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
  expect(native.vision).toHaveBeenCalledWith(expect.stringContaining("native/vision"));
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

import { EventEmitter } from "node:events";
import { Effect, Exit, Layer, Queue, Schema } from "effect";
import { RpcGroup, RpcMessage, RpcSerialization, RpcServer } from "effect/rpc";
import { afterAll, expect, it, vi } from "vitest";
import { decodeRpcFrame, MAX_RPC_FRAME, publicRpcResponse } from "./rpc-security";
import { MailRpcs } from "../shared/rpc";
import { APP_PAGE } from "./security-policy";
import { configurePermissions, mayWriteClipboard, trustedSender } from "./security";

const frames = vi.hoisted(() => {
  vi.resetModules();
  vi.doUnmock("./windows");
  return { next: 0 };
});
afterAll(() => {
  vi.doUnmock("electron");
  vi.resetModules();
});

vi.mock("electron", () => ({
  app: { isPackaged: true, getPreferredSystemLanguages: () => ["en"], getLocale: () => "en" },
  nativeTheme: { shouldUseDarkColors: false },
  shell: { openExternal: vi.fn() },
  BrowserWindow: class Window extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: {
        url: APP_PAGE,
        frameTreeNodeId: ++frames.next,
        frames: [{ url: APP_PAGE, frameTreeNodeId: ++frames.next }],
      },
      getType: () => "window",
      isDestroyed: () => false,
      setWindowOpenHandler: vi.fn(),
    });
    loadURL = vi.fn();
    loadFile = vi.fn();
  },
}));
import { BrowserWindow, type Session } from "electron";
import {
  createMainWindow,
  openComposeWindow,
  openThreadWindow,
  openMessageWindow,
} from "./windows";

it("allows registered window top frames and refuses mail frames, foreign contents and navigated pages", () => {
  for (const win of [
    createMainWindow(),
    openComposeWindow("draft"),
    openThreadWindow("thread"),
    openMessageWindow("message"),
  ]) {
    const sender = win.webContents;
    expect(trustedSender({ sender, senderFrame: sender.mainFrame })).toBe(true);
    expect(trustedSender({ sender, senderFrame: sender.mainFrame.frames[0] ?? null })).toBe(false);
    expect(trustedSender({ sender, senderFrame: null })).toBe(false);
    Object.defineProperty(sender.mainFrame, "url", {
      configurable: true,
      value: "https://evil.example/index.html",
    });
    expect(trustedSender({ sender, senderFrame: sender.mainFrame })).toBe(false);
    Object.defineProperty(sender.mainFrame, "url", { configurable: true, value: APP_PAGE });
    vi.spyOn(sender, "getType").mockReturnValue("webview");
    expect(trustedSender({ sender, senderFrame: sender.mainFrame })).toBe(false);
    vi.spyOn(sender, "getType").mockReturnValue("window");
    vi.spyOn(sender, "isDestroyed").mockReturnValue(true);
    expect(trustedSender({ sender, senderFrame: sender.mainFrame })).toBe(false);
  }
  const unknown = new BrowserWindow();
  expect(
    trustedSender({ sender: unknown.webContents, senderFrame: unknown.webContents.mainFrame }),
  ).toBe(false);
  const win = createMainWindow();
  win.webContents.emit("destroyed");
  expect(trustedSender({ sender: win.webContents, senderFrame: win.webContents.mainFrame })).toBe(
    false,
  );
});

it("allows only sanitized clipboard writes from registered application top frames", () => {
  const contents = createMainWindow().webContents;
  const top = { isMainFrame: true, requestingUrl: APP_PAGE };
  expect(mayWriteClipboard(contents, top)).toBe(true);
  expect(mayWriteClipboard(contents, { isMainFrame: true }, "openmail-app://app")).toBe(true);
  expect(mayWriteClipboard(contents, { ...top, isMainFrame: false })).toBe(false);
  expect(mayWriteClipboard(contents, { ...top, requestingUrl: "https://evil.example/" })).toBe(
    false,
  );
  expect(
    mayWriteClipboard(contents, { ...top, requestingUrl: "openmail-app://app/other.html" }),
  ).toBe(false);
  expect(mayWriteClipboard(contents, top, "https://evil.example")).toBe(false);
  expect(mayWriteClipboard(null, top)).toBe(false);
  expect(mayWriteClipboard(new BrowserWindow().webContents, top)).toBe(false);
  const handlers = {
    setPermissionRequestHandler: vi.fn<Session["setPermissionRequestHandler"]>(),
    setPermissionCheckHandler: vi.fn<Session["setPermissionCheckHandler"]>(),
    setDevicePermissionHandler: vi.fn<Session["setDevicePermissionHandler"]>(),
  };
  configurePermissions(handlers, true);
  const request = handlers.setPermissionRequestHandler.mock.calls[0]?.[0];
  const check = handlers.setPermissionCheckHandler.mock.calls[0]?.[0];
  if (!request || !check) throw new Error("Missing clipboard permission handlers");
  for (const permission of [
    "clipboard-sanitized-write",
    "clipboard-read",
    "notifications",
    "media",
  ] as const) {
    const answer = vi.fn();
    request(contents, permission, answer, top);
    expect(answer).toHaveBeenCalledWith(permission === "clipboard-sanitized-write");
    expect(check(contents, permission, "openmail-app://app", top)).toBe(
      permission === "clipboard-sanitized-write",
    );
    expect(check(contents, permission, "openmail-app://app", { ...top, isMainFrame: false })).toBe(
      false,
    );
  }
});

it("decodes bounded RPC envelopes with Schema, refusing unknown methods and transport shapes", () => {
  const request = {
    _tag: "Request",
    id: "1",
    tag: "SetAiKey",
    payload: { key: "input" },
    headers: [],
  };
  expect(decodeRpcFrame(JSON.stringify(request))).toEqual([request]);
  expect(
    decodeRpcFrame(
      JSON.stringify({ ...request, traceId: "secret", headers: [["Authorization", "secret"]] }),
    ),
  ).toEqual([request]);
  for (const value of [
    null,
    {},
    "{",
    JSON.stringify({ ...request, tag: "RunShell" }),
    JSON.stringify({ ...request, id: {} }),
    JSON.stringify({ ...request, headers: null }),
    JSON.stringify({ _tag: "Defect", defect: "bad" }),
    JSON.stringify([]),
    JSON.stringify(Array.from({ length: 65 }, () => request)),
    " ".repeat(MAX_RPC_FRAME + 1),
  ])
    expect(decodeRpcFrame(value)).toBeNull();
});

it("real RPC payload codecs reject invalid arguments before invoking handlers", async () => {
  const rpc = MailRpcs.requests.get("SetAiKey");
  if (rpc?._tag !== "SetAiKey") throw new Error("Missing test RPC");
  const group = RpcGroup.make(rpc);
  const handler = vi.fn(() => Effect.void);
  await Effect.runPromise(
    Effect.gen(function* () {
      const input = yield* Queue.unbounded<RpcMessage.FromClientEncoded>();
      const output = yield* Queue.unbounded<RpcMessage.FromServerEncoded>();
      const disconnects = yield* Queue.unbounded<number>();
      const protocol = Layer.succeed(RpcServer.Protocol, {
        run: (write) =>
          Queue.take(input).pipe(
            Effect.flatMap((request) => write(1, request)),
            Effect.forever,
          ),
        send: (_, response) => Queue.offer(output, publicRpcResponse(response)).pipe(Effect.asVoid),
        end: () => Effect.void,
        disconnects,
        clientIds: Effect.succeed(new Set([1])),
        initialMessage: Effect.succeedNone,
        supportsAck: false,
        supportsTransferables: false,
        supportsSpanPropagation: false,
        supportsNotifications: false,
        codecFor: RpcSerialization.json.codecFor,
      });
      yield* RpcServer.make(group).pipe(
        Effect.provide(protocol),
        Effect.provide(group.toLayer({ SetAiKey: handler })),
        Effect.forkScoped,
      );
      for (const payload of [{ key: 123 }, { key: "typed" }]) {
        const requests = decodeRpcFrame(
          JSON.stringify({ _tag: "Request", id: 1, tag: "SetAiKey", payload, headers: [] }),
        );
        if (!requests?.[0]) throw new Error("Missing request");
        yield* Queue.offer(input, requests[0]);
        const response = yield* Queue.take(output);
        expect(response._tag).toBe("Exit");
        if (response._tag === "Exit")
          expect(response.exit._tag).toBe(typeof payload.key === "string" ? "Success" : "Failure");
      }
    }).pipe(Effect.scoped),
  );
  expect(handler).toHaveBeenCalledOnce();
});

it("sanitizes typed failures, stacks, defects and parser details while keeping translated validation messages", () => {
  const secret = "Bearer secret-key /Users/private/keychain.db";
  const response = publicRpcResponse({
    _tag: "Exit",
    requestId: 1,
    exit: {
      _tag: "Failure",
      cause: [
        { _tag: "Die", defect: { message: secret, stack: secret } },
        { _tag: "Fail", error: { _tag: "DeviceError", message: secret, stack: secret } },
        { _tag: "Fail", error: { _tag: "InvalidInput", message: "Enter a single API key." } },
      ],
    },
  });
  expect(JSON.stringify(response)).not.toContain(secret);
  expect(JSON.stringify(response)).not.toContain("stack");
  expect(JSON.stringify(response)).toContain("Enter a single API key.");
  expect(JSON.stringify(publicRpcResponse({ _tag: "Defect", defect: secret }))).not.toContain(
    secret,
  );
  const codec = RpcSerialization.json.codecFor(Schema.Defect());
  const decoded = Schema.decodeUnknownSync(codec)("Internal RPC failure");
  expect(Exit.isFailure(Effect.runSyncExit(Effect.die(decoded)))).toBe(true);
  const data = {
    _tag: "Exit",
    requestId: 1,
    exit: { _tag: "Success", value: { text: "mail content" } },
  } as const;
  expect(publicRpcResponse(data)).toBe(data);
});

it("accepts different frame wrappers with the same stable Electron frame id", () => {
  const win = createMainWindow();
  const frame = {
    url: win.webContents.mainFrame.url,
    frameTreeNodeId: win.webContents.mainFrame.frameTreeNodeId,
  };
  expect(frame).not.toBe(win.webContents.mainFrame);
  expect(trustedSender({ sender: win.webContents, senderFrame: frame })).toBe(true);
  expect(
    trustedSender({ sender: win.webContents, senderFrame: { ...frame, frameTreeNodeId: 999 } }),
  ).toBe(false);
});

it("keeps the fixed read-only session error across RPC without exposing provider details", () => {
  for (const tag of ["ProviderError", "InvalidInput"] as const) {
    const message = "Remote writes are disabled in this read-only session";
    const response = {
      _tag: "Exit",
      requestId: 1,
      exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { _tag: tag, message } }] },
    } as const;
    expect(JSON.stringify(publicRpcResponse(response))).toContain(message);
  }
});

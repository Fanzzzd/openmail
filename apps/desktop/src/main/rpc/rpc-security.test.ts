import { EventEmitter } from "node:events";
import { Effect, Exit, Layer, Logger, Queue, References, Schema } from "effect";
import { RpcGroup, RpcMessage, RpcSerialization, RpcServer } from "effect/rpc";
import { afterAll, expect, it, vi } from "vitest";
import { MAX_RPC_FRAME } from "../../shared/channel";
import { decodeRpcFrame, publicRpcResponse, type StringProtocolInput } from "./rpc-security";
import { MailRpcs } from "../../shared/rpc";
import { APP_PAGE } from "../security/security-policy";
import { configurePermissions, mayWriteClipboard, trustedSender } from "../security/security";
import { scaledMs, waitLimit } from "../../../../../packages/core/test-support/test-time.js";

/** Polls `check` until it holds, within the scaled wait limit. */
const waitUntil = (check: () => boolean) =>
  Effect.promise(() => vi.waitFor(() => expect(check()).toBe(true), waitLimit));

const frames = vi.hoisted(() => {
  vi.resetModules();
  vi.doUnmock("../windows/windows");
  return { next: 0 };
});
afterAll(() => {
  vi.doUnmock("electron");
  vi.resetModules();
});

vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    getPreferredSystemLanguages: () => ["en"],
    getLocale: () => "en",
    getSystemLocale: () => "en-US",
  },
  nativeTheme: { shouldUseDarkColors: false },
  systemPreferences: { getUserDefault: () => false },
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
} from "../windows/windows";

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

it("AI failures keep their specific sentence across the RPC boundary", () => {
  for (const error of [
    {
      _tag: "ProviderError",
      message: "Anthropic rejected the API key. Check it in Settings → AI Access.",
      status: 401,
    },
    {
      _tag: "ProviderError",
      message: "Anthropic's rate limit was reached. Wait a minute, then try again.",
      status: 429,
    },
    {
      _tag: "ProviderError",
      message: "Can't reach Anthropic. Check your internet connection.",
      reason: "connection",
    },
    { _tag: "InvalidInput", message: "AI model is unavailable." },
  ]) {
    const response = publicRpcResponse({
      _tag: "Exit",
      requestId: 1,
      exit: { _tag: "Failure", cause: [{ _tag: "Fail", error }] },
    });
    expect(JSON.stringify(response)).toContain(JSON.stringify(error.message));
  }
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

it("allows fixed Outlook errors across RPC while stripping provider additions", () => {
  const messages = [
    "Outlook.com messages are limited to 25 MB, including message text and attachments. Remove attachments before sending.",
    "Outlook cannot upload attached messages of 3 MB or more. Remove this attachment before sending.",
    "Outlook message requests cannot exceed 4 MB",
    "Outlook message requests cannot exceed 4 MB. Large attached messages cannot be uploaded as Outlook items.",
  ];
  for (const tag of ["InvalidInput", "PermanentError", "ProviderError"] as const)
    for (const message of messages) {
      const frame = (value: string) =>
        ({
          _tag: "Exit",
          requestId: 1,
          exit: {
            _tag: "Failure",
            cause: [{ _tag: "Fail", error: { _tag: tag, message: value } }],
          },
        }) as const;
      expect(JSON.stringify(publicRpcResponse(frame(message)))).toContain(message);
      const privateMessage = `${message} Bearer private-token`;
      const redacted = JSON.stringify(publicRpcResponse(frame(privateMessage)));
      expect(redacted).not.toContain("private-token");
      expect(redacted).not.toContain(message);
    }
});

it("logs the RPC tag for every failure and separates clients, terminal responses and disconnects", async () => {
  const { createRpcFailureTracker } = await import("./rpc-security");
  const recorded: string[] = [];
  const tracker = createRpcFailureTracker((failure) => recorded.push(failure.rpc));
  const request = (tag: string) =>
    decodeRpcFrame(
      JSON.stringify({
        _tag: "Request",
        id: "57",
        tag,
        payload: { token: "private-token", accountId: "private@example.com" },
        headers: [],
      }),
    ) ?? [];
  const failure = (tag: string): RpcMessage.FromServerEncoded => ({
    _tag: "Exit",
    requestId: "57",
    exit: {
      _tag: "Failure",
      cause: [
        {
          _tag: "Fail",
          error: {
            _tag: tag,
            message: "private-token",
            accountId: "private@example.com",
            feature: "contacts",
          },
        },
      ],
    },
  });
  tracker.request(1, request("RefreshContacts"));
  tracker.request(2, request("ReaderAttachments"));
  tracker.response(1, failure("FeatureScopeMissing"));
  tracker.response(2, failure("AuthError"));
  tracker.response(2, failure("AuthError"));
  expect(recorded).toEqual(["RefreshContacts", "ReaderAttachments"]);
  tracker.request(1, request("InlineImages"));
  tracker.disconnect(1);
  tracker.response(1, failure("AuthError"));
  expect(recorded).toEqual(["RefreshContacts", "ReaderAttachments"]);
  tracker.request(1, request("private-token"));
  tracker.response(1, failure("AuthError"));
  expect(recorded).toEqual(["RefreshContacts", "ReaderAttachments"]);
});

it("RPC diagnostics record the kind, the error tag and an allowed defect class, never payloads or text", async () => {
  const { createRpcFailureTracker } = await import("./rpc-security");
  const recorded: unknown[] = [];
  const tracker = createRpcFailureTracker((failure) => recorded.push(failure));
  const request = (id: number) =>
    decodeRpcFrame(
      JSON.stringify({
        _tag: "Request",
        id,
        tag: "OpenDraft",
        payload: { id: "draft:private-uuid", token: "private-token" },
        headers: [],
      }),
    ) ?? [];
  const causes = [
    [
      {
        _tag: "Fail" as const,
        error: { _tag: "NotFound", what: "message", id: "draft:private-uuid" },
      },
    ],
    [{ _tag: "Fail" as const, error: { _tag: "InvalidInput", message: "private-token" } }],
    [{ _tag: "Fail" as const, error: { _tag: "private-token here", message: "x" } }],
    [{ _tag: "Die" as const, defect: { message: "private-token", stack: "private stack" } }],
    [{ _tag: "Die" as const, defect: { name: "TypeError", message: "private-token" } }],
    [{ _tag: "Die" as const, defect: { name: "PrivateTokenError", message: "private-token" } }],
    [{ _tag: "Die" as const, defect: "private-token" }],
    [{ _tag: "Interrupt" as const, fiberId: 123 }],
  ];
  for (const [id, cause] of causes.entries()) {
    tracker.request(1, request(id));
    tracker.response(1, { _tag: "Exit", requestId: id, exit: { _tag: "Failure", cause } });
  }
  // A request the client interrupted itself is not a failure.
  tracker.request(1, request(99));
  tracker.request(1, [{ _tag: "Interrupt", requestId: 99 }]);
  tracker.response(1, {
    _tag: "Exit",
    requestId: 99,
    exit: { _tag: "Failure", cause: [{ _tag: "Interrupt", fiberId: 1 }] },
  });
  expect(recorded).toEqual([
    { rpc: "OpenDraft", kind: "failure", error: "NotFound" },
    { rpc: "OpenDraft", kind: "failure", error: "InvalidInput" },
    { rpc: "OpenDraft", kind: "failure" },
    { rpc: "OpenDraft", kind: "defect", error: "Other" },
    { rpc: "OpenDraft", kind: "defect", error: "TypeError" },
    { rpc: "OpenDraft", kind: "defect", error: "Other" },
    { rpc: "OpenDraft", kind: "defect", error: "Other" },
    { rpc: "OpenDraft", kind: "interrupt" },
  ]);
  expect(JSON.stringify(recorded)).not.toContain("private");
});

it("a handler defect logs its RPC, kind and error class, and no message text", async () => {
  const { stringRpcServer } = await import("./rpc-security");
  const { Rpc } = await import("effect/rpc");
  class Threads extends Rpc.make("Threads", { success: Schema.String }) {}
  const Group = RpcGroup.make(Threads);
  const failures: unknown[] = [];
  const sent: string[] = [];
  let input: StringProtocolInput | undefined;
  const server = stringRpcServer(Group, {
    attach: (i) => {
      input = i;
      return () => null;
    },
    send: (_client, frame) => sent.push(frame),
    failure: (failure) => failures.push(failure),
  }).pipe(
    Layer.provide(
      Group.toLayer({
        Threads: () => Effect.die(new TypeError("cannot read secret of undefined")),
      }),
    ),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* waitUntil(() => input !== undefined);
      input?.frame(
        1,
        JSON.stringify({ _tag: "Request", id: "1", tag: "Threads", payload: null, headers: [] }),
      );
      yield* waitUntil(() => failures.length > 0);
    }).pipe(
      Effect.provide(Layer.launch(server).pipe(Effect.forkScoped, Layer.effectDiscard)),
      Effect.scoped,
    ),
  );
  expect(failures).toEqual([{ rpc: "Threads", kind: "defect", error: "TypeError" }]);
  expect(JSON.stringify([failures, sent])).not.toContain("secret");
});

it("ends a renderer's RPC client when its page crashes, reloads or closes, not on in-page routes", async () => {
  const { watchRpcClient } = await import("./rpc-security");
  const contents = new EventEmitter();
  const disconnect = vi.fn();
  const destroyed = vi.fn();
  watchRpcClient(contents, disconnect, destroyed);
  contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
  contents.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
  expect(disconnect).not.toHaveBeenCalled();
  contents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 11 });
  expect(disconnect).toHaveBeenCalledTimes(1);
  contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  expect(disconnect).toHaveBeenCalledTimes(2);
  contents.emit("destroyed");
  expect(destroyed).toHaveBeenCalledTimes(1);
  expect(disconnect).toHaveBeenCalledTimes(3);
  expect(contents.listenerCount("render-process-gone")).toBe(0);
  expect(contents.listenerCount("did-start-navigation")).toBe(0);
});

it("a reloaded page reusing request ids is answered only after its old client is ended", async () => {
  const { stringRpcServer } = await import("./rpc-security");
  const { Rpc } = await import("effect/rpc");
  const { Stream } = await import("effect");
  // Two real tags, so the frames pass the envelope check: a stream and a plain call.
  const Group = RpcGroup.make(
    Rpc.make("DesktopEvents", { payload: {}, success: Schema.String, stream: true }),
    Rpc.make("Diagnostics", { payload: {}, success: Schema.String }),
  );
  const handlers = Group.toLayer({
    DesktopEvents: () => Stream.never,
    Diagnostics: () => Effect.succeed("report"),
  });
  const sent: { requestId?: unknown; _tag?: unknown; exit?: { _tag?: unknown } }[] = [];
  let input: Parameters<Parameters<typeof stringRpcServer>[1]["attach"]>[0] | undefined;
  const layer = stringRpcServer(Group, {
    attach: (next) => {
      input = next;
      return () => null;
    },
    send: (_client, frame) => {
      for (const message of [JSON.parse(frame)].flat()) sent.push(message);
    },
    failure: () => null,
  }).pipe(Layer.provide(handlers));
  const request = (tag: string) =>
    JSON.stringify({ _tag: "Request", id: "0", tag, payload: {}, headers: [] });
  const answered = () =>
    sent.some((message) => message._tag === "Exit" && message.requestId === "0");
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(layer);
        yield* waitUntil(() => input !== undefined);
        // The crashed page's event stream holds request 0. Nothing observable marks the moment
        // the server registers it, so each step gets a short real-time head start.
        input?.frame(7, request("DesktopEvents"));
        yield* Effect.sleep(scaledMs(20));
        // The reloaded page numbers from zero again: its first call is dropped. A missing
        // answer has no event to wait on, so the check gives it a scaled window to show up.
        input?.frame(7, request("Diagnostics"));
        yield* Effect.sleep(scaledMs(50));
        expect(answered()).toBe(false);
        // Ending the old client clears its streams; the same call is then answered.
        input?.disconnect(7);
        yield* Effect.sleep(scaledMs(20));
        sent.length = 0;
        input?.frame(7, request("Diagnostics"));
        yield* waitUntil(answered);
      }),
    ),
  );
});

it("reports a request that answers after a second by its tag and wall time, except streams", async () => {
  const { createRpcFailureTracker, SLOW_RPC_MS } = await import("./rpc-security");
  let clock = 0;
  const recorded: string[] = [];
  const tracker = createRpcFailureTracker(
    (failure) => recorded.push(failure.rpc),
    () => clock,
  );
  const request = (id: number, tag: string) =>
    decodeRpcFrame(
      JSON.stringify({ _tag: "Request", id, tag, payload: { search: "private" }, headers: [] }),
    ) ?? [];
  const exit = (id: number, failed = false): RpcMessage.FromServerEncoded => ({
    _tag: "Exit",
    requestId: String(id),
    exit: failed
      ? { _tag: "Failure", cause: [{ _tag: "Fail", error: { _tag: "NotFound" } }] }
      : { _tag: "Success", value: null },
  });
  tracker.request(1, request(1, "Threads"));
  tracker.request(1, request(2, "Threads"));
  tracker.request(1, request(3, "ThreadCount"));
  tracker.request(1, request(4, "Events"));
  tracker.request(1, request(5, "Threads"));
  clock = SLOW_RPC_MS - 1;
  expect(tracker.response(1, exit(1))).toBeUndefined();
  clock = 2400.4;
  expect(tracker.response(1, exit(2))).toEqual({ rpc: "Threads", ms: 2400 });
  expect(tracker.response(1, exit(3, true))).toEqual({ rpc: "ThreadCount", ms: 2400 });
  expect(recorded).toEqual(["ThreadCount"]);
  // A stream such as Events stays open for the window's lifetime.
  expect(tracker.response(1, exit(4))).toBeUndefined();
  // An interrupted request is not timed.
  tracker.request(1, decodeRpcFrame(JSON.stringify({ _tag: "Interrupt", requestId: 5 })) ?? []);
  expect(tracker.response(1, exit(5))).toBeUndefined();
});

it("times only local read RPCs: never streams, undo-send waits, sign-in or model calls", async () => {
  const { createRpcFailureTracker, TIMED_RPCS } = await import("./rpc-security");
  const { RpcSchema } = await import("effect/rpc");
  for (const tag of TIMED_RPCS) {
    const rpc = MailRpcs.requests.get(tag);
    expect(rpc, tag).toBeDefined();
    expect(rpc && RpcSchema.isStreamSchema(rpc.successSchema), tag).toBe(false);
  }
  let clock = 0;
  const tracker = createRpcFailureTracker(
    () => null,
    () => clock,
  );
  const tags = ["Threads", "AwaitUndoSend", "AskAi", "Connect", "Send", "SaveAttachmentsTo"];
  for (const [id, tag] of tags.entries())
    tracker.request(
      1,
      decodeRpcFrame(JSON.stringify({ _tag: "Request", id, tag, payload: {}, headers: [] })) ?? [],
    );
  clock = 5500;
  const slow = tags.map((_, id) =>
    tracker.response(1, {
      _tag: "Exit",
      requestId: String(id),
      exit: { _tag: "Success", value: null },
    }),
  );
  expect(slow).toEqual([
    { rpc: "Threads", ms: 5500 },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
});

it("logs rpc-slow at most once a minute per RPC, without arguments", async () => {
  const { slowRpcWarning } = await import("./rpc-security");
  const { LOG_CODE_ANNOTATION } = await import("@openmail/core/schema");
  const lines: { message: unknown; code: unknown }[] = [];
  const capture = Logger.make((options) =>
    lines.push({
      message: options.message,
      code: options.fiber.getRef(References.CurrentLogAnnotations)[LOG_CODE_ANNOTATION],
    }),
  );
  const slow = slowRpcWarning();
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* slow({ rpc: "Threads", ms: 2400 });
      yield* slow({ rpc: "Threads", ms: 3100 });
      yield* slow({ rpc: "ThreadCount", ms: 1200 });
    }).pipe(Effect.provide(Logger.layer([capture]))),
  );
  expect(lines).toEqual([
    { message: ["RPC Threads took 2400 ms"], code: "rpc-slow" },
    { message: ["RPC ThreadCount took 1200 ms"], code: "rpc-slow" },
  ]);
});

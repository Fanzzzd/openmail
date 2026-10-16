import type { EventEmitter } from "node:events";
import { Effect, FiberSet, Layer, Queue, Schema } from "effect";
import { type Rpc, type RpcGroup, type RpcMessage, RpcSerialization, RpcServer } from "effect/rpc";
import { MailError, throttledWarning } from "@openmail/core/schema";
import { RPC_DEFECT_CLASSES, type RpcFailureKind } from "@openmail/core/node";
import { MAX_RPC_FRAME } from "../../shared/channel";
import { PUBLIC_ERROR_MESSAGES } from "../../shared/public-error-messages";
import { MailRpcs } from "../../shared/rpc";

const RequestId = Schema.Union([
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
]);
const Envelope = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Request"),
    id: RequestId,
    tag: Schema.String.check(Schema.isMaxLength(128)),
    payload: Schema.Unknown,
    headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])).check(
      Schema.isMaxLength(32),
    ),
  }),
  Schema.Struct({ _tag: Schema.Literal("Ack"), requestId: RequestId }),
  Schema.Struct({ _tag: Schema.Literal("Interrupt"), requestId: RequestId }),
  Schema.Struct({ _tag: Schema.Literal("Ping") }),
  Schema.Struct({ _tag: Schema.Literal("Eof") }),
]);
const Envelopes = Schema.Array(Envelope).check(Schema.isMinLength(1), Schema.isMaxLength(64));

/** Envelope decoding precedes Effect RPC's per-method payload Schema decoding. */
export function decodeRpcFrame(frame: unknown): readonly RpcMessage.FromClientEncoded[] | null {
  if (typeof frame !== "string" || frame.length > MAX_RPC_FRAME) return null;
  try {
    const json: unknown = JSON.parse(frame);
    const decoded = Schema.decodeUnknownOption(Envelopes)(Array.isArray(json) ? json : [json]);
    if (decoded._tag === "None") return null;
    if (
      decoded.value.some(
        (message) => message._tag === "Request" && !MailRpcs.requests.has(message.tag),
      )
    )
      return null;
    return decoded.value.map((message) =>
      message._tag === "Request" ? { ...message, headers: [] } : message,
    );
  } catch {
    return null;
  }
}

const FAILED = "the operation failed.";
const publicError = (value: unknown): unknown => {
  const decoded = Schema.decodeUnknownOption(MailError)(value);
  if (decoded._tag === "None") return { _tag: "DeviceError", message: FAILED };
  const error = Schema.encodeSync(MailError)(decoded.value);
  if (!("message" in error)) return error;
  if (
    PUBLIC_ERROR_MESSAGES.has(error.message) &&
    (error._tag === "InvalidInput" ||
      error._tag === "DeviceError" ||
      error._tag === "PermanentError" ||
      error._tag === "ProviderError")
  )
    return error;
  if (error._tag === "InvalidInput" || error._tag === "DeviceError")
    return PUBLIC_ERROR_MESSAGES.has(error.message) ? error : { ...error, message: FAILED };
  return { ...error, message: "" };
};

/** Never serialize defects, parser diagnostics, stacks or provider/OS error text. */
export function publicRpcResponse(
  response: RpcMessage.FromServerEncoded,
): RpcMessage.FromServerEncoded {
  if (response._tag === "Defect" || response._tag === "ClientProtocolError")
    return { _tag: "Defect", defect: "Internal RPC failure" };
  if (response._tag !== "Exit" || response.exit._tag !== "Failure") return response;
  return {
    ...response,
    exit: {
      _tag: "Failure",
      cause: response.exit.cause.map((cause) => {
        if (cause._tag === "Die") return { _tag: "Die", defect: "Internal RPC failure" };
        if (cause._tag === "Fail") return { _tag: "Fail", error: publicError(cause.error) };
        return cause;
      }),
    },
  };
}

/** A failed request as the local log records it: the RPC name, how it failed and an identifier. */
export interface RpcFailure {
  readonly rpc: string;
  readonly kind: RpcFailureKind;
  /** The typed error's _tag, or a defect's class from RPC_DEFECT_CLASSES ("Other" otherwise). */
  readonly error?: string;
}

const ERROR_TAG = /^[A-Z][A-Za-z0-9]{0,63}$/;
const field = (value: unknown, key: string) =>
  typeof value === "object" && value !== null && key in value ? Reflect.get(value, key) : undefined;

/** How an encoded cause failed. Reads only the error's _tag or the defect's class name. */
type EncodedCause = Extract<RpcMessage.ExitEncoded<unknown, unknown>, { _tag: "Failure" }>["cause"];
const describeFailure = (cause: EncodedCause): Omit<RpcFailure, "rpc"> | undefined => {
  const fail = cause.find((item) => item._tag === "Fail");
  if (fail) {
    const tag = field(fail.error, "_tag");
    return {
      kind: "failure",
      ...(typeof tag === "string" && ERROR_TAG.test(tag) ? { error: tag } : {}),
    };
  }
  const die = cause.find((item) => item._tag === "Die");
  if (die) {
    const name = field(die.defect, "name");
    return {
      kind: "defect",
      error: typeof name === "string" && RPC_DEFECT_CLASSES.has(name) ? name : "Other",
    };
  }
  return cause.some((item) => item._tag === "Interrupt") ? { kind: "interrupt" } : undefined;
};

/** One line for stderr: "Threads defect TypeError". */
export const rpcFailureText = (failure: RpcFailure) =>
  [failure.rpc, failure.kind, failure.error].filter(Boolean).join(" ");

/** A request in TIMED_RPCS that answers later than this logs `rpc-slow`. */
export const SLOW_RPC_MS = 1000;

/**
 * The RPCs that log `rpc-slow`: reads of the local database and in-memory state, which should
 * answer in milliseconds, so a second means a local stall. Every other RPC can take seconds by
 * design and would bury those lines: AwaitUndoSend waits out the undo delay (about 5.5 s a
 * send), Connect and Reauth wait for the browser sign-in, AskAi, Summarize, ComposeAi and
 * AiTriage wait for the model, Send, Sync, SearchServer, CheckForUpdates and CompactCache do
 * network or disk work, and dialogs such as SaveAttachmentsTo wait for the person. InlineImages
 * downloads the message source on first open and SyncHealth asks the provider, so they are
 * left out too. Streams stay open for the window's lifetime and are never timed.
 */
export const TIMED_RPCS: ReadonlySet<string> = new Set([
  "Threads",
  "ThreadCount",
  // Reads the stored thread; refetches a body only after the cache evicted it.
  "Thread",
  "UnreadCounts",
  "UnreadByLabel",
  "Labels",
  "KnownSenders",
  "Accounts",
  "Profiles",
  "Prefs",
  "LabelPreferences",
  "Templates",
  "Signatures",
  "NamedSignatures",
  "SignatureDefaults",
  "HiddenContacts",
  "ImageSenders",
  "UndoHistory",
  "FailedOps",
  "Proposals",
  "Audit",
  "BackfillState",
  "CacheWindows",
  "DraftStatus",
] satisfies readonly RpcGroup.Rpcs<typeof MailRpcs>["_tag"][]);

/** A request that took SLOW_RPC_MS or longer: its tag and wall time, nothing else. */
export interface SlowRpc {
  readonly rpc: string;
  readonly ms: number;
}

/**
 * Track only validated request tags, never payloads, credentials or account identifiers.
 * A request the client interrupted itself is not a failure. `response` returns a TIMED_RPCS
 * request that took SLOW_RPC_MS or longer.
 */
export function createRpcFailureTracker(
  record: (failure: RpcFailure) => void,
  now: () => number = () => performance.now(),
) {
  const clients = new Map<number, Map<string, { tag: string; start: number }>>();
  return {
    request(client: number, messages: readonly RpcMessage.FromClientEncoded[]) {
      let tags = clients.get(client);
      for (const message of messages) {
        if (message._tag === "Interrupt") tags?.delete(String(message.requestId));
        if (message._tag !== "Request" || !MailRpcs.requests.has(message.tag)) continue;
        if (!tags) {
          tags = new Map();
          clients.set(client, tags);
        }
        tags.set(String(message.id), { tag: message.tag, start: now() });
      }
    },
    response(client: number, response: RpcMessage.FromServerEncoded): SlowRpc | undefined {
      if (response._tag !== "Exit") return undefined;
      const tags = clients.get(client);
      const request = tags?.get(String(response.requestId));
      tags?.delete(String(response.requestId));
      if (!tags?.size) clients.delete(client);
      if (!request) return undefined;
      if (response.exit._tag === "Failure") {
        const failure = describeFailure(response.exit.cause);
        if (failure) record({ rpc: request.tag, ...failure });
      }
      const ms = now() - request.start;
      return ms >= SLOW_RPC_MS && TIMED_RPCS.has(request.tag)
        ? { rpc: request.tag, ms: Math.round(ms) }
        : undefined;
    },
    disconnect(client: number) {
      clients.delete(client);
    },
  };
}

/**
 * Logs a slow request as `rpc-slow` with its tag and wall time, at most once a minute per RPC, so
 * a burst of slow searches leaves one line.
 */
export function slowRpcWarning(intervalMs = 60_000) {
  const warnings = new Map<string, ReturnType<typeof throttledWarning>>();
  return ({ rpc, ms }: SlowRpc) => {
    let warn = warnings.get(rpc);
    if (!warn) {
      warn = throttledWarning("rpc-slow", intervalMs);
      warnings.set(rpc, warn);
    }
    return warn(`RPC ${rpc} took ${ms} ms`);
  };
}

/** Feeds a string transport's frames into the protocol. */
export interface StringProtocolInput {
  /** One frame from a client. False when it is not a valid RPC frame. */
  frame(clientId: number, frame: unknown): boolean;
  disconnect(clientId: number): void;
}

export interface StringTransport {
  /** Starts delivering frames; returns the teardown. */
  attach(input: StringProtocolInput): () => void;
  send(clientId: number, frame: string): void;
  end?(clientId: number): void;
  /** Failed requests, for the local log. */
  failure(failure: RpcFailure): void;
  /** Sees each validated batch before it runs. */
  inspect?(clientId: number, messages: readonly RpcMessage.FromClientEncoded[]): void;
}

/**
 * Effect RPC over JSON string frames, shared by Electron IPC and the remote
 * WebSockets: envelope checks on the way in, scrubbed errors and the failure
 * tracker on the way out.
 */
export const makeStringProtocol = (transport: StringTransport) =>
  Layer.effect(
    RpcServer.Protocol,
    Effect.gen(function* () {
      const serialization = yield* RpcSerialization.RpcSerialization;
      return yield* RpcServer.Protocol.make(
        Effect.fnUntraced(function* (writeRequest) {
          const disconnects = yield* Queue.make<number>();
          const clients = new Set<number>();
          const failures = createRpcFailureTracker((failure) => transport.failure(failure));
          const slow = slowRpcWarning();
          const parser = serialization.makeUnsafe();
          const run = yield* FiberSet.makeRuntime();
          const detach = transport.attach({
            frame: (clientId, frame) => {
              const messages = decodeRpcFrame(frame);
              if (!messages) return false;
              clients.add(clientId);
              transport.inspect?.(clientId, messages);
              failures.request(clientId, messages);
              run(
                Effect.forEach(messages, (message) => writeRequest(clientId, message), {
                  discard: true,
                }),
              );
              return true;
            },
            disconnect: (clientId) => {
              clients.delete(clientId);
              failures.disconnect(clientId);
              run(Queue.offer(disconnects, clientId));
            },
          });
          yield* Effect.addFinalizer(() => Effect.sync(detach));
          return {
            disconnects,
            send: (clientId, response) =>
              Effect.suspend(() => {
                const slowRequest = failures.response(clientId, response);
                const frame = parser.encode(publicRpcResponse(response));
                if (typeof frame === "string") transport.send(clientId, frame);
                return slowRequest ? slow(slowRequest) : Effect.void;
              }),
            end: (clientId) => Effect.sync(() => transport.end?.(clientId)),
            clientIds: Effect.sync(() => new Set(clients)),
            initialMessage: Effect.succeedNone,
            supportsAck: true,
            supportsTransferables: false,
            supportsSpanPropagation: false,
            supportsNotifications: true,
            codecFor: serialization.codecFor,
          };
        }),
      );
    }),
  );

/**
 * The RPC server over a string transport. A handler that dies fails only its own request.
 * Effect RPC's default instead sends the client one Defect frame, which fails every request
 * the client has in flight: a window's Events subscription and its other streams with it.
 */
export const stringRpcServer = <Rpcs extends Rpc.Any>(
  group: RpcGroup.RpcGroup<Rpcs>,
  transport: StringTransport,
) =>
  RpcServer.layer(group, { disableFatalDefects: true }).pipe(
    Layer.provide(makeStringProtocol(transport)),
    Layer.provide(RpcSerialization.layerJson),
  );

/**
 * Ends a renderer's RPC client when its page goes away. A crashed or reloaded page keeps its
 * webContents id, and its new RPC client numbers requests from zero again. The server drops a
 * request whose id one of the old page's streams still holds, so a call such as Diagnostics after
 * a renderer crash never answered.
 */
export function watchRpcClient(
  client: EventEmitter,
  disconnect: () => void,
  destroyed: () => void,
) {
  const gone = () => disconnect();
  const navigated = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
    if (details.isMainFrame && !details.isSameDocument) disconnect();
  };
  client.on("render-process-gone", gone);
  client.on("did-start-navigation", navigated);
  client.once("destroyed", () => {
    client.off("render-process-gone", gone);
    client.off("did-start-navigation", navigated);
    destroyed();
    disconnect();
  });
}

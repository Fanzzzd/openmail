import { Effect, FiberSet, Layer, Queue, Schema } from "effect";
import { type RpcMessage, RpcSerialization, RpcServer } from "effect/rpc";
import { MailError } from "@openmail/core/schema";
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

/** Track only validated request tags, never payloads, credentials or account identifiers. */
export function createRpcFailureTracker(record: (tag: string) => void) {
  const clients = new Map<number, Map<string, string>>();
  return {
    request(client: number, messages: readonly RpcMessage.FromClientEncoded[]) {
      let tags = clients.get(client);
      for (const message of messages) {
        if (message._tag !== "Request" || !MailRpcs.requests.has(message.tag)) continue;
        if (!tags) {
          tags = new Map();
          clients.set(client, tags);
        }
        tags.set(String(message.id), message.tag);
      }
    },
    response(client: number, response: RpcMessage.FromServerEncoded) {
      if (response._tag !== "Exit") return;
      const tags = clients.get(client);
      const tag = tags?.get(String(response.requestId));
      tags?.delete(String(response.requestId));
      if (!tags?.size) clients.delete(client);
      if (!tag || response.exit._tag !== "Failure") return;
      if (response.exit.cause.some((cause) => cause._tag === "Fail" || cause._tag === "Die"))
        record(tag);
    },
    disconnect(client: number) {
      clients.delete(client);
    },
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
  /** Tags of failed requests, for the local log. */
  failure(tag: string): void;
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
          const failures = createRpcFailureTracker((tag) => transport.failure(tag));
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
              Effect.sync(() => {
                failures.response(clientId, response);
                const frame = parser.encode(publicRpcResponse(response));
                if (typeof frame === "string") transport.send(clientId, frame);
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

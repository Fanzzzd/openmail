import { Mailbox } from "@openmail/core";
import { Effect, FiberSet, Layer, Queue } from "effect";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { decodeRpcFrame, publicRpcResponse } from "../rpc/rpc-security";
import { remoteHandlers } from "./remote-handlers";
import { remoteDisposition, RemoteRpcs } from "./remote-rpcs";
import type { ConnectionListener } from "./remote-server";

const ignore = () => null;

/** Lets the HTTP server hand connections to the RPC protocol once it runs. */
export function createConnectionHub() {
  let listener: ConnectionListener | undefined;
  return {
    onConnection: ((connection) => {
      if (listener) return listener(connection);
      connection.close(1013, "Starting");
      return { message: ignore, closed: ignore };
    }) satisfies ConnectionListener,
    get listening() {
      return listener !== undefined;
    },
    listen(next: ConnectionListener) {
      listener = next;
      return () => {
        if (listener === next) listener = undefined;
      };
    },
  };
}
export type ConnectionHub = ReturnType<typeof createConnectionHub>;

/**
 * Effect RPC over the remote WebSockets. Frames get the same envelope checks
 * and error scrubbing as Electron IPC. Each socket is one client.
 */
const remoteProtocol = (hub: ConnectionHub, denied: (tag: string) => void) =>
  Layer.effect(
    RpcServer.Protocol,
    Effect.gen(function* () {
      const serialization = yield* RpcSerialization.RpcSerialization;
      return yield* RpcServer.Protocol.make(
        Effect.fnUntraced(function* (writeRequest) {
          const disconnects = yield* Queue.make<number>();
          const clients = new Map<number, { send(frame: string): void; close(): void }>();
          const parser = serialization.makeUnsafe();
          const run = yield* FiberSet.makeRuntime();
          let next = 0;
          const off = hub.listen((connection) => {
            const id = ++next;
            clients.set(id, connection);
            return {
              message: (frame) => {
                const messages = decodeRpcFrame(frame);
                if (!messages) {
                  connection.close(1008, "Invalid frame");
                  return;
                }
                for (const message of messages)
                  if (message._tag === "Request" && remoteDisposition(message.tag) === "denied")
                    denied(message.tag);
                // Denied tags reach a group without them and fail there.
                run(
                  Effect.forEach(messages, (message) => writeRequest(id, message), {
                    discard: true,
                  }),
                );
              },
              closed: () => {
                clients.delete(id);
                run(Queue.offer(disconnects, id));
              },
            };
          });
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              off();
              for (const client of clients.values()) client.close();
            }),
          );
          return {
            disconnects,
            send: (clientId, response) =>
              Effect.sync(() => {
                const frame = parser.encode(publicRpcResponse(response));
                if (typeof frame === "string") clients.get(clientId)?.send(frame);
              }),
            end: (clientId) => Effect.sync(() => clients.get(clientId)?.close()),
            clientIds: Effect.sync(() => new Set(clients.keys())),
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

/** The remote RPC server. Only RemoteRpcs exist here; everything else has no handler. */
export const remoteRpcServer = (hub: ConnectionHub, denied: (tag: string) => void = ignore) =>
  RpcServer.layer(RemoteRpcs).pipe(
    Layer.provide(
      RemoteRpcs.toLayer(
        Effect.gen(function* () {
          return remoteHandlers(yield* Mailbox);
        }),
      ),
    ),
    Layer.provide(remoteProtocol(hub, denied)),
    Layer.provide(RpcSerialization.layerJson),
  );

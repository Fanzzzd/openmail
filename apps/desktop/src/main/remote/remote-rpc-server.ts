import { Mailbox } from "@openmail/core";
import { Effect, Layer } from "effect";
import { type RpcFailure, stringRpcServer, type StringTransport } from "../rpc/rpc-security";
import { remoteHandlers } from "./remote-handlers";
import { remoteDisposition, RemoteRpcs } from "./remote-rpcs";
import type { ConnectionListener, RemoteConnection } from "./remote-server";

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

export interface RemoteRpcLog {
  /** A request for an RPC outside the remote table. */
  denied(tag: string): void;
  /** A request that failed. */
  failure(failure: RpcFailure): void;
}
const quiet: RemoteRpcLog = { denied: ignore, failure: ignore };

/**
 * Effect RPC over the remote WebSockets, with the same envelope checks, error
 * scrubbing and failure tracking as Electron IPC. Each socket is one client.
 */
const remoteTransport = (hub: ConnectionHub, log: RemoteRpcLog): StringTransport => {
  const clients = new Map<number, RemoteConnection>();
  return {
    attach: (input) => {
      let next = 0;
      const off = hub.listen((connection) => {
        const id = ++next;
        clients.set(id, connection);
        return {
          message: (frame) => {
            if (!input.frame(id, frame)) connection.close(1008, "Invalid frame");
          },
          closed: () => {
            clients.delete(id);
            input.disconnect(id);
          },
        };
      });
      return () => {
        off();
        for (const client of clients.values()) client.close();
        clients.clear();
      };
    },
    send: (clientId, frame) => clients.get(clientId)?.send(frame),
    end: (clientId) => clients.get(clientId)?.close(),
    failure: (failure) => log.failure(failure),
    // Denied tags reach a group without them and fail there.
    inspect: (_, messages) => {
      for (const message of messages)
        if (message._tag === "Request" && remoteDisposition(message.tag) === "denied")
          log.denied(message.tag);
    },
  };
};

/** The remote RPC server. Only RemoteRpcs exist here; everything else has no handler. */
export const remoteRpcServer = (hub: ConnectionHub, log: RemoteRpcLog = quiet) =>
  stringRpcServer(RemoteRpcs, remoteTransport(hub, log)).pipe(
    Layer.provide(
      RemoteRpcs.toLayer(
        Effect.gen(function* () {
          return remoteHandlers(yield* Mailbox);
        }),
      ),
    ),
  );

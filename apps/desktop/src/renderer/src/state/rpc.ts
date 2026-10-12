import { redactSyncHealth, type SyncHealth } from "@openmail/core/schema";
import { Effect, FiberSet, Layer } from "effect";
import { AtomRpc } from "effect/reactivity";
import { type RpcMessage, RpcClient, RpcSerialization } from "effect/rpc";

import type { RpcBridge } from "../../../shared/channel";
import { MailRpcs } from "../../../shared/rpc";
import { rpcBridge } from "./rpc-bridge";

declare global {
  interface Window {
    openmailRpc: RpcBridge;
    openmailSyncHealth: () => Promise<readonly SyncHealth[]>;
  }
}

/**
 * RPC client transport over a string pipe: the preload's IPC bridge in the
 * desktop app, a WebSocket to the Mac in the web build.
 */
const ElectronProtocol = Layer.effect(
  RpcClient.Protocol,
  Effect.gen(function* () {
    const serialization = yield* RpcSerialization.RpcSerialization;
    return yield* RpcClient.Protocol.make(
      Effect.fnUntraced(function* (writeResponse, clientIds) {
        const parser = serialization.makeUnsafe();
        const run = yield* FiberSet.makeRuntime();
        const bridge = rpcBridge();
        // Route by request owner even before a short-lived client's receive
        // loop starts. Protocol.make buffers early replies for that client.
        const owners = new Map<string | number, number>();
        const off = bridge.onFrame((frame) => {
          run(
            Effect.forEach(
              parser.decode(frame) as ReadonlyArray<RpcMessage.FromServerEncoded>,
              (response) => {
                if (response._tag === "Exit" || response._tag === "Chunk") {
                  const owner = owners.get(response.requestId);
                  if (owner === undefined) return Effect.void;
                  if (response._tag === "Exit") owners.delete(response.requestId);
                  return writeResponse(owner, response);
                }
                if (response._tag === "Defect" || response._tag === "ClientProtocolError")
                  owners.clear();
                return Effect.forEach(clientIds, (id) => writeResponse(id, response));
              },
              { discard: true },
            ),
          );
        });
        yield* Effect.addFinalizer(() => Effect.sync(off));
        return {
          send: (clientId, request) =>
            Effect.sync(() => {
              if (request._tag === "Request") owners.set(request.id, clientId);
              else if (request._tag === "Interrupt") owners.delete(request.requestId);
              const frame = parser.encode(request);
              // layerJson always encodes to strings.
              if (typeof frame === "string") bridge.send(frame);
            }),
          supportsAck: true,
          supportsTransferables: false,
          codecFor: serialization.codecFor,
        };
      }),
    );
  }),
).pipe(Layer.provide(RpcSerialization.layerJson));

/**
 * The renderer's handle on the main process: `MailClient.query(tag, payload)`
 * gives an atom, `MailClient.mutation(tag)` a writable atom that can
 * invalidate reactivity keys on success.
 */
export class MailClient extends AtomRpc.Service<MailClient>()("openmail/MailClient", {
  group: MailRpcs,
  protocol: ElectronProtocol,
}) {}

/** Key submission uses a short-lived RPC client, without storing its payload in atoms. */
export const submitAiKey = (key: string) =>
  Effect.gen(function* () {
    const client = yield* RpcClient.make(MailRpcs);
    yield* client.SetAiKey({ key });
  }).pipe(Effect.provide(ElectronProtocol), Effect.scoped);

/** Smoke reads through the app's RPC client, including its codecs and permission checks. */
export const readSyncHealth = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* RpcClient.make(MailRpcs);
      const accounts = yield* client.Accounts();
      return yield* Effect.forEach(
        accounts,
        (account) =>
          client.SyncHealth({ accountId: account.id }).pipe(Effect.map(redactSyncHealth)),
        { concurrency: 1 },
      );
    }).pipe(Effect.provide(ElectronProtocol), Effect.scoped),
  );

if (typeof window !== "undefined") window.openmailSyncHealth = readSyncHealth;

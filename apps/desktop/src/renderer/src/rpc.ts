import { Effect, FiberSet, Layer } from "effect";
import { AtomRpc } from "effect/reactivity";
import { type RpcMessage, RpcClient, RpcSerialization } from "effect/rpc";

import type { RpcBridge } from "../../shared/channel";
import { MailRpcs } from "../../shared/rpc";

declare global {
  interface Window {
    openmailRpc: RpcBridge;
  }
}

/** RPC client transport over the preload's string pipe to the main process. */
const ElectronProtocol = Layer.effect(
  RpcClient.Protocol,
  Effect.gen(function* () {
    const serialization = yield* RpcSerialization.RpcSerialization;
    return yield* RpcClient.Protocol.make(
      Effect.fnUntraced(function* (writeResponse, clientIds) {
        const parser = serialization.makeUnsafe();
        const run = yield* FiberSet.makeRuntime();
        const bridge = window.openmailRpc;
        // One renderer is one client; responses carry their request id, so
        // every local client may see every frame.
        const off = bridge.onFrame((frame) =>
          run(
            Effect.forEach(
              parser.decode(frame) as ReadonlyArray<RpcMessage.FromServerEncoded>,
              (response) => Effect.forEach(clientIds, (id) => writeResponse(id, response)),
              { discard: true },
            ),
          ),
        );
        yield* Effect.addFinalizer(() => Effect.sync(off));
        return {
          send: (_clientId, request) =>
            Effect.sync(() => {
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

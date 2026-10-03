import { Effect } from "effect";
import { afterAll, expect, it, vi } from "vitest";
import type { RpcBridge } from "../../shared/channel";
import { decodeRpcFrame, publicRpcResponse } from "../../main/rpc-security";
import { submitAiKey } from "./rpc";

vi.hoisted(() => {
  vi.resetModules();
  vi.doUnmock("./rpc");
});
afterAll(() => {
  vi.resetModules();
});

it("a short-lived key client receives a validation reply before its receive loop starts", async () => {
  const listeners = new Set<(frame: string) => void>();
  const bridge: RpcBridge = {
    onFrame: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    send: (frame) => {
      for (const message of decodeRpcFrame(frame) ?? []) {
        if (message._tag !== "Request") continue;
        const response = publicRpcResponse({
          _tag: "Exit",
          requestId: message.id,
          exit: {
            _tag: "Failure",
            cause: [
              { _tag: "Fail", error: { _tag: "InvalidInput", message: "Enter a single API key." } },
            ],
          },
        });
        // Deliberately synchronous, so broadcasting only to active loops loses this reply.
        for (const listener of listeners) listener(JSON.stringify(response));
      }
    },
  };
  vi.stubGlobal("window", { openmailRpc: bridge });
  try {
    const failure = await Effect.runPromise(
      submitAiKey("fixture").pipe(Effect.flip, Effect.timeout("1 second")),
    );
    expect(failure).toMatchObject({ _tag: "InvalidInput", message: "Enter a single API key." });
    expect(listeners.size).toBe(0);
  } finally {
    vi.unstubAllGlobals();
  }
});

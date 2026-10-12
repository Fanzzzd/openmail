import { Effect } from "effect";
import { afterAll, expect, it, vi } from "vitest";
import type { RpcBridge } from "../../../shared/channel";
import { decodeRpcFrame, publicRpcResponse } from "../../../main/rpc-security";
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
        for (const listener of listeners) {
          const returned: unknown = listener(structuredClone(JSON.stringify(response)));
          expect(returned).toBeUndefined();
          expect(() => structuredClone(returned)).not.toThrow();
        }
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

it("smoke health bridge uses allowed Accounts/SyncHealth RPCs and preserves offline counts in redacted JSON", async () => {
  const { readSyncHealth } = await import("./rpc");
  const listeners = new Set<(frame: string) => void>();
  const tags: string[] = [];
  const bridge: RpcBridge = {
    onFrame: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    send: (frame) => {
      for (const request of decodeRpcFrame(frame) ?? []) {
        if (request._tag !== "Request") continue;
        tags.push(request.tag);
        const value =
          request.tag === "Accounts"
            ? [
                {
                  id: "gmail:me@example.com",
                  provider: "gmail",
                  email: "me@example.com",
                  createdAt: 1,
                  lastSyncedAt: null,
                  lastSyncError: null,
                  profileId: null,
                  needsReauth: false,
                },
              ]
            : {
                provider: "gmail",
                accountDomainHash: "domain-hash",
                checkedAt: 1,
                cursorAgeMs: null,
                pendingOps: 2,
                folders: [
                  {
                    scope: "private@company.invalid",
                    local: { total: 3, unread: 1, threads: 2 },
                    server: { kind: "unavailable" },
                    bodyCacheWindowDays: 30,
                    headerWindow: null,
                    cursorAgeMs: null,
                    pendingOps: 2,
                    verdict: "server unavailable",
                  },
                ],
              };
        for (const listener of listeners)
          listener(
            JSON.stringify({
              _tag: "Exit",
              requestId: request.id,
              exit: { _tag: "Success", value },
            }),
          );
      }
    },
  };
  vi.stubGlobal("window", { openmailRpc: bridge });
  try {
    const report = await readSyncHealth();
    expect(tags).toEqual(["Accounts", "SyncHealth"]);
    expect(report[0]?.folders[0]).toMatchObject({
      scope: "folder:1",
      local: { total: 3, unread: 1 },
      verdict: "server unavailable",
    });
    expect(JSON.stringify(report)).not.toContain("@");
    expect(listeners.size).toBe(0);
  } finally {
    vi.unstubAllGlobals();
  }
});

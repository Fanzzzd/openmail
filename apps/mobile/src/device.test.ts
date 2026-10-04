import { Effect, ManagedRuntime } from "effect";
import { Mailbox } from "@openmail/core/portable";
import { TestMailbox } from "@openmail/core/testing/node";
import { expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({
  state: "active",
  connected: false,
  reachable: false,
  appListener: null as ((state: string) => void) | null,
  networkListener: null as
    | ((state: { isConnected: boolean; isInternetReachable: boolean }) => void)
    | null,
}));
vi.mock("react-native", () => ({
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      native.appListener = listener;
      return {
        remove: () => {
          native.appListener = null;
        },
      };
    },
    get currentState() {
      return native.state;
    },
  },
}));
vi.mock("expo-network", () => ({
  addNetworkStateListener: (listener: typeof native.networkListener) => {
    native.networkListener = listener;
    return {
      remove: () => {
        native.networkListener = null;
      },
    };
  },
  getNetworkStateAsync: async () => ({
    isConnected: native.connected,
    isInternetReachable: native.reachable,
  }),
}));
import { deviceOnline, watchConnectivity, resumeConnectivity } from "./device";
it("treats unreachable networks as offline before core sends", async () => {
  expect(await deviceOnline()).toBe(false);
  native.connected = true;
  expect(await deviceOnline()).toBe(false);
  native.reachable = true;
  expect(await deviceOnline()).toBe(true);
});

it("active and foreground online events clear portable backoff before work", async () => {
  const runtime = ManagedRuntime.make(TestMailbox());
  const mailbox = await runtime.runPromise(Mailbox);
  const calls: string[] = [];
  vi.spyOn(mailbox, "resetConnectivity").mockImplementation(() =>
    Effect.sync(() => {
      calls.push("reset");
    }),
  );
  let resumed = Promise.resolve<unknown>(undefined);
  const watcher = watchConnectivity(
    () => {
      resumed = resumeConnectivity(runtime, async () => {
        calls.push("work");
      });
    },
    () => {
      calls.push("background");
    },
  );
  try {
    native.state = "active";
    native.appListener?.("active");
    await resumed;
    native.networkListener?.({ isConnected: true, isInternetReachable: true });
    await resumed;
    expect(calls).toEqual(["reset", "work", "reset", "work"]);
    native.state = "background";
    native.appListener?.("background");
    native.networkListener?.({ isConnected: true, isInternetReachable: true });
    expect(calls.at(-1)).toBe("background");
  } finally {
    watcher.remove();
    await runtime.dispose();
    vi.restoreAllMocks();
  }
  expect(native.appListener).toBeNull();
  expect(native.networkListener).toBeNull();
});

import { expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ state: "active", connected: false, reachable: false }));
vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return native.state;
    },
  },
}));
vi.mock("expo-network", () => ({
  getNetworkStateAsync: async () => ({
    isConnected: native.connected,
    isInternetReachable: native.reachable,
  }),
}));
import { deviceOnline } from "./device";
it("treats unreachable networks as offline before core sends", async () => {
  expect(await deviceOnline()).toBe(false);
  native.connected = true;
  expect(await deviceOnline()).toBe(false);
  native.reachable = true;
  expect(await deviceOnline()).toBe(true);
});

import { beforeEach, expect, it, vi } from "vitest";
import type TcpSocket from "react-native-tcp-socket";

const native = vi.hoisted(() => ({
  listeners: new Map<string, Set<(event: unknown) => void>>(),
  connect: vi.fn<(id: number, options: unknown) => void>(),
  startTLS: vi.fn<(id: number, options: unknown) => void>(),
}));
vi.mock("react-native", () => ({
  NativeModules: { TcpSockets: { connect: native.connect, startTLS: native.startTLS } },
  Image: { resolveAssetSource: (source: unknown) => source },
  NativeEventEmitter: class {
    addListener(name: string, listener: (event: unknown) => void) {
      const listeners = native.listeners.get(name) ?? new Set<(event: unknown) => void>();
      listeners.add(listener);
      native.listeners.set(name, listeners);
      return { remove: () => listeners.delete(listener) };
    }
  },
}));
const { default: Socket } = await vi.importActual<{ default: typeof TcpSocket.Socket }>(
  "react-native-tcp-socket/src/Socket.js",
);
const { default: TLSSocket } = await vi.importActual<{ default: typeof TcpSocket.TLSSocket }>(
  "react-native-tcp-socket/src/TLSSocket.js",
);
const emitConnected = (id: number) => {
  for (const listener of native.listeners.get("connect") ?? [])
    listener({
      id,
      connection: {
        localAddress: "127.0.0.1",
        localPort: 123,
        remoteAddress: "127.0.0.1",
        remotePort: 587,
        remoteFamily: "IPv4",
      },
    });
};
beforeEach(() => {
  native.listeners.clear();
  native.connect.mockClear();
  native.startTLS.mockClear();
});
it("the actual library emits secureConnect only on native handshake completion for STARTTLS", () => {
  const plain = new Socket().connect({ host: "smtp.example.test", port: 587 }, () => {
    /* Initial TCP readiness. */
  });
  const id = native.connect.mock.calls[0]?.[0];
  if (id === undefined) throw new Error("No native connect");
  emitConnected(id);
  const upgraded = new TLSSocket(plain);
  const secure = vi.fn();
  upgraded.once("secureConnect", secure);
  expect(native.startTLS).toHaveBeenCalledWith(id, {});
  expect(secure).not.toHaveBeenCalled();
  emitConnected(id);
  expect(secure).toHaveBeenCalledTimes(1);
});
it("implicit TLS reports native secure readiness exactly once", () => {
  const secure = vi.fn();
  const plain = new Socket();
  const tls = new TLSSocket(plain);
  tls.once("secureConnect", secure);
  plain.connect({ host: "smtp.example.test", port: 465 });
  const id = native.connect.mock.calls[0]?.[0];
  if (id === undefined) throw new Error("No native connect");
  expect(secure).not.toHaveBeenCalled();
  emitConnected(id);
  expect(secure).toHaveBeenCalledTimes(1);
});

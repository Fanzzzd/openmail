import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { beforeEach, expect, it, vi } from "vitest";
import { MailTransport } from "@openmail/core/portable";

const native = vi.hoisted(() => ({
  sockets: [] as EventEmitter[],
  options: [] as unknown[],
  writeBlocked: false,
  delayTLS: false,
  writes: [] as Uint8Array[],
  callbacks: [] as ((error?: Error) => void)[],
}));
vi.mock("react-native-tcp-socket", async () => {
  const { EventEmitter } = await import("node:events");
  class Socket extends EventEmitter {
    destroyed = false;
    constructor() {
      super();
      native.sockets.push(this);
    }
    setTimeout() {
      return this;
    }
    write(_data: Uint8Array, _encoding: unknown, written?: (error?: Error) => void) {
      native.writes.push(new Uint8Array(_data));
      if (!native.writeBlocked) written?.();
      else if (written) native.callbacks.push(written);
      return true;
    }
    destroy() {
      if (this.destroyed) return this;
      this.destroyed = true;
      this.emit("close");
      return this;
    }
  }
  class TLS extends Socket {
    constructor(_socket: Socket) {
      super();
      if (!native.delayTLS) queueMicrotask(() => this.emit("secureConnect"));
    }
  }
  const connection = (options: unknown, ready: () => void) => {
    native.options.push(options);
    const socket = new Socket();
    queueMicrotask(ready);
    return socket;
  };
  return {
    default: {
      Socket,
      TLSSocket: TLS,
      connectTLS: vi.fn(connection),
      createConnection: vi.fn(connection),
    },
  };
});
import { transportLayer } from "./transport";
const connect = (signal: AbortSignal, tls = true) =>
  Effect.runPromise(
    Effect.flatMap(MailTransport, (transport) =>
      Effect.promise(() =>
        transport.connect({ host: "imap.example.test", port: tls ? 993 : 143, tls, signal }),
      ),
    ).pipe(Effect.provide(transportLayer)),
  );
beforeEach(() => {
  native.sockets.length = 0;
  native.options.length = 0;
  native.writeBlocked = false;
  native.delayTLS = false;
  native.writes.length = 0;
  native.callbacks.length = 0;
});
it("preserves binary chunks, upgrades to TLS and rejects pending reads on cancellation", async () => {
  const controller = new AbortController();
  const socket = await connect(controller.signal, false);
  native.sockets[0]?.emit("data", new Uint8Array([0, 255, 13, 10]));
  expect(await socket.read()).toEqual(new Uint8Array([0, 255, 13, 10]));
  await socket.startTLS();
  const pending = socket.read();
  controller.abort();
  await expect(pending).rejects.toThrow("closed");
  expect(native.sockets).toHaveLength(2);
  expect(native.options[0]).toEqual({
    host: "imap.example.test",
    port: 143,
    connectTimeout: 20000,
  });
});
it("cancellation rejects a write awaiting a native callback", async () => {
  native.writeBlocked = true;
  const controller = new AbortController();
  const socket = await connect(controller.signal);
  const written = socket.write(new Uint8Array([1]));
  controller.abort();
  await expect(written).rejects.toThrow("closed");
});
it("the installed Android TLS patch verifies hostname for initial and upgraded sockets", () => {
  const source = readFileSync(
    new URL(
      "../../node_modules/react-native-tcp-socket/android/src/main/java/com/asterinet/react/tcpsocket/TcpSocketClient.java",
      import.meta.url,
    ),
    "utf8",
  );
  expect(source).toContain('parameters.setEndpointIdentificationAlgorithm("HTTPS")');
  expect(source).toContain("ssf.createSocket(socket, mailServerHost, socket.getPort(), true)");
  expect(source).toContain("if (tlsOptions != null) startTLS(context, tlsOptions)");
  expect(source).toContain("synchronized (clientSocket.readLock)");
  expect(source).toContain("active.getInputStream().read(buffer)");
  expect(source).not.toContain("BufferedInputStream");
  const module = readFileSync(
    new URL(
      "../../node_modules/react-native-tcp-socket/android/src/main/java/com/asterinet/react/tcpsocket/TcpSocketModule.java",
      import.meta.url,
    ),
    "utf8",
  );
  expect(module).toContain("tcpEvtListener.onConnect(cId, socketClient)");
  const ios = readFileSync(
    new URL("../../node_modules/react-native-tcp-socket/ios/TcpSocketClient.m", import.meta.url),
    "utf8",
  );
  expect(ios).toContain(
    "_connecting = true; // Emit connect only after the STARTTLS handshake finishes.",
  );
});

it("delivers an acknowledged response queued before peer EOF", async () => {
  const controller = new AbortController();
  const socket = await connect(controller.signal);
  native.sockets[0]?.emit("data", new TextEncoder().encode("250 accepted\r\n"));
  native.sockets[0]?.emit("end");
  expect(new TextDecoder().decode(await socket.read())).toBe("250 accepted\r\n");
  await expect(socket.read()).rejects.toThrow("closed");
  socket.close();
});

it("rejects bytes injected between STARTTLS and secureConnect", async () => {
  native.delayTLS = true;
  const controller = new AbortController();
  const socket = await connect(controller.signal, false);
  const upgrade = socket.startTLS();
  native.sockets[1]?.emit("data", new TextEncoder().encode("* OK injected\r\n"));
  await expect(upgrade).rejects.toThrow();
  native.sockets[1]?.emit("secureConnect");
  await expect(socket.read()).rejects.toThrow();
  socket.close();
});

it("awaits each bounded native write before queuing the next MIME chunk", async () => {
  native.writeBlocked = true;
  const socket = await connect(new AbortController().signal);
  const data = Uint8Array.from({ length: 130 * 1024 }, (_, index) => index % 256);
  const written = socket.write(data);
  expect(native.writes.map((bytes) => bytes.length)).toEqual([64 * 1024]);
  native.callbacks.shift()?.();
  await vi.waitFor(() => expect(native.writes).toHaveLength(2));
  expect(native.writes[1]?.length).toBe(64 * 1024);
  native.callbacks.shift()?.();
  await vi.waitFor(() => expect(native.writes).toHaveLength(3));
  native.callbacks.shift()?.();
  await written;
  expect(Buffer.concat(native.writes)).toEqual(Buffer.from(data));
  socket.close();
});

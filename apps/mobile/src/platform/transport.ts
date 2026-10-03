import { MailTransport, type MailSocket } from "@openmail/core/portable";
import { Layer } from "effect";
import TcpSocket from "react-native-tcp-socket";

export const transportLayer = Layer.succeed(MailTransport, {
  connect: ({ host, port, tls, signal }) =>
    new Promise<MailSocket>((resolve, reject) => {
      const chunks: Uint8Array[] = [];
      let queuedBytes = 0;
      let pending: { resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void } | null =
        null;
      let failed: Error | null = null;
      let ready = false;
      let upgrading = false;
      const operations = new Set<(error: Error) => void>();
      let socket: InstanceType<typeof TcpSocket.Socket> | undefined;
      const fail = () => {
        if (failed) return;
        failed = new Error("Mail transport closed");
        clearTimeout(deadline);
        signal.removeEventListener("abort", fail);
        reject(failed);
        pending?.reject(failed);
        pending = null;
        for (const rejected of operations) rejected(failed);
        operations.clear();
        socket?.destroy();
      };
      const deadline = setTimeout(fail, 30_000);
      const attach = (next: InstanceType<typeof TcpSocket.Socket>) => {
        next.on("data", (data) => {
          if (failed) return;
          if (upgrading || typeof data === "string") {
            fail();
            return;
          }
          const bytes = new Uint8Array(data);
          if (pending) {
            const reader = pending;
            pending = null;
            reader.resolve(bytes);
          } else {
            chunks.push(bytes);
            queuedBytes += bytes.length;
            if (queuedBytes > 26 * 1024 * 1024) fail();
          }
        });
        next.on("error", fail);
        next.on("close", fail);
        next.on("end", fail);
        next.setTimeout(30_000, fail);
      };
      const connected = () => {
        if (failed || ready) return;
        ready = true;
        clearTimeout(deadline);
        resolve({
          read: () => {
            const chunk = chunks.shift();
            if (chunk) {
              queuedBytes -= chunk.length;
              return Promise.resolve(chunk);
            }
            if (failed) return Promise.reject(failed);
            if (pending) return Promise.reject(new Error("Concurrent mail reads"));
            return new Promise((resolveRead, rejectRead) => {
              pending = { resolve: resolveRead, reject: rejectRead };
            });
          },
          write: async (bytes) => {
            for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
              const chunk = bytes.subarray(offset, Math.min(offset + 64 * 1024, bytes.length));
              await new Promise<void>((written, rejected) => {
                if (failed) {
                  rejected(failed);
                  return;
                }
                const rejectWrite = (error: Error) => {
                  operations.delete(rejectWrite);
                  rejected(error);
                };
                operations.add(rejectWrite);
                if (!socket) {
                  rejectWrite(new Error("Missing socket"));
                  return;
                }
                socket.write(chunk, undefined, (error) => {
                  operations.delete(rejectWrite);
                  if (error) rejectWrite(new Error("Mail write failed"));
                  else written();
                });
              });
            }
          },
          startTLS: () =>
            new Promise<void>((secure, rejected) => {
              if (failed || !socket || chunks.length || pending) {
                rejected(new Error("Invalid TLS upgrade"));
                return;
              }
              upgrading = true;
              // Transfer listeners before the TLS wrapper resumes native data delivery.
              const previous = socket;
              previous.removeAllListeners("data");
              previous.removeAllListeners("close");
              previous.removeAllListeners("end");
              previous.setTimeout(0);
              const upgraded = new TcpSocket.TLSSocket(previous);
              socket = upgraded;
              attach(upgraded);
              const rejectUpgrade = (error: Error) => {
                clearTimeout(timeout);
                operations.delete(rejectUpgrade);
                rejected(error);
              };
              const timeout = setTimeout(fail, 30_000);
              operations.add(rejectUpgrade);
              upgraded.once("secureConnect", () => {
                if (failed) return;
                upgrading = false;
                clearTimeout(timeout);
                operations.delete(rejectUpgrade);
                secure();
              });
            }),
          close: () => {
            fail();
            chunks.length = 0;
            queuedBytes = 0;
          },
        });
      };
      try {
        socket = tls
          ? TcpSocket.connectTLS({ host, port, connectTimeout: 20_000 }, connected)
          : TcpSocket.createConnection({ host, port, connectTimeout: 20_000 }, connected);
        attach(socket);
        signal.addEventListener("abort", fail, { once: true });
        if (signal.aborted) fail();
      } catch {
        fail();
      }
    }),
});

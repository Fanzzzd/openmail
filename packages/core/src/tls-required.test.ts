import { createServer } from "node:net";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import type { ImapSettings } from "./domain.js";
import { openImap, smtpTransport } from "./platform/node/imap/session.js";

for (const protocol of ["imap", "smtp"] as const) {
  it.effect(
    `${protocol} refuses authentication when STARTTLS is unavailable`,
    () =>
      Effect.gen(function* () {
        const commands: string[] = [];
        const sockets = new Set<import("node:net").Socket>();
        const server = yield* Effect.acquireRelease(
          Effect.promise(async () => {
            const server = createServer((socket) => {
              sockets.add(socket);
              socket.on("close", () => sockets.delete(socket));
              socket.write(
                protocol === "imap" ? "* OK test IMAP ready\r\n" : "220 test SMTP ready\r\n",
              );
              let pending = "";
              socket.on("data", (data) => {
                pending += data.toString();
                let end: number;
                while ((end = pending.indexOf("\r\n")) >= 0) {
                  const line = pending.slice(0, end);
                  pending = pending.slice(end + 2);
                  commands.push(line);
                  if (protocol === "imap") {
                    const tag = line.split(" ")[0];
                    if (/ CAPABILITY$/i.test(line))
                      socket.write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n${tag} OK capability\r\n`);
                    else if (/ LOGOUT$/i.test(line)) socket.end(`* BYE\r\n${tag} OK logout\r\n`);
                    else socket.write(`${tag} BAD unavailable\r\n`);
                  } else if (line.startsWith("EHLO"))
                    socket.write("250-test\r\n250 AUTH PLAIN LOGIN\r\n");
                  else if (line === "STARTTLS") socket.write("454 TLS unavailable\r\n");
                  else if (line === "QUIT") socket.end("221 bye\r\n");
                  else socket.write("500 unavailable\r\n");
                }
              });
            });
            await new Promise<void>((resolve) => {
              server.listen(0, "127.0.0.1", resolve);
            });
            return server;
          }),
          (server) =>
            Effect.promise(() => {
              for (const socket of sockets) socket.destroy();
              return new Promise<void>((resolve) => {
                server.close(() => resolve());
              });
            }),
        );
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const settings: ImapSettings = {
          preset: "custom",
          imapHost: "127.0.0.1",
          imapPort: address.port,
          smtpHost: "127.0.0.1",
          smtpPort: address.port,
          smtpSecure: false,
          username: "test@example.com",
        };
        const result =
          protocol === "imap"
            ? yield* openImap("test", settings, "never-send-this").pipe(
                Effect.scoped,
                Effect.result,
              )
            : yield* smtpTransport("test", settings, "never-send-this").pipe(
                Effect.flatMap((transport) => Effect.tryPromise(() => transport.verify())),
                Effect.scoped,
                Effect.result,
              );
        assert.strictEqual(result._tag, "Failure");
        assert.ok(
          !commands.some((line) => /(?:^|\s)(AUTH|AUTHENTICATE|LOGIN)(?:\s|$)/i.test(line)),
          commands.join("\n"),
        );
        assert.ok(!commands.some((line) => line.includes("never-send-this")));
        if (protocol === "imap" && result._tag === "Failure")
          assert.ok(result.failure.message.includes("TLS is required before authentication"));
      }).pipe(Effect.scoped),
    10_000,
  );
}

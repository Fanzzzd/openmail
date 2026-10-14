import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import path from "node:path";
import { Mailbox } from "@openmail/core";
import type { IncomingMessage, Prefs } from "@openmail/core/schema";
import { fakeServer, TemporaryTestMailbox } from "@openmail/core/testing/node";
import { Effect, Fiber, Layer, ManagedRuntime } from "effect";
import { desktopRoot } from "../../../renderer/src/test-support/paths";
import { createSessions, type GateConfig } from "../remote-auth";
import { createConnectionHub, remoteRpcServer } from "../remote-rpc-server";
import { startRemoteServer } from "../remote-server";

/**
 * Test support: the built web app (`pnpm build` first) with fake mail, served
 * by the real remote server behind a stand-in for Tailscale Serve, and opened
 * in Electron's Chromium as a hidden browser. No OpenMail profile is touched.
 */
export const webRoot = path.join(desktopRoot, "out/web");
const HOST = "mac.tail1234.ts.net";
const LOGIN = "owner@github";

export const fakeMessage = (
  id: string,
  subject: string,
  from: string,
  minutes: number,
  extra: Partial<IncomingMessage> = {},
) =>
  ({
    providerId: id,
    threadId: `t-${id}`,
    subject,
    from: { name: from, address: `${from.toLowerCase().replace(/\W+/g, ".")}@example.com` },
    to: [{ name: "Me", address: "me@gmail.com" }],
    cc: [],
    date: Date.now() - minutes * 60_000,
    snippet: `${subject}: a short preview of the message text.`,
    bodyText: `Hi,\n\n${subject}. This message came from the Mac over the tailnet.\n\nThanks`,
    bodyHtml: "",
    labels: ["INBOX", "UNREAD"],
    attachments: [],
    isUnread: minutes < 90,
    isStarred: minutes === 45,
    ...extra,
  }) satisfies IncomingMessage;

/** Serves the web app with `messages` in a synced fake Gmail account. */
export async function serveWebApp(messages: IncomingMessage[], prefs: Partial<Prefs> = {}) {
  const runtime = ManagedRuntime.make(
    TemporaryTestMailbox({ gmail: fakeServer("me@gmail.com", messages) }),
  );
  const m = await runtime.runPromise(Mailbox);
  await runtime.runPromise(m.connect({ provider: "gmail" }));
  await runtime.runPromise(
    m.setPrefs({ language: "en", defaultProfilesPrompted: true, remoteImages: "ask", ...prefs }),
  );
  await runtime.runPromise(m.sync());

  const gate: GateConfig = { allowlist: [LOGIN], host: HOST, port: 8443 };
  const hub = createConnectionHub();
  const rpc = Effect.runFork(
    Layer.launch(remoteRpcServer(hub)).pipe(Effect.provideService(Mailbox, m)),
  );
  const local = await startRemoteServer({
    webRoot,
    port: 0,
    gate: () => gate,
    sessions: createSessions(),
    attachment: () => Promise.reject(new Error("none")),
    provider: async () => "gmail",
    onConnection: hub.onConnection,
  });

  // Stand-in for Tailscale Serve: adds the identity header and the tailnet
  // Host and Origin, the way a browser at https://HOST:8443 would arrive.
  const rewrite = (
    headers: Record<string, string | string[] | undefined>,
    login: string = LOGIN,
  ) => {
    const next: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(headers))
      if (value !== undefined && !key.startsWith("tailscale-")) next[key] = value;
    next.host = `${HOST}:8443`;
    if (next.origin) next.origin = `https://${HOST}:8443`;
    next["tailscale-user-login"] = login;
    next["tailscale-user-name"] = "Owner";
    return next;
  };
  // Test controls the page can call, as a phone would see its network:
  // /__test/drop cuts every socket, /__test/block makes the Mac unreachable
  // until /__test/unblock. Paths under /__intruder/ arrive as a login the
  // allowlist doesn't name.
  const sockets = new Set<Duplex>();
  let blocked = false;
  const control: Record<string, () => void> = {
    "/__test/drop": () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
    "/__test/block": () => {
      blocked = true;
    },
    "/__test/unblock": () => {
      blocked = false;
    },
  };
  const INTRUDER = "/__intruder";
  const serve = createServer((req, res) => {
    const action = control[req.url ?? ""];
    if (action) {
      action();
      res.writeHead(204, { "cache-control": "no-store" }).end();
      return;
    }
    if (blocked) {
      res.writeHead(502).end();
      return;
    }
    const intruder = req.url?.startsWith(`${INTRUDER}/`) ?? false;
    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port: local.port,
        path: intruder ? req.url?.slice(INTRUDER.length) : req.url,
        method: req.method,
        headers: rewrite(req.headers, intruder ? "intruder@github" : LOGIN),
      },
      (reply) => {
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(res);
      },
    );
    req.pipe(upstream);
  });
  serve.on("upgrade", (req, socket: Duplex, head) => {
    if (blocked) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    const upstream = connect(local.port, "127.0.0.1", () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [key, value] of Object.entries(rewrite(req.headers)))
        for (const item of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${item}`);
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    // A cut connection ends on both sides, as a dropped phone link would.
    socket.once("close", () => upstream.destroy());
    upstream.once("close", () => socket.destroy());
  });
  await new Promise<void>((resolve) => {
    serve.listen(0, "127.0.0.1", resolve);
  });
  const address = serve.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/`,
    setPrefs: (patch: Partial<Prefs>) => runtime.runPromise(m.setPrefs(patch)),
    close: async () => {
      serve.close();
      await local.close();
      await Effect.runPromise(Fiber.interrupt(rpc));
      await runtime.dispose();
    },
  };
}

/** Electron as a plain browser: none of the test runner's Node options. */
const electronEnv = () => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !/^(NODE_|VITEST|ELECTRON_RUN_AS_NODE)/.test(key)) env[key] = value;
  return env;
};

/** Runs `script` in Electron with a scratch profile under `work`; resolves to its exit code. */
export function runElectron(script: string, args: string[], work: string) {
  // The electron package resolves to the path of its binary.
  const electron = String(createRequire(import.meta.url)("electron"));
  return new Promise<number | null>((resolve) => {
    const child = spawn(
      electron,
      [`--user-data-dir=${path.join(work, "profile")}`, script, ...args],
      { stdio: ["ignore", "inherit", "inherit"], env: electronEnv() },
    );
    child.once("exit", (exit, signal) => {
      if (signal) process.stderr.write(`electron exited with ${signal}\n`);
      resolve(exit);
    });
  });
}

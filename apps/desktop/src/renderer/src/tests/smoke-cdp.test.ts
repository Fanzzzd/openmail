import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { afterEach, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { connectCdp, listTargets } from "../../../../scripts/cdp.mjs";
import { scaledMs } from "../../../../../../packages/core/test-support/test-time.js";

type Frame = { id: number; method: string; params: Record<string, unknown> };
type Fake = { port: number; frames: Frame[]; sockets: ServerSocket[]; url: string };

const servers: Server[] = [];
const connections: Socket[] = [];
afterEach(async () => {
  for (const socket of connections.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => {
      server.close(resolve);
    });
  }
});

/** A DevTools endpoint: /json/list answers `list`, the socket answers frames with `reply`. */
async function fakeCdp(
  options: {
    list?: (respond: (body: string) => void) => void;
    reply?: (frame: Frame, socket: ServerSocket) => void;
    upgrade?: boolean;
  } = {},
): Promise<Fake> {
  const frames: Frame[] = [];
  const sockets: ServerSocket[] = [];
  const wss = new WebSocketServer({ noServer: true });
  const server = createServer((request, response) => {
    if (request.url !== "/json/list") {
      response.writeHead(404).end();
      return;
    }
    const respond = (body: string) => response.end(body);
    if (options.list) options.list(respond);
    else respond(JSON.stringify([{ type: "page", url: "app://index.html", webSocketDebuggerUrl }]));
  });
  server.on("upgrade", (request, socket, head) => {
    // Without an upgrade the client's open never fires.
    if (options.upgrade === false) return;
    wss.handleUpgrade(request, socket, head, (ws) => {
      sockets.push(ws);
      ws.on("message", (data) => {
        const frame: Frame = JSON.parse(Buffer.isBuffer(data) ? data.toString() : "");
        frames.push(frame);
        options.reply?.(frame, ws);
      });
    });
  });
  server.on("connection", (socket) => connections.push(socket));
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const { port } = address;
  const webSocketDebuggerUrl = `ws://127.0.0.1:${port}/devtools/page/1`;
  return { port, frames, sockets, url: webSocketDebuggerUrl };
}

it("lists targets, and returns [] for a non-list answer or a stalled endpoint", async () => {
  const good = await fakeCdp();
  expect(await listTargets(good.port)).toEqual([
    { type: "page", url: "app://index.html", webSocketDebuggerUrl: good.url },
  ]);
  const other = await fakeCdp({ list: (respond) => respond('{"not":"a list"}') });
  expect(await listTargets(other.port)).toEqual([]);
  const stalled = await fakeCdp({ list: () => null });
  const started = Date.now();
  expect(await listTargets(stalled.port, { timeoutMs: 100 })).toEqual([]);
  expect(Date.now() - started).toBeLessThan(scaledMs(2000));
});

it("sends calls, resolves results, rejects CDP errors and forwards events", async () => {
  const fake = await fakeCdp({
    reply: (frame, socket) => {
      if (frame.method === "Fail")
        socket.send(JSON.stringify({ id: frame.id, error: { message: "No such method" } }));
      else if (frame.method === "Runtime.evaluate")
        socket.send(
          JSON.stringify(
            frame.params.expression === "throw 1"
              ? { id: frame.id, result: { exceptionDetails: { text: "Uncaught" } } }
              : { id: frame.id, result: { result: { value: 42 } } },
          ),
        );
      else if (frame.method === "Page.captureScreenshot")
        socket.send(
          JSON.stringify({ id: frame.id, result: { data: Buffer.from("png").toString("base64") } }),
        );
      else {
        socket.send(JSON.stringify({ method: "Log.entryAdded", params: { entry: {} } }));
        socket.send(JSON.stringify({ id: frame.id, result: { ok: frame.method } }));
      }
    },
  });
  const cdp = await connectCdp(fake.url);
  const events: unknown[] = [];
  cdp.onEvent((event) => events.push(event));
  expect(await cdp.send("Log.enable")).toEqual({ ok: "Log.enable" });
  expect(events).toEqual([{ method: "Log.entryAdded", params: { entry: {} } }]);
  await expect(cdp.send("Fail")).rejects.toThrow("No such method");
  expect(await cdp.evaluate("21 * 2")).toBe(42);
  await expect(cdp.evaluate("throw 1")).rejects.toThrow("Smoke UI evaluation failed");
  expect(Buffer.from(await cdp.screenshot()).toString()).toBe("png");
  expect(fake.frames.map((frame) => frame.method)).toEqual([
    "Log.enable",
    "Fail",
    "Runtime.evaluate",
    "Runtime.evaluate",
    "Page.captureScreenshot",
  ]);
  expect(fake.frames.find((frame) => frame.method === "Runtime.evaluate")?.params).toEqual({
    expression: "21 * 2",
    returnByValue: true,
    awaitPromise: true,
  });
  cdp.close();
});

it("rejects a call that gets no reply by its deadline, reading the deadline per call", async () => {
  const fake = await fakeCdp();
  let budget = 50;
  const cdp = await connectCdp(fake.url, { callTimeoutMs: () => budget });
  await expect(cdp.send("Page.reload")).rejects.toThrow("CDP timeout: Page.reload");
  budget = 1;
  await expect(cdp.send("Page.enable")).rejects.toThrow("CDP timeout: Page.enable");
  await expect(cdp.send("Page.enable", {}, { timeoutMs: 20 })).rejects.toThrow("CDP timeout");
  cdp.close();
});

it("rejects pending calls when the socket closes, and later calls at once", async () => {
  const fake = await fakeCdp();
  const cdp = await connectCdp(fake.url, {
    callTimeoutMs: 60_000,
    closeReason: () => "CDP closed (renderer crashed)",
  });
  const first = cdp.send("Runtime.enable");
  const second = cdp.send("Page.enable");
  await expect.poll(() => fake.frames.length).toBe(2);
  fake.sockets[0]?.terminate();
  await expect(first).rejects.toThrow("CDP closed (renderer crashed)");
  await expect(second).rejects.toThrow("CDP closed (renderer crashed)");
  await expect(cdp.send("Log.enable")).rejects.toThrow("CDP closed (renderer crashed)");
});

it("fails the open when nothing listens or the endpoint never upgrades", async () => {
  const closed = await fakeCdp();
  const url = closed.url;
  const server = servers.pop();
  await new Promise((resolve) => {
    server?.close(resolve);
  });
  await expect(connectCdp(url)).rejects.toThrow("CDP connection failed");
  const silent = await fakeCdp({ upgrade: false });
  await expect(connectCdp(silent.url, { connectTimeoutMs: 100 })).rejects.toThrow(
    "CDP connection timeout",
  );
});

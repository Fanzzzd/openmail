import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  type BridgeSocket,
  CONNECT_TIMEOUT_MS,
  probeSession,
  type SessionProbe,
  type WebConnection,
  webSocketBridge,
} from "./web-socket-bridge";

type Listener =
  | (() => void)
  | ((event: { data: unknown }) => void)
  | ((event: { code: number }) => void);

/** A socket the test opens and closes by hand. */
class FakeSocket implements BridgeSocket {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  private handlers: Record<string, Listener[]> = {};
  addEventListener(type: "open" | "message" | "close", listener: Listener) {
    (this.handlers[type] ??= []).push(listener);
  }
  private emit(type: string, event: { data: unknown; code: number }) {
    for (const listener of this.handlers[type] ?? []) listener(event);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.drop(1006);
  }
  open() {
    this.readyState = 1;
    this.emit("open", { data: null, code: 0 });
  }
  receive(data: string) {
    this.emit("message", { data, code: 0 });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.emit("close", { data: null, code });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup(probe?: () => Promise<SessionProbe>) {
  const sockets: FakeSocket[] = [];
  const states: WebConnection[] = [];
  let wake = () => {
    /* set by the bridge */
  };
  const onUpdate = vi.fn();
  const bridge = webSocketBridge("ws://mac/rpc", (state) => states.push(state), {
    create: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    ...(probe ? { probe } : {}),
    wake: (callback) => {
      wake = callback;
    },
    onUpdate,
    delays: [100, 1000],
  });
  const resets = vi.fn();
  bridge.onReset(resets);
  const frames: string[] = [];
  bridge.onFrame((frame) => frames.push(frame));
  const last = () => {
    const socket = sockets.at(-1);
    if (!socket) throw new Error("no socket");
    return socket;
  };
  return { bridge, sockets, states, resets, frames, last, onUpdate, wake: () => wake() };
}

it("reconnects in place after a drop, failing only the requests in flight", async () => {
  const { bridge, sockets, states, resets, frames, last } = setup();
  bridge.send("early");
  last().open();
  expect(last().sent).toEqual(["early"]);
  bridge.send("in flight");
  last().drop();
  expect(states.at(-1)).toBe("lost");
  // The request sent on the dropped socket will get no reply.
  expect(resets).toHaveBeenCalledTimes(1);
  // Sent while down: kept for the next socket, never dropped.
  bridge.send("while down");
  await vi.advanceTimersByTimeAsync(100);
  expect(sockets).toHaveLength(2);
  last().open();
  expect(states.at(-1)).toBe("open");
  expect(last().sent).toEqual(["while down"]);
  last().receive("reply");
  expect(frames).toEqual(["reply"]);
  expect(resets).toHaveBeenCalledTimes(1);
});

it("backs off while the Mac is unreachable, and retries at once when woken", async () => {
  const { sockets, resets, last, wake } = setup();
  last().open();
  last().drop();
  await vi.advanceTimersByTimeAsync(100);
  // A failed attempt carried nothing, so nothing more is reset.
  last().drop();
  expect(resets).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(999);
  expect(sockets).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(sockets).toHaveLength(3);
  last().drop();
  // The page came back to the foreground: no waiting for the backoff.
  wake();
  await vi.advanceTimersByTimeAsync(0);
  expect(sockets).toHaveLength(4);
});

it("gives up on a socket that never opens", async () => {
  const { sockets, states } = setup();
  await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
  expect(sockets[0]?.closed).toBe(true);
  expect(states.at(-1)).toBe("lost");
  await vi.advanceTimersByTimeAsync(100);
  expect(sockets).toHaveLength(2);
});

it("ends on the Mac's session-ended close and fails everything after", async () => {
  const { bridge, sockets, states, resets, last } = setup();
  last().open();
  last().drop(4401);
  expect(states.at(-1)).toBe("ended");
  expect(resets).toHaveBeenCalledTimes(1);
  bridge.send("too late");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(resets).toHaveBeenCalledTimes(2);
  expect(sockets).toHaveLength(1);
});

it("checks the session before reconnecting and notices a new build", async () => {
  let answer: SessionProbe = { status: "ok", build: "a" };
  const { sockets, states, last, onUpdate } = setup(async () => answer);
  await vi.advanceTimersByTimeAsync(0);
  last().open();
  last().drop();
  answer = { status: "offline" };
  await vi.advanceTimersByTimeAsync(100);
  // The Mac didn't answer: no socket, try again later.
  expect(sockets).toHaveLength(1);
  answer = { status: "ok", build: "b" };
  await vi.advanceTimersByTimeAsync(1000);
  expect(sockets).toHaveLength(2);
  expect(onUpdate).toHaveBeenCalledTimes(1);
  last().open();
  last().drop();
  // The session expired while the phone slept: wait for the person.
  answer = { status: "ended" };
  await vi.advanceTimersByTimeAsync(100);
  expect(states.at(-1)).toBe("ended");
  expect(sockets).toHaveLength(2);
});

it("reads the Mac's session answer", async () => {
  const reply =
    (status: number, body = "") =>
    async () =>
      new Response(body || null, { status });
  expect(await probeSession(reply(200, '{"build":"abc"}'))).toEqual({ status: "ok", build: "abc" });
  expect(await probeSession(reply(401))).toEqual({ status: "ended" });
  expect(await probeSession(reply(403))).toEqual({ status: "ended" });
  expect(await probeSession(reply(502))).toEqual({ status: "offline" });
  expect(
    await probeSession(async () => {
      throw new TypeError("network");
    }),
  ).toEqual({ status: "offline" });
});

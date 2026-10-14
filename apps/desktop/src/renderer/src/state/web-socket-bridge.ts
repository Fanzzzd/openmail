import { MAX_RPC_FRAME, type RpcBridge } from "../../../shared/channel";
import { REMOTE_SESSION_PATH } from "../../../shared/remote-access";

/**
 * The web build's link to the Mac. "lost" retries on its own; "ended" means the
 * Mac signed this browser out (Disconnect, the session limit, or the login left
 * the allowlist) and waits for the person.
 */
export type WebConnection = "connecting" | "open" | "lost" | "ended";

const SESSION_ENDED = 4401;
const OPEN = 1;

/** Waits between reconnect attempts; the last one repeats. */
export const RECONNECT_DELAYS_MS = [500, 1000, 2000, 5000, 10_000, 15_000];
/** A socket that has not opened by then counts as a failed attempt. */
export const CONNECT_TIMEOUT_MS = 10_000;

/** The part of a WebSocket the bridge uses; the browser's own WebSocket in the app. */
export interface BridgeSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number }) => void): void;
}

/**
 * What the Mac says before a reconnect. "ok" carries the build it serves;
 * "ended" means the session or login is no longer accepted; "offline" means
 * the Mac could not be reached.
 */
export type SessionProbe = { status: "ok"; build: string } | { status: "ended" | "offline" };

export interface WebSocketBridgeOptions {
  create?: (url: string) => BridgeSocket;
  /** Checks the session (and the build) before each reconnect, and once at start. */
  probe?: () => Promise<SessionProbe>;
  /** Calls `wake` when reconnecting now is worth it: the page became visible, or the device came online. */
  wake?: (wake: () => void) => void;
  /** The Mac now serves a different build than the one this page loaded. */
  onUpdate?: () => void;
  delays?: readonly number[];
  connectTimeoutMs?: number;
}

/** The RPC pipe; `onReset` tells the RPC client to fail the requests in flight. */
export type WebRpcBridge = Required<RpcBridge>;

/**
 * The web build's RPC pipe: JSON frames over one same-origin WebSocket. The
 * session cookie authenticates the upgrade; there is no token in the URL.
 *
 * A dropped socket reconnects in place with backoff, and at once when the page
 * comes back to the foreground or the device goes online. Requests in flight
 * when it dropped fail (`onReset`); frames sent while it is down wait and go
 * out on the next socket. A session the Mac ended fails everything and stops.
 */
export function webSocketBridge(
  url: string,
  onState: (state: WebConnection) => void,
  options: WebSocketBridgeOptions = {},
): WebRpcBridge {
  const create: (url: string) => BridgeSocket =
    options.create ?? ((target) => new WebSocket(target));
  const delays = options.delays ?? RECONNECT_DELAYS_MS;
  const connectTimeout = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const listeners = new Set<(frame: string) => void>();
  const resets = new Set<() => void>();
  const waiting: string[] = [];
  let state: WebConnection = "connecting";
  let socket: BridgeSocket | null = null;
  let attempt = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let probing = false;
  let build: string | undefined;

  const ended = () => state === "ended";
  const connected = () => socket !== null;
  const setState = (next: WebConnection) => {
    state = next;
    onState(next);
  };
  const reset = () => {
    for (const listener of resets) listener();
  };
  const end = () => {
    clearTimeout(retry);
    socket = null;
    waiting.length = 0;
    setState("ended");
    reset();
  };
  const schedule = () => {
    clearTimeout(retry);
    const delay = delays[Math.min(attempt, delays.length - 1)] ?? 1000;
    attempt++;
    retry = setTimeout(() => void reconnect(), delay);
  };

  const open = () => {
    const current = create(url);
    socket = current;
    let opened = false;
    const timeout = setTimeout(() => {
      if (!opened && socket === current) current.close();
    }, connectTimeout);
    current.addEventListener("open", () => {
      if (socket !== current) return;
      opened = true;
      clearTimeout(timeout);
      attempt = 0;
      setState("open");
      for (const frame of waiting.splice(0)) current.send(frame);
    });
    current.addEventListener("message", (event) => {
      if (socket !== current || typeof event.data !== "string") return;
      for (const listener of listeners) listener(event.data);
    });
    current.addEventListener("close", (event) => {
      clearTimeout(timeout);
      if (socket !== current) return;
      socket = null;
      if (event.code === SESSION_ENDED) return end();
      if (state !== "lost") setState("lost");
      // Only an opened socket carried requests; a failed attempt sent nothing.
      if (opened) reset();
      schedule();
    });
  };

  const reconnect = async () => {
    clearTimeout(retry);
    if (ended() || connected() || probing) return;
    if (options.probe) {
      probing = true;
      const result = await options.probe().catch((): SessionProbe => ({ status: "offline" }));
      probing = false;
      // Woken or ended while the probe ran.
      if (ended() || connected()) return;
      if (result.status !== "ok") return result.status === "ended" ? end() : schedule();
      if (build !== undefined && result.build !== build) options.onUpdate?.();
      build ??= result.build;
    }
    open();
  };

  setState("connecting");
  open();
  // The build this page came with, to notice an update after a reconnect.
  const first = options.probe;
  if (first)
    void (async () => {
      const result = await first().catch((): SessionProbe => ({ status: "offline" }));
      if (result.status === "ok") build ??= result.build;
    })();
  options.wake?.(() => {
    if (state !== "lost" || socket) return;
    attempt = 0;
    void reconnect();
  });

  return {
    send: (frame) => {
      if (typeof frame !== "string" || frame.length > MAX_RPC_FRAME) return;
      if (state === "ended") {
        // Nothing will carry it: fail the request rather than leave it waiting.
        queueMicrotask(reset);
        return;
      }
      if (socket?.readyState === OPEN) socket.send(frame);
      else waiting.push(frame);
    },
    onFrame: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onReset: (listener) => {
      resets.add(listener);
      return () => {
        resets.delete(listener);
      };
    },
  };
}

/** wss on the page's own origin; the server only upgrades /rpc. */
export const rpcSocketUrl = (location: Location) =>
  `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/rpc`;

/** Asks the Mac whether this browser's session still holds, and which build it serves. */
export async function probeSession(
  fetcher: typeof fetch = fetch,
  path = REMOTE_SESSION_PATH,
): Promise<SessionProbe> {
  let response: Response;
  try {
    response = await fetcher(path, { cache: "no-store", credentials: "same-origin" });
  } catch {
    return { status: "offline" };
  }
  if (response.status === 401 || response.status === 403) return { status: "ended" };
  if (!response.ok) return { status: "offline" };
  try {
    // IO boundary: the Mac's JSON reply.
    const body = (await response.json()) as { build?: unknown };
    return { status: "ok", build: typeof body.build === "string" ? body.build : "" };
  } catch {
    return { status: "offline" };
  }
}

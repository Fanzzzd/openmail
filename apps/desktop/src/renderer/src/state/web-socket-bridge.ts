import { MAX_RPC_FRAME, type RpcBridge } from "../../../shared/channel";

/** "ended" means the Mac signed this browser out (revoked, or the login was removed). */
export type WebConnection = "connecting" | "open" | "lost" | "ended";

const SESSION_ENDED = 4401;
const CONNECTING = 0;
const OPEN = 1;

/** The part of a WebSocket the bridge uses; the browser's own WebSocket in the app. */
export interface BridgeSocket {
  readonly readyState: number;
  send(data: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number }) => void): void;
}

/**
 * The web build's RPC pipe: JSON frames over one same-origin WebSocket. Frames
 * sent before the socket opens wait for it. The session cookie authenticates
 * the upgrade; there is no token in the URL.
 */
export function webSocketBridge(
  url: string,
  onState: (state: WebConnection) => void,
  create: (url: string) => BridgeSocket = (target) => new WebSocket(target),
): RpcBridge {
  const listeners = new Set<(frame: string) => void>();
  const waiting: string[] = [];
  const socket = create(url);
  onState("connecting");
  socket.addEventListener("open", () => {
    onState("open");
    for (const frame of waiting.splice(0)) socket.send(frame);
  });
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    for (const listener of listeners) listener(event.data);
  });
  socket.addEventListener("close", (event) => {
    onState(event.code === SESSION_ENDED ? "ended" : "lost");
  });
  return {
    send: (frame) => {
      if (typeof frame !== "string" || frame.length > MAX_RPC_FRAME) return;
      if (socket.readyState === OPEN) socket.send(frame);
      else if (socket.readyState === CONNECTING) waiting.push(frame);
    },
    onFrame: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** wss on the page's own origin; the server only upgrades /rpc. */
export const rpcSocketUrl = (location: Location) =>
  `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/rpc`;

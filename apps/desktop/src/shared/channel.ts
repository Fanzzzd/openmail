/**
 * The Electron IPC channel RPC frames travel on. Its own module so the
 * sandboxed preload can import it without pulling in Effect or core.
 */
export const RPC_CHANNEL = "openmail:rpc";
// A 30 MiB attachment batch expands to 40 MiB in base64. Bound the envelope too.
export const MAX_RPC_FRAME = 64 * 1024 * 1024;

/** What the preload exposes as `window.openmailRpc`: a string pipe to the main process. */
export interface RpcBridge {
  send: (frame: string) => void;
  /** Returns an unsubscribe function. */
  onFrame: (listener: (frame: string) => void) => () => void;
}

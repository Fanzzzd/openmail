/**
 * The Electron IPC channel RPC frames travel on. Its own module so the
 * sandboxed preload can import it without pulling in Effect or core.
 */
export const RPC_CHANNEL = "openmail:rpc";

/** What the preload exposes as `window.openmailRpc`: a string pipe to the main process. */
export interface RpcBridge {
  send: (frame: string) => void;
  /** Returns an unsubscribe function. */
  onFrame: (listener: (frame: string) => void) => () => void;
}

import type { RpcBridge } from "../../../shared/channel";

let override: RpcBridge | undefined;

/** The web entry swaps the preload's IPC pipe for a WebSocket before rendering. */
export function setRpcBridge(bridge: RpcBridge) {
  override = bridge;
}

export const rpcBridge = (): RpcBridge => override ?? window.openmailRpc;

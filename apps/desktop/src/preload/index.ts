import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import { MAX_RPC_FRAME, RPC_CHANNEL, type RpcBridge } from "../shared/channel";

// The renderer speaks Effect RPC; the preload only moves its JSON frames.
// Nothing else crosses into the page.
const bridge: RpcBridge = {
  send: (frame) => {
    if (typeof frame === "string" && frame.length <= MAX_RPC_FRAME)
      ipcRenderer.send(RPC_CHANNEL, frame);
  },
  onFrame: (listener) => {
    const handler = (_: IpcRendererEvent, frame: string) => {
      listener(frame);
    };
    ipcRenderer.on(RPC_CHANNEL, handler);
    return () => {
      ipcRenderer.off(RPC_CHANNEL, handler);
    };
  },
};

if (process.isMainFrame) contextBridge.exposeInMainWorld("openmailRpc", bridge);

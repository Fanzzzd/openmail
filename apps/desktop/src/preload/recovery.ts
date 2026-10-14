import { contextBridge, ipcRenderer } from "electron";

import {
  RECOVERY_ANSWER_CHANNEL,
  RECOVERY_PROMPT_CHANNEL,
  type RecoveryBridge,
  type RecoveryPrompt,
} from "../shared/recovery";

// Only the recovery window loads this preload. It reads one prompt and sends one answer.
const bridge: RecoveryBridge = {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- IO boundary: the main process sends the prompt it built.
  prompt: () => ipcRenderer.invoke(RECOVERY_PROMPT_CHANNEL) as Promise<RecoveryPrompt>,
  answer: (index) => {
    if (Number.isInteger(index)) ipcRenderer.send(RECOVERY_ANSWER_CHANNEL, index);
  },
};

if (process.isMainFrame) contextBridge.exposeInMainWorld("openmailRecovery", bridge);

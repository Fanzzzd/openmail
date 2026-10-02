import { fork } from "node:child_process";

import type { InferenceProcessLauncher } from "../runtime.js";
export type { InferenceRequest, InferenceProcess, InferenceProcessLauncher } from "../runtime.js";
export const nodeInferenceProcess: InferenceProcessLauncher = (entry, root) => {
  const child = fork(entry, [root], {
    serialization: "advanced",
    execArgv: ["--max-old-space-size=192"],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  let exited = false;
  const done = new Promise<void>((resolve) => {
    child.once("close", () => {
      exited = true;
      resolve();
    });
  });
  return {
    send: (message) => child.send(message),
    onMessage: (listener) => {
      child.on("message", listener);
      return () => {
        child.off("message", listener);
      };
    },
    onFailure: (listener) => {
      child.on("error", listener);
      child.on("exit", listener);
      return () => {
        child.off("error", listener);
        child.off("exit", listener);
      };
    },
    kill: async () => {
      if (exited) return;
      child.kill();
      const force = setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
      }, 2000);
      try {
        await done;
      } finally {
        clearTimeout(force);
      }
    },
  };
};

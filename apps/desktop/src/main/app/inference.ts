import { utilityProcess } from "electron";
import type { InferenceProcessLauncher } from "@openmail/core";

/** A native decoder/ONNX crash is confined to this utility process. */
export const desktopInferenceProcess: InferenceProcessLauncher = (entry, root) => {
  const child = utilityProcess.fork(entry, [root], {
    serviceName: "OpenMail local inference",
    allowLoadingUnsignedLibraries: process.platform === "darwin",
    stdio: "ignore",
    execArgv: ["--max-old-space-size=192"],
  });
  let exited = false;
  let stopping = false;
  const done = new Promise<void>((resolve) => {
    child.once("exit", () => {
      exited = true;
      resolve();
    });
  });
  child.once("spawn", () => {
    if (stopping) child.kill();
  });
  return {
    send: (message) => child.postMessage(message, []),
    onMessage: (listener) => {
      child.on("message", listener);
      return () => {
        child.off("message", listener);
      };
    },
    onFailure: (listener) => {
      child.on("exit", listener);
      child.on("error", listener);
      return () => {
        child.off("exit", listener);
        child.off("error", listener);
      };
    },
    kill: async () => {
      if (exited) return;
      stopping = true;
      child.kill();
      const force = setTimeout(() => {
        if (!exited && child.pid)
          try {
            process.kill(child.pid, "SIGKILL");
          } catch {
            /* The owned child may have exited before the signal. */
          }
      }, 2000);
      try {
        await done;
      } finally {
        clearTimeout(force);
      }
    },
  };
};

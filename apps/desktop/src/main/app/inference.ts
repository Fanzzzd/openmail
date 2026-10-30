import { utilityProcess } from "electron";
import type { InferenceProcessLauncher, SearchProcessLauncher } from "@openmail/core";

/** A native decoder/ONNX crash is confined to this utility process. */
const desktopChild = (entry: string, root: string, serviceName: string, stopMs: number) => {
  const child = utilityProcess.fork(entry, [root], {
    serviceName,
    allowLoadingUnsignedLibraries: process.platform === "darwin",
    stdio: "ignore",
    execArgv: ["--max-old-space-size=192"],
  });
  let exited = false;
  let stopping = false;
  let closing: Promise<void> | undefined;
  let resolveClosed: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const finish = () => {
    exited = true;
    resolveClosed?.();
  };
  child.once("exit", finish);
  // Keep this listener after the request's onFailure listener is removed. IPC can report an
  // error while cancellation is closing the child. A failed launch with no PID owns no running
  // process; settle shutdown even if Electron emits no spawn/exit pair for that failure.
  child.on("error", () => {
    if (child.pid === undefined) {
      stopping = true;
      finish();
    }
  });
  child.once("spawn", () => {
    if (stopping) child.kill();
  });
  return {
    send: (message: unknown) => child.postMessage(message, []),
    onMessage: (listener: (message: unknown) => void) => {
      child.on("message", listener);
      return () => {
        child.off("message", listener);
      };
    },
    onFailure: (listener: () => void) => {
      child.on("exit", listener);
      child.on("error", listener);
      return () => {
        child.off("exit", listener);
        child.off("error", listener);
      };
    },
    kill: () => {
      stopping = true;
      if (exited) return Promise.resolve();
      if (closing) return closing;
      child.kill();
      const force = setTimeout(() => {
        if (!exited && child.pid)
          try {
            process.kill(child.pid, "SIGKILL");
          } catch {
            /* The owned child may have exited before the signal. */
          }
      }, stopMs);
      closing = done.finally(() => clearTimeout(force));
      return closing;
    },
  };
};

/** Model requests may finish on shutdown; search cancellation stops native SQLite promptly. */
export const desktopInferenceProcess: InferenceProcessLauncher = (entry, root) =>
  desktopChild(entry, root, "OpenMail local inference", 2000);
export const desktopSearchProcess: SearchProcessLauncher = (entry, database) =>
  desktopChild(entry, database, "OpenMail local search", 200);

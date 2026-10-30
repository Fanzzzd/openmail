import { fork } from "node:child_process";
import type { SearchProcessLauncher } from "../search-reader.js";

/** Node CLI/MCP transport. Electron injects utilityProcess instead; RunAsNode is never used. */
export const nodeSearchProcess: SearchProcessLauncher = (entry, database) => {
  const child = fork(entry, [database], {
    serialization: "advanced",
    execArgv: ["--max-old-space-size=256"],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  // An in-flight IPC send can emit an error after cancellation removed the request's listener.
  // The active request has its own failure listener; shutdown errors must not crash the parent.
  child.on("error", () => {
    // Expected if an IPC send races the owned child's exit.
  });
  let exited = false;
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => {
      exited = true;
      resolve();
    });
  });
  return {
    send: (message) => {
      // IPC frames are objects; the child validates them with the request schema.
      child.send(JSON.stringify(message));
    },
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
      if (!exited) child.kill("SIGKILL");
      await closed;
    },
  };
};

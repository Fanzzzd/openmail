import { fork } from "node:child_process";

/** Platform process port: no network, DB or model implementation in the adapter. */
export type InferenceRequest =
  | { kind: "text"; text: string; mode: "query" | "passage" }
  | { kind: "query"; text: string }
  | { kind: "image"; data: Uint8Array };
export interface InferenceProcess {
  send(message: InferenceRequest): void;
  onMessage(listener: (message: unknown) => void): () => void;
  onFailure(listener: () => void): () => void;
  kill(): Promise<void>;
}
export type InferenceProcessLauncher = (entry: string, root: string) => InferenceProcess;
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

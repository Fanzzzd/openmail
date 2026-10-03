import type { ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";

/** One cleanup for normal completion, errors and termination signals. */
export function createSmokeCleanup(options: {
  directory: string;
  child: () => ChildProcess | undefined;
  socket: () => { close(): void } | undefined;
}) {
  let cleaning: Promise<void> | undefined;
  const signals = [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const;
  const handlers = signals.map(([signal, code]) => {
    const handler = () => {
      const exitCode = process.exitCode === undefined ? code : Number(process.exitCode);
      process.exitCode = exitCode;
      void cleanup().then(
        () => process.exit(exitCode),
        () => process.exit(exitCode),
      );
    };
    process.on(signal, handler);
    return { signal, handler };
  });
  async function release() {
    try {
      options.socket()?.close();
    } catch {
      /* A disconnected CDP socket must not prevent cleanup. */
    }
    const child = options.child();
    if (child?.pid) {
      const pid = child.pid;
      const exited = new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once("exit", () => resolve());
      });
      const kill = (signal: "SIGTERM" | "SIGKILL") => {
        try {
          if (process.platform === "win32") child.kill(signal);
          else process.kill(-pid, signal);
        } catch {
          /* The child may already have exited. */
        }
      };
      kill("SIGTERM");
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        exited,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 3000);
        }),
      ]);
      clearTimeout(timer);
      kill("SIGKILL");
      await exited;
    }
    await rm(options.directory, { recursive: true, force: true });
    for (const { signal, handler } of handlers) process.off(signal, handler);
  }
  function cleanup() {
    cleaning ??= release();
    return cleaning;
  }
  return cleanup;
}

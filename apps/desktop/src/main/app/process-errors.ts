import type { EventEmitter } from "node:events";

type Reason = "uncaught-exception" | "unhandled-rejection";
type Log = (event: "runtime-error", data: { readonly reason: Reason }) => unknown;

const INSTALLED = Symbol.for("openmail.processErrorHandlers");
/** One process records at most this many; a fault that repeats in a loop cannot fill the log. */
export const MAX_PROCESS_ERRORS = 20;

/**
 * Records uncaught exceptions and unhandled rejections in the main process. Without these
 * handlers Electron shows a modal dialog with the stack (also in `--mcp` mode, which has no
 * window) and diagnostics keep nothing. The process keeps running: exiting would make every
 * recurring fault an abnormal exit, and three of those put the next start into safe mode.
 * The diagnostics file gets a fixed reason only; the error text goes to stderr, like
 * startup failures.
 */
export function registerProcessErrorHandlers(
  log: Log,
  target: EventEmitter & { [INSTALLED]?: true } = process,
  write: (text: string) => void = (text) => process.stderr.write(text),
) {
  if (target[INSTALLED]) return false;
  target[INSTALLED] = true;
  let recorded = 0;
  const report = (reason: Reason) => (error: unknown) => {
    if (recorded >= MAX_PROCESS_ERRORS) return;
    recorded++;
    // A handler that throws would turn into the crash it is here to prevent.
    try {
      log("runtime-error", { reason });
      write(
        `[${reason}] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
    } catch {
      /* Nothing else can record it. */
    }
  };
  target.on("uncaughtException", report("uncaught-exception"));
  target.on("unhandledRejection", report("unhandled-rejection"));
  return true;
}

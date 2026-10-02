import { execFile } from "node:child_process";
import { Effect } from "effect";

/**
 * Marks a file as downloaded from the internet, so macOS Gatekeeper checks
 * it on first open, as it does for Mail and browsers. Best effort.
 */
export function quarantine(file: string): Effect.Effect<void> {
  if (process.platform !== "darwin") return Effect.void;
  const value = `0083;${Math.floor(Date.now() / 1000).toString(16)};OpenMail;`;
  return Effect.callback<void>((resume) => {
    execFile("xattr", ["-w", "com.apple.quarantine", value, file], () => resume(Effect.void));
  });
}

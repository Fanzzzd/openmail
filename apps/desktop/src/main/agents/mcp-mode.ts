import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { runMcp } from "@openmail/cli/mcp-server";
import { NodeMailbox } from "@openmail/core";
import { Cause, Effect, Logger } from "effect";
import { app } from "electron";

import { desktopInferenceProcess } from "../app/inference";
import { builtInOAuthClients } from "../security/oauth-clients";

/**
 * `OpenMail --mcp [--allow-writes]` from a packaged app: the MCP server on stdio. This is how
 * Claude Code, Codex and the other clients start OpenMail's server without a separate Node.
 *
 * The packaged app keeps Electron's RunAsNode fuse off, so ELECTRON_RUN_AS_NODE can't turn the
 * signed app into a general Node. Instead the app's own entry point serves MCP: the same signed
 * code, node:sqlite and keychain access as the app, and no other script can run under its
 * identity.
 */
export function mcpLaunchArgs(argv: readonly string[]): { allowWrites: boolean } | null {
  return argv.includes("--mcp") ? { allowWrites: argv.includes("--allow-writes") } : null;
}

/** Chromium profile folders of MCP processes, one per process: `OpenMail MCP <pid>`. */
const PROFILE_PREFIX = "OpenMail MCP ";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

/** Removes the profile folders that crashed MCP processes left behind. */
async function pruneProfiles(temp: string) {
  for (const name of await readdir(temp).catch(() => [])) {
    if (!name.startsWith(PROFILE_PREFIX)) continue;
    const pid = Number(name.slice(PROFILE_PREFIX.length));
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && !alive(pid))
      await rm(join(temp, name), { recursive: true, force: true });
  }
}

export function runMcpMode({ allowWrites }: { allowWrites: boolean }): void {
  // No Dock icon, no menu bar, no window: the client owns this process through its stdin.
  if (process.platform === "darwin") app.setActivationPolicy("prohibited");
  app.disableHardwareAcceleration();
  // Chromium's profile goes to a scratch folder of this process: several clients can each run
  // a server, and none shares a profile (and its lock) with another or with the running app.
  const temp = app.getPath("temp");
  const profile = join(temp, `${PROFILE_PREFIX}${process.pid}`);
  app.setPath("userData", profile);
  void (async () => {
    // The inference worker is a utilityProcess, which Electron only forks once it is ready.
    await app.whenReady();
    await pruneProfiles(temp);
    const exit = await Effect.runPromiseExit(
      runMcp(allowWrites).pipe(
        Effect.provide(
          NodeMailbox({
            oauthClients: builtInOAuthClients,
            inferenceProcess: desktopInferenceProcess,
          }),
        ),
        Effect.provideService(Logger.LogToStderr, true),
      ),
    );
    if (exit._tag === "Failure") process.stderr.write(`${Cause.pretty(exit.cause)}\n`);
    await rm(profile, { recursive: true, force: true }).catch(() => null);
    app.exit(exit._tag === "Failure" ? 1 : 0);
  })();
}

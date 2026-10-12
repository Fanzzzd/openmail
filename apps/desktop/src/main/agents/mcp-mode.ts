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

export function runMcpMode({ allowWrites }: { allowWrites: boolean }): void {
  // No Dock icon, no menu bar, no window: the client owns this process through its stdin.
  if (process.platform === "darwin") app.setActivationPolicy("prohibited");
  app.disableHardwareAcceleration();
  // Chromium's profile goes to a scratch folder, apart from the running app's.
  app.setPath("userData", join(app.getPath("temp"), "OpenMail MCP"));
  void (async () => {
    const exit = await Effect.runPromiseExit(
      runMcp(allowWrites).pipe(
        Effect.provide(
          NodeMailbox({
            oauthClients: builtInOAuthClients,
            // Started on the first semantic_search, after Electron is ready.
            inferenceProcess: desktopInferenceProcess,
          }),
        ),
        Effect.provideService(Logger.LogToStderr, true),
      ),
    );
    if (exit._tag === "Failure") process.stderr.write(`${Cause.pretty(exit.cause)}\n`);
    app.exit(exit._tag === "Failure" ? 1 : 0);
  })();
}

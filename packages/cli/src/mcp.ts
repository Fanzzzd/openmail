#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { NodeMailbox } from "@openmail/core";
import { Cause, Effect, Logger, References } from "effect";

import { mcpStartupError, runMcp, splitMcpLogLevel } from "./mcp-server.js";
import { oauthClientsFile } from "./oauth-clients.js";

const { level, rest: args } = splitMcpLogLevel(process.argv.slice(2));
if (args.includes("--help")) {
  process.stdout.write(
    "openmail-mcp [--allow-writes] [--log-level <level>]\nRun MCP over stdio. Default: read tools only. --allow-writes exposes proposals, subject to app AI policy; approval and sending require the app.\nLogs warnings and errors on stderr. --log-level takes all, trace, debug, info, warn, error, fatal or none.\n",
  );
  process.exit(0);
}
if (level === undefined || args.some((arg) => arg !== "--allow-writes")) {
  process.stderr.write("Unknown option. Use openmail-mcp --help.\n");
  process.exit(1);
}
runMcp(args.includes("--allow-writes")).pipe(
  Effect.provide(NodeMailbox({ oauthClientsFile })),
  // stdout carries MCP frames, so a startup defect (a database from a newer OpenMail, a write
  // lock another process kept) goes to stderr like the CLI's, and the process exits 1.
  Effect.catchDefect((defect) =>
    Effect.sync(() => {
      process.stderr.write(`${mcpStartupError(Cause.die(defect), process.env.OPENMAIL_HOME)}\n`);
      process.exitCode = 1;
    }),
  ),
  Effect.provideService(Logger.LogToStderr, true),
  Effect.provideService(References.MinimumLogLevel, level),
  NodeRuntime.runMain,
);

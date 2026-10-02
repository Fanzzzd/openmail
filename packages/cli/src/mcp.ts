#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { NodeRuntime } from "@effect/platform-node";
import { NodeMailbox } from "@openmail/core";
import { Effect, Logger } from "effect";

import { runMcp } from "./mcp-server.js";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  process.stdout.write(
    "openmail-mcp [--allow-writes]\nRun MCP over stdio. Default: read tools only. --allow-writes exposes proposals, subject to app AI policy; approval and sending require the app.\n",
  );
  process.exit(0);
}
if (args.some((arg) => arg !== "--allow-writes")) {
  process.stderr.write("Unknown option. Use openmail-mcp --help.\n");
  process.exit(1);
}
runMcp(args.includes("--allow-writes")).pipe(
  Effect.provide(NodeMailbox()),
  Effect.provideService(Logger.LogToStderr, true),
  NodeRuntime.runMain,
);

#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { NodeRuntime } from "@effect/platform-node";
import { NodeMailbox } from "@openmail/core";
import { Effect, Logger } from "effect";

import { runMcp } from "./mcp-server.js";

runMcp.pipe(
  Effect.provide(NodeMailbox()),
  Effect.provideService(Logger.LogToStderr, true),
  NodeRuntime.runMain,
);

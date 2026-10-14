import { resolve } from "node:path";

import { dataDir, type Mailbox, NodeSystem } from "@openmail/core";
import { ConfigProvider, Effect } from "effect";
import { app } from "electron";

import { type AiClientChange, AiClientError } from "../../shared/ai-clients";
import {
  appLaunch,
  applyChange,
  asClientError,
  clientViews,
  previewChange,
  systemHost,
} from "./ai-clients";

/** The tool calls Settings groups per client. */
const ACTIVITY_ROWS = 200;

/**
 * This app's MCP command. The data folder goes into the entry as OPENMAIL_HOME only when it is
 * not the one `openmail mcp` finds by itself (core's dataDir without OPENMAIL_HOME).
 */
const currentLaunch = Effect.gen(function* () {
  const isolated = app.commandLine.getSwitchValue("user-data-dir");
  const directory = isolated ? resolve(isolated) : yield* dataDir;
  const { OPENMAIL_HOME: _, ...withoutOverride } = process.env;
  const defaultDataDir = yield* dataDir.pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(withoutOverride))),
  );
  return yield* Effect.promise(() =>
    appLaunch({
      packaged: app.isPackaged,
      execPath: process.execPath,
      appPath: app.getAppPath(),
      env: process.env,
      dataDir: directory,
      defaultDataDir,
    }),
  );
}).pipe(Effect.provide(NodeSystem));

/** The launch for a change. Connect needs a launch that will still work tomorrow. */
const launchFor = (change: AiClientChange) =>
  Effect.flatMap(currentLaunch, ({ launch, problem }) =>
    problem && change.action === "connect"
      ? Effect.fail(new AiClientError({ reason: "launchUnavailable", detail: problem }))
      : Effect.succeed(launch),
  );

const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: asClientError });

/** Settings → AI Access: detect AI apps, preview and make the change the person confirmed. */
export const aiClientHandlers = (m: Mailbox["Service"]) => ({
  AiClients: () =>
    Effect.gen(function* () {
      const { launch, problem } = yield* currentLaunch;
      const clients = yield* Effect.promise(() => clientViews(systemHost(), launch));
      const activity = yield* m.proposals.agentActivity(ACTIVITY_ROWS);
      return { launch, launchProblem: problem, clients, activity };
    }),
  PreviewAiClientChange: ({ change }: { change: AiClientChange }) =>
    launchFor(change).pipe(
      Effect.flatMap((launch) => attempt(() => previewChange(systemHost(), change, launch))),
    ),
  ApplyAiClientChange: ({ change, token }: { change: AiClientChange; token: string }) =>
    launchFor(change).pipe(
      Effect.flatMap((launch) => attempt(() => applyChange(systemHost(), change, launch, token))),
    ),
});

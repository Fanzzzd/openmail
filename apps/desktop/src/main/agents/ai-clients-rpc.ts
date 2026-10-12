import { join, resolve } from "node:path";

import type { Mailbox } from "@openmail/core";
import { Effect } from "effect";
import { app } from "electron";

import { type AiClientChange, AiClientError } from "../../shared/ai-clients";
import { appLaunch, applyChange, clientViews, previewChange, systemHost } from "./ai-clients";

/** The tool calls Settings groups per client. */
const ACTIVITY_ROWS = 200;

/**
 * The data folder this app uses, and whether a client must be told about it: the default one is
 * what `openmail mcp` finds by itself, anything else goes into the entry as OPENMAIL_HOME.
 */
function dataFolders() {
  const home = process.env.HOME ?? "";
  const defaultDataDir =
    process.platform === "darwin" ? join(home, "Library", "Application Support", "openmail") : "";
  const isolated = app.commandLine.getSwitchValue("user-data-dir");
  const dataDir = isolated
    ? resolve(isolated)
    : process.env.OPENMAIL_HOME
      ? resolve(process.env.OPENMAIL_HOME)
      : defaultDataDir;
  return { dataDir, defaultDataDir };
}

const launch = () =>
  appLaunch({
    packaged: app.isPackaged,
    execPath: process.execPath,
    appPath: app.getAppPath(),
    env: process.env,
    ...dataFolders(),
  });

const unexpected = (error: unknown) =>
  error instanceof AiClientError
    ? error
    : new AiClientError({
        reason: "writeFailed",
        detail: error instanceof Error ? error.message : String(error),
      });

/** Settings → AI Access: detect AI apps, preview and make the change the person confirmed. */
export const aiClientHandlers = (m: Mailbox["Service"]) => ({
  AiClients: () =>
    Effect.gen(function* () {
      const { launch: current, problem } = yield* Effect.promise(launch);
      const clients = yield* Effect.promise(() => clientViews(systemHost(), current));
      const activity = yield* m.agentActivity(ACTIVITY_ROWS);
      return { launch: current, launchProblem: problem, clients, activity };
    }),
  PreviewAiClientChange: ({ change }: { change: AiClientChange }) =>
    Effect.tryPromise({
      try: async () => {
        const { launch: current, problem } = await launch();
        if (problem && change.action === "connect")
          throw new AiClientError({ reason: "launchUnavailable", detail: problem });
        return previewChange(systemHost(), change, current);
      },
      catch: unexpected,
    }),
  ApplyAiClientChange: ({ change, token }: { change: AiClientChange; token: string }) =>
    Effect.tryPromise({
      try: async () => {
        const { launch: current, problem } = await launch();
        if (problem && change.action === "connect")
          throw new AiClientError({ reason: "launchUnavailable", detail: problem });
        await applyChange(systemHost(), change, current, token);
      },
      catch: unexpected,
    }),
});

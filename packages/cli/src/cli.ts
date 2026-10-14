#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * Mailbox commands run through core as user:cli, with policy and audit. `openmail tool …`
 * and `openmail mcp` run as agents and need per-account AI consent.
 * corpus-check uses the separate offline checker. Sending needs app review.
 */
import { Console, Effect, Layer, Logger } from "effect";
import { Browser, NodeMailbox, openInSystemBrowser } from "@openmail/core";
import { ChildProcessSpawner } from "effect/process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { oauthClientsFile } from "./oauth-clients.js";
import { accountCommands } from "./commands/accounts.js";
import { mailCommands } from "./commands/mail.js";
import { agentCommands } from "./commands/agents.js";

import { toolCommands } from "./commands/tools.js";
import { CliError, Command } from "effect/cli";
import { corpus } from "./commands/corpus.js";
import { Failed, WRITE_MODE_SETTING, fail } from "./commands/common.js";
import { UsageError, withShortUsageErrors } from "./usage.js";
import {
  type Explained,
  explainDefect,
  explainError,
  jsonError,
  stderrText,
} from "./cli-errors.js";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { CLI_VERSION } from "./version.js";

/**
 * The CLI's browser: prints the consent URL on stderr, in case no browser can
 * be launched (SSH, headless), then hands it to the OS opener.
 */
const CliBrowser: Layer.Layer<Browser, never, ChildProcessSpawner.ChildProcessSpawner> =
  Layer.effect(
    Browser,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return Browser.of({
        open: (url) =>
          Console.error(`Opening browser for sign-in:\n${url}`).pipe(
            Effect.andThen(openInSystemBrowser(url)),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
      });
    }),
  );

/** One notice per run, however many keychain items the command reads. */
let toldAboutKeychain = false;
const keychainNotice = Effect.suspend(() => {
  if (toldAboutKeychain) return Effect.void;
  toldAboutKeychain = true;
  return Console.error("Reading credentials from the keychain…");
});

const cliMailbox = NodeMailbox({
  browser: CliBrowser.pipe(Layer.provide(NodeServices.layer)),
  backgroundFlush: false,
  beforeCredentialRead: keychainNotice,
  oauthClientsFile,
});

const mailboxCommands = [...accountCommands, ...mailCommands, ...agentCommands, ...toolCommands];
// The framework's Any interface erases names and inputs, while these derived
// error/service types retain every handler requirement through the array map.
const providedCommands = mailboxCommands.map((command: Command.Command.Any) =>
  Command.provide<
    string,
    unknown,
    Command.Error<(typeof mailboxCommands)[number]>,
    Command.Services<(typeof mailboxCommands)[number]>,
    unknown,
    Layer.Success<typeof cliMailbox>,
    Layer.Error<typeof cliMailbox>,
    Layer.Services<typeof cliMailbox>
  >(command, cliMailbox),
);

const openmail = Command.make("openmail").pipe(
  Command.withDescription(
    "Local-first mail for people and models. Reads come from the local database; `openmail sync` refreshes it.",
  ),
  Command.withSubcommands([corpus, ...providedCommands]),
);

const cliArgs = process.argv.slice(2);
const appOnlyWriteMode =
  cliArgs[0] === "agents" &&
  cliArgs[1] === "write-mode" &&
  cliArgs.slice(2).some((arg) => !arg.startsWith("-"));
/** With --json, a failure also prints `{message, code, hint}` on stdout for scripts. */
const jsonOutput = cliArgs.includes("--json");
const home = process.env.OPENMAIL_HOME;
const report = (explained: Explained) =>
  Effect.gen(function* () {
    if (jsonOutput && !explained.stdoutDone) yield* Console.log(jsonError(explained));
    if (!explained.stderrDone) yield* Console.error(stderrText(explained));
  });

(appOnlyWriteMode
  ? fail(`Changes by AI apps can only be changed in the app, under ${WRITE_MODE_SETTING}.`, {
      code: "app_only",
      hint: `Open OpenMail and change it under ${WRITE_MODE_SETTING}.`,
    })
  : withShortUsageErrors(Command.run(openmail, { version: CLI_VERSION }))
).pipe(
  Effect.catch((error) => {
    const explained = explainError(error, home);
    // Usage errors keep their own exit code, 2; every other failure exits 1.
    const exit: Effect.Effect<never, unknown> =
      error instanceof UsageError || CliError.isCliError(error)
        ? Effect.fail(error)
        : Effect.fail(new Failed({ message: explained.message }));
    return Effect.andThen(report(explained), exit);
  }),
  // A defect (a database from a newer OpenMail, a file another process keeps locked) also
  // gets one line on stderr. runMain would log it to stdout, where scripts never look.
  Effect.catchDefect((defect) => {
    const explained = explainDefect(defect, home);
    return report(explained).pipe(
      Effect.andThen(Effect.fail(new Failed({ message: explained.message }))),
    );
  }),
  Effect.provide(NodeServices.layer),
  Effect.provideService(Logger.LogToStderr, true),
  NodeRuntime.runMain,
);

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
import { Failed, fail } from "./commands/common.js";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";

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

/** Turns Mailbox errors into one line on stderr. CLI parse errors are already printed. */
function explain(error: unknown): string | undefined {
  if (CliError.isCliError(error) || !(error instanceof Error)) return undefined;
  if (!("_tag" in error)) return error.message;
  switch (error._tag) {
    case "NotFound":
      return "what" in error && "id" in error
        ? `No ${String(error.what)} with id ${String(error.id)}.`
        : error.message;
    case "ClientNotConfigured":
      return "No OAuth client is set up for this provider. Run `openmail config google` or `openmail config microsoft` (see docs/setup-*.md).";
    case "AuthError":
      return `Sign-in failed: ${error.message}`;
    case "ProviderError":
      return `The mail provider did not answer: ${error.message}`;
    case "QuitError":
      return "Cancelled.";
    default:
      return error.message;
  }
}

const cliArgs = process.argv.slice(2);
const appOnlyWriteMode =
  cliArgs[0] === "agents" &&
  cliArgs[1] === "write-mode" &&
  cliArgs.slice(2).some((arg) => !arg.startsWith("-"));
(appOnlyWriteMode
  ? fail("Agent write mode can only be changed in the app under Settings > AI Access.")
  : Command.run(openmail, { version: "0.1.0" })
).pipe(
  Effect.catch((error) => {
    const message = explain(error);
    return message === undefined
      ? Effect.fail(error)
      : Console.error(`error: ${message}`).pipe(
          Effect.andThen(Effect.fail(new Failed({ message }))),
        );
  }),
  // A defect (a database from a newer OpenMail, a file another process keeps locked) also
  // gets one line on stderr. runMain would log it to stdout, where scripts never look.
  Effect.catchDefect((defect) => {
    const message = defect instanceof Error ? defect.message : String(defect);
    return Console.error(`error: ${message}`).pipe(
      Effect.andThen(Effect.fail(new Failed({ message }))),
    );
  }),
  Effect.provide(NodeServices.layer),
  Effect.provideService(Logger.LogToStderr, true),
  NodeRuntime.runMain,
);

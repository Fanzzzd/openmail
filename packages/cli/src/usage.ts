/**
 * Usage errors (a missing argument, an unknown flag or subcommand) print a short message on
 * stderr and exit 2. effect/cli prints the whole help on stdout before the error, so the help
 * text is held back until it is known whether an error follows. Help that --help asks for, or
 * that a bare command group such as `openmail accounts` prints, still goes to stdout.
 */

import { Console, Data, Effect, Runtime } from "effect";
import { CliError, CliOutput } from "effect/cli";

/** A usage error already printed on stderr. */
export class UsageError extends Data.TaggedError("UsageError")<{
  readonly message: string;
  /** "Run `openmail list --help` for details." */
  readonly hint: string;
}> {
  readonly [Runtime.errorExitCode] = 2;
  readonly [Runtime.errorReported] = false;
}

/** `openmail spaces assign [flags] <account-id> <space>` → `openmail spaces assign`. */
const commandPath = (usage: string) => {
  const words = usage.split(" ");
  const end = words.findIndex((word) => word.startsWith("[") || word.startsWith("<"));
  return (end < 0 ? words : words.slice(0, end)).join(" ");
};

export const withShortUsageErrors = <A, E, R>(
  run: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | UsageError, R> =>
  Effect.gen(function* () {
    const formatter = yield* CliOutput.Formatter;
    const base = yield* Console.Console;
    let help: string | undefined;
    let held: string | undefined;
    let usage = "";
    let reported = { message: "Usage error", hint: "Run `openmail --help` for details." };
    const short: CliOutput.Formatter = {
      formatCliError: (error) => formatter.formatCliError(error),
      formatError: (error) => formatter.formatError(error),
      formatVersion: (name, version) => formatter.formatVersion(name, version),
      formatHelpDoc: (doc) => {
        usage = doc.usage;
        help = formatter.formatHelpDoc(doc);
        return help;
      },
      formatErrors: (errors) => {
        held = undefined;
        const path = commandPath(usage);
        reported = {
          message: errors.map((error) => error.message).join("\n") || reported.message,
          hint: `Run \`${path} --help\` for details.`,
        };
        return [
          ...errors.map((error) => `error: ${error.message}`),
          `Usage: ${usage}`,
          `Run \`${path} --help\` for details.`,
        ].join("\n");
      },
    };
    const console: Console.Console = Object.assign(Object.create(base), {
      log: (...args: ReadonlyArray<unknown>) => {
        // Only the help text effect/cli prints on a parse failure is held; --help prints at once.
        if (args.length === 1 && args[0] === help && !explicitHelp) held = help;
        else base.log(...args);
      },
    });
    return yield* run.pipe(
      Effect.provideService(CliOutput.Formatter, short),
      Effect.provideService(Console.Console, console),
      Effect.ensuring(
        Effect.sync(() => {
          if (held !== undefined) base.log(held);
        }),
      ),
      Effect.catchIf(
        (error): error is E & CliError.ShowHelp =>
          CliError.isCliError(error) && error._tag === "ShowHelp",
        () => Effect.fail(new UsageError(reported)),
      ),
    );
  });

const explicitHelp = process.argv.slice(2).some((arg) => arg === "--help" || arg === "-h");

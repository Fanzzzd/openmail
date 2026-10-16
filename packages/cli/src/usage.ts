/**
 * Usage errors (a missing argument, an unknown flag or subcommand) print a short message on
 * stderr and exit 2. effect/cli prints the whole help on stdout before the error, so the help
 * text is held back until it is known whether an error follows. Help that --help asks for, or
 * that a bare command group such as `openmail accounts` prints, still goes to stdout.
 */

import { Console, Data, Effect, Runtime } from "effect";
import { CliError, CliOutput, type Command } from "effect/cli";

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

/** Built-in flags that take the next word as their value. */
const VALUE_FLAGS = new Set(["--log-level", "--completions"]);

/**
 * With --help, effect/cli prints the help of the last command it recognised and exits 0, so
 * `openmail bogus --help` looked like it worked. Finds the first word a command group does not
 * know, the way effect/cli reports it without --help.
 */
export function unknownSubcommand(
  root: Command.Command.Any,
  args: readonly string[],
): { readonly word: string; readonly path: string } | null {
  if (!args.some((arg) => arg === "--help" || arg === "-h")) return null;
  let command = root;
  let path = root.name;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--") return null;
    if (arg.startsWith("-")) {
      if (VALUE_FLAGS.has(arg)) i++;
      continue;
    }
    const subcommands = command.subcommands.flatMap((group) => group.commands);
    // A command without subcommands takes positional arguments from here on.
    if (subcommands.length === 0) return null;
    const next = subcommands.find((sub) => sub.name === arg || sub.alias === arg);
    if (!next) return { word: arg, path };
    command = next;
    path = `${path} ${next.name}`;
  }
  return null;
}

export const withShortUsageErrors = <A, E, R>(
  run: Effect.Effect<A, E, R>,
  root?: Command.Command.Any,
): Effect.Effect<A, E | UsageError, R> =>
  Effect.gen(function* () {
    const formatter = yield* CliOutput.Formatter;
    const base = yield* Console.Console;
    const unknown = root ? unknownSubcommand(root, process.argv.slice(2)) : null;
    if (unknown) {
      const hint = `Run \`${unknown.path} --help\` for details.`;
      const message = `Unknown subcommand "${unknown.word}" for "${unknown.path}"`;
      base.error(
        [`error: ${message}`, `Usage: ${unknown.path} <subcommand> [flags]`, hint].join("\n"),
      );
      return yield* Effect.fail(new UsageError({ message, hint }));
    }
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

/** The values effect/cli's built-in --log-level takes. */
const LOG_LEVELS = ["all", "trace", "debug", "info", "warn", "warning", "error", "fatal", "none"];

/**
 * effect/cli matches --log-level values case-sensitively and reports a bad one as a logged
 * stack trace with exit 1. This lowercases the value, so `--log-level=Warn` works, and turns
 * a value that is no level into a usage error: `error:` and the usage on stderr, exit 2.
 */
export const withLogLevelChecked = (
  args: readonly string[],
): Effect.Effect<readonly string[], UsageError> =>
  Effect.gen(function* () {
    const out = [...args];
    for (let i = 0; i < out.length; i++) {
      const arg = out[i] ?? "";
      if (arg === "--") break;
      const inline = arg.startsWith("--log-level=");
      if (arg !== "--log-level" && !inline) continue;
      const value = inline ? arg.slice("--log-level=".length) : out[i + 1];
      const level = value?.toLowerCase();
      if (level === undefined || !LOG_LEVELS.includes(level)) {
        const message =
          value === undefined
            ? "Flag --log-level needs a value."
            : `Invalid value for flag --log-level: "${value}". Expected one of ${LOG_LEVELS.join(", ")}.`;
        const hint = "Run `openmail --help` for details.";
        yield* Console.error(
          [`error: ${message}`, "Usage: openmail <command> [flags] --log-level <level>", hint].join(
            "\n",
          ),
        );
        return yield* Effect.fail(new UsageError({ message, hint }));
      }
      if (inline) out[i] = `--log-level=${level}`;
      else out[++i] = level;
    }
    return out;
  });

const explicitHelp = process.argv.slice(2).some((arg) => arg === "--help" || arg === "-h");

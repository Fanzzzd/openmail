/** How the CLI reports a failure: one line on stderr, and with --json an object on stdout. */

import { CliError } from "effect/cli";
import { dataFolderError } from "./data-folder-error.js";

/** What `--json` prints on stdout for a failure, like an MCP tool error. */
export interface ErrorReport {
  readonly message: string;
  readonly code: string;
  readonly hint: string;
}

/** The report, and what is already printed: the usage text on stderr, the answer on stdout. */
export interface Explained extends ErrorReport {
  /** Printed on stderr after the message as `hint: …`. */
  readonly showHint: boolean;
  readonly stderrDone: boolean;
  readonly stdoutDone: boolean;
}

const HELP_HINT = "Run `openmail --help` for the commands and flags.";
const NOT_FOUND_HINTS: Partial<Record<string, string>> = {
  message: "`openmail list` and `openmail search` print message ids.",
  thread: "`openmail list` and `openmail search` print message ids.",
  account: "Run `openmail accounts list` to see them.",
  proposal: "Run `openmail proposals` to see the pending ones.",
  space: "Run `openmail spaces list` to see them.",
  profile: "Run `openmail spaces list` to see them.",
};

const field = (error: object, key: string): string | undefined => {
  const value: unknown = key in error ? Reflect.get(error, key) : undefined;
  return typeof value === "string" ? value : undefined;
};

const plain = (message: string, code: string, hint: string): Explained => ({
  message,
  code,
  hint,
  showHint: false,
  stderrDone: false,
  stdoutDone: false,
});

/** The report for a failure. A usage error is already on stderr; the report says so. */
export function explainError(error: unknown, home: string | undefined): Explained {
  if (CliError.isCliError(error))
    return { ...plain(error.message, "usage", HELP_HINT), stderrDone: true };
  if (!(error instanceof Error)) {
    const message =
      typeof error === "object" && error !== null ? field(error, "message") : undefined;
    return plain(message ?? String(error), "failed", HELP_HINT);
  }
  const tag = field(error, "_tag");
  if (tag === undefined) return plain(error.message, "failed", HELP_HINT);
  const folder = dataFolderError(error, home);
  if (folder)
    return plain(folder, "data_folder", "Set OPENMAIL_HOME to a folder you can write to.");
  switch (tag) {
    case "Failed": {
      const hint = field(error, "hint");
      return {
        message: error.message,
        code: field(error, "code") ?? "failed",
        hint: hint ?? HELP_HINT,
        showHint: hint !== undefined,
        stderrDone: false,
        stdoutDone: "printed" in error && error.printed === true,
      };
    }
    case "UsageError":
      return {
        ...plain(error.message, "usage", field(error, "hint") ?? HELP_HINT),
        stderrDone: true,
      };
    case "NotFound": {
      const what = field(error, "what");
      const id = field(error, "id");
      return plain(
        what !== undefined && id !== undefined ? `No ${what} with id ${id}.` : error.message,
        "not_found",
        (what && NOT_FOUND_HINTS[what]) ?? "Check the id.",
      );
    }
    case "ClientNotConfigured":
      return plain(
        "No OAuth client is set up for this provider. Run `openmail config google` or `openmail config microsoft` (see docs/setup-*.md).",
        "not_configured",
        "Run `openmail config google` or `openmail config microsoft`.",
      );
    case "AuthError":
      return plain(
        `Sign-in failed: ${error.message}`,
        "auth_failed",
        "Sign in to the account again in OpenMail.",
      );
    case "ProviderError":
      return plain(
        `The mail provider did not answer: ${error.message}`,
        "provider_unavailable",
        "Check the connection and try again.",
      );
    case "QuitError":
      return plain("Canceled.", "canceled", "Run the command again to retry.");
    case "InvalidInput": {
      // Core's own hint names the next step, so stderr shows it too.
      const hint = field(error, "hint");
      return {
        ...plain(
          error.message,
          "invalid_input",
          hint ?? "Fix the input and run the command again.",
        ),
        showHint: hint !== undefined,
      };
    }
    default:
      return plain(error.message, "failed", HELP_HINT);
  }
}

/** The report for a defect: a database from a newer OpenMail, a file another process locked. */
export function explainDefect(defect: unknown, home: string | undefined): Explained {
  const folder = dataFolderError(defect, home);
  return folder
    ? plain(folder, "data_folder", "Set OPENMAIL_HOME to a folder you can write to.")
    : plain(
        defect instanceof Error ? defect.message : String(defect),
        "internal",
        "Run the command again. If it keeps failing, report it to the OpenMail developers.",
      );
}

/** stderr text for a report: `error: …`, and `hint: …` when the failure named a next step. */
export const stderrText = (report: Explained) =>
  report.showHint ? `error: ${report.message}\nhint: ${report.hint}` : `error: ${report.message}`;

/** The --json error object, with the keys in a fixed order. */
export const jsonError = ({ message, code, hint }: ErrorReport): string =>
  JSON.stringify({ message, code, hint }, null, 2);

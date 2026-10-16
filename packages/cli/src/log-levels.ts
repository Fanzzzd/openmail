import type { LogLevel } from "effect";

/** The values `--log-level` takes in `openmail`, `openmail mcp`, `openmail-mcp` and `OpenMail --mcp`. */
export const LOG_LEVELS: Readonly<Record<string, LogLevel.LogLevel>> = {
  all: "All",
  trace: "Trace",
  debug: "Debug",
  info: "Info",
  warn: "Warn",
  warning: "Warn",
  error: "Error",
  fatal: "Fatal",
  none: "None",
};

export const LOG_LEVEL_NAMES = Object.keys(LOG_LEVELS);

/** A level word in any letter case, or undefined for anything else. */
export const parseLogLevel = (word: string | undefined): LogLevel.LogLevel | undefined => {
  const key = word?.toLowerCase();
  return key !== undefined && Object.hasOwn(LOG_LEVELS, key) ? LOG_LEVELS[key] : undefined;
};

/** Why a `--log-level` value is refused; one text for every entry point. */
export const logLevelProblem = (value: string | undefined) =>
  value === undefined
    ? "Flag --log-level needs a value."
    : `Invalid value for flag --log-level: "${value}". Expected one of ${LOG_LEVEL_NAMES.join(", ")}.`;

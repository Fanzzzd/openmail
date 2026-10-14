import { AgentActivity } from "@openmail/core/schema";
import { Schema } from "effect";

/** AI apps that OpenMail can connect to its MCP server. */
export const AI_CLIENT_IDS = ["claude-code", "codex", "claude-desktop", "cursor"] as const;
export const AiClientId = Schema.Literals(AI_CLIENT_IDS);
export type AiClientId = typeof AiClientId.Type;

/** How a client starts the MCP server: a command, its arguments and extra environment. */
export const McpLaunch = Schema.Struct({
  command: Schema.String,
  args: Schema.Array(Schema.String),
  env: Schema.Record(Schema.String, Schema.String),
});
export type McpLaunch = typeof McpLaunch.Type;

const clientFields = {
  id: AiClientId,
  installed: Schema.Boolean,
  /**
   * How Connect works: `cli` runs the client's own `mcp` command, `file` edits its config file,
   * `manual` means the person copies the command (the client has no CLI OpenMail found).
   */
  method: Schema.Literals(["cli", "file", "manual"]),
  cliPath: Schema.NullOr(Schema.String),
  configPath: Schema.String,
  /** What the person runs or pastes to connect by hand. */
  manual: Schema.String,
};

const configured = {
  /** The configured `openmail` entry; null when it has no command (an HTTP server, say). */
  entry: Schema.NullOr(McpLaunch),
  /** The entry passes --allow-writes, so the client sees the proposal tools. */
  proposalTools: Schema.Boolean,
};

export const AiClientView = Schema.Union([
  /** No `openmail` entry in the client's config. */
  Schema.Struct({ ...clientFields, state: Schema.Literal("notConnected") }),
  /** The entry starts this app's MCP server. */
  Schema.Struct({ ...clientFields, ...configured, state: Schema.Literal("connected") }),
  /**
   * The entry starts something else: another copy of the app, another build, a hand-written
   * command, or a command that no longer exists.
   */
  Schema.Struct({ ...clientFields, ...configured, state: Schema.Literal("stale") }),
  /** The config file exists but does not parse. OpenMail never edits it. */
  Schema.Struct({ ...clientFields, state: Schema.Literal("unreadable"), problem: Schema.String }),
]);
export type AiClientView = typeof AiClientView.Type;

export const AiLaunchProblem = Schema.Literals([
  /** Development build without `pnpm build`: packages/cli/dist/cli.js is missing. */
  "cliNotBuilt",
  /** The app runs from a disk image or a quarantined download, so its path will change. */
  "translocated",
]);
export type AiLaunchProblem = typeof AiLaunchProblem.Type;

export const AiClientsView = Schema.Struct({
  /** The command this app's MCP server runs with, without --allow-writes. */
  launch: McpLaunch,
  launchProblem: Schema.NullOr(AiLaunchProblem),
  clients: Schema.Array(AiClientView),
  /** The last MCP tool calls, newest first. */
  activity: Schema.Array(AgentActivity),
});
export type AiClientsView = typeof AiClientsView.Type;

export const AiClientChange = Schema.Struct({
  client: AiClientId,
  action: Schema.Literals(["connect", "disconnect"]),
  /** Connect with --allow-writes. */
  proposalTools: Schema.Boolean,
});
export type AiClientChange = typeof AiClientChange.Type;

export const DiffLine = Schema.Struct({
  kind: Schema.Literals(["context", "add", "remove", "gap"]),
  text: Schema.String,
});
export type DiffLine = typeof DiffLine.Type;

/** Exactly what Connect or Disconnect will change, shown before anything runs. */
export const AiClientPreview = Schema.Struct({
  change: AiClientChange,
  file: Schema.String,
  /** The client CLI calls, in order, each as argv. Empty for a direct file edit. */
  commands: Schema.Array(Schema.Array(Schema.String)),
  diff: Schema.Array(DiffLine),
  /**
   * OpenMail copies the file next to itself first. Only for its own edits: a CLI edits the file
   * itself, and the file does not always exist yet.
   */
  backup: Schema.Boolean,
  /**
   * A hash of what the change depends on at preview time: the whole file for a file edit, the
   * `openmail` entry for a CLI (Claude Code rewrites the rest of its file all the time). Apply
   * refuses when it changed since.
   */
  token: Schema.String,
});
export type AiClientPreview = typeof AiClientPreview.Type;

export class AiClientError extends Schema.TaggedError<AiClientError>()("AiClientError", {
  reason: Schema.Literals([
    "unreadable",
    "unsupportedLayout",
    "changed",
    "cliFailed",
    "writeFailed",
    "notInstalled",
    "launchUnavailable",
  ]),
  /** The parser or CLI message, shown as is. */
  detail: Schema.String,
}) {}

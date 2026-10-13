/** Domain schemas for commands, actors, outcomes, proposals and the audit log. */

import { Schema } from "effect";
import { MailOp, OutgoingMessage } from "./changes.js";

/**
 * Every change to mail or accounts is one of these values, so the same thing
 * can be checked by policy, parked as a proposal, audited and replayed.
 */
export const Command = Schema.Union([
  /** `threads` holds any message id of each thread; the whole thread changes. */
  Schema.Struct({
    kind: Schema.Literal("modify"),
    threads: Schema.Array(Schema.String),
    op: MailOp,
  }),
  Schema.Struct({
    kind: Schema.Literal("snooze"),
    threads: Schema.Array(Schema.String),
    due: Schema.Finite,
  }),
  Schema.Struct({
    kind: Schema.Literal("send"),
    confirmResend: Schema.optionalKey(Schema.Boolean),
    accountId: Schema.String,
    message: OutgoingMessage,
    /** The saved draft this sends. It is removed locally and on the provider once sent. */
    draftId: Schema.optionalKey(Schema.String),
    /** Archive the thread of `inReplyTo` after sending (send and archive). */
    archive: Schema.optionalKey(Schema.Boolean),
  }),
  /** A message for a person to finish and send from the app. Agents only; it becomes a synced draft. */
  Schema.Struct({
    kind: Schema.Literal("draft"),
    accountId: Schema.String,
    message: OutgoingMessage,
  }),
  Schema.Struct({ kind: Schema.Literal("removeAccount"), accountId: Schema.String }),
]);
export type Command = typeof Command.Type;

/** Who asks for a command. Agents are models acting through MCP, rules or the built-in assistant. */
export const Actor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user"), surface: Schema.Literals(["app", "cli"]) }),
  Schema.Struct({
    kind: Schema.Literal("agent"),
    surface: Schema.Literals(["mcp", "rule", "assistant"]),
    /** MCP client name, rule name or model name; agent policies are keyed by it. */
    name: Schema.String,
    /** Why the agent wants this, shown when a person reviews the proposal. */
    rationale: Schema.optionalKey(Schema.String),
  }),
]);
export type Actor = typeof Actor.Type;

export function actorLabel(actor: Actor): string {
  return actor.kind === "user" ? `user:${actor.surface}` : `agent:${actor.surface}:${actor.name}`;
}

export const FlushResult = Schema.Struct({
  done: Schema.Number,
  failed: Schema.Number,
  /** Accounts that need a new sign-in before their changes can go through. */
  reauth: Schema.Array(Schema.String),
});
export type FlushResult = typeof FlushResult.Type;

/** A durable, one-use organizational undo handle. Empty for IMAP copy operations. */
export const BatchResult = Schema.Struct({ undoId: Schema.String });
export type BatchResult = typeof BatchResult.Type;
export const UNDO_HISTORY_TTL_MS = 24 * 60 * 60 * 1000;
export const UndoHistoryEntry = Schema.Struct({ undoId: Schema.String, createdAt: Schema.Number });
export type UndoHistoryEntry = typeof UndoHistoryEntry.Type;

/** What `perform` did with a command. */
export const Outcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal("applied"), flush: Schema.optionalKey(FlushResult) }),
  Schema.Struct({ status: Schema.Literal("proposed"), proposalId: Schema.Number }),
  Schema.Struct({ status: Schema.Literal("denied"), reason: Schema.String }),
]);
export type Outcome = typeof Outcome.Type;

export const AgentWriteMode = Schema.Literals(["off", "propose", "allow"]);
export type AgentWriteMode = typeof AgentWriteMode.Type;

export const Proposal = Schema.Struct({
  id: Schema.Number,
  createdAt: Schema.Number,
  actor: Actor,
  command: Command,
  status: Schema.Literals(["pending", "approved", "rejected"]),
});
export type Proposal = typeof Proposal.Type;

export const AuditEntry = Schema.Struct({
  at: Schema.Number,
  /** actorLabel(): "user:app", "agent:mcp:claude-code" and so on. */
  actor: Schema.String,
  accountId: Schema.NullOr(Schema.String),
  action: Schema.String,
  detail: Schema.Unknown,
});
export type AuditEntry = typeof AuditEntry.Type;

/** One MCP tool call. Only the tool and its outcome, never parameters or results. */
export const AgentActivity = Schema.Struct({
  at: Schema.Number,
  /** The MCP client's name from its initialize request, such as claude-code. */
  client: Schema.String,
  tool: Schema.String,
  ok: Schema.Boolean,
});
export type AgentActivity = typeof AgentActivity.Type;

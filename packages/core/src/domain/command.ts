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

/** Pending proposals one agent (surface and name) may have. */
export const PENDING_PROPOSAL_LIMIT = 50;
/** Pending agent proposals across every agent, so a client that changes its name stays bounded. */
export const PENDING_PROPOSAL_TOTAL_LIMIT = 200;

/**
 * Text from an agent (its client name, an audit actor) as it may be shown: control, format and
 * line or paragraph separator characters become visible `\u{...}` escapes, so a stored name can
 * neither drive a terminal nor reorder the text around it.
 */
export const printable = (text: string): string =>
  text.replace(
    /[\p{Cc}\p{Cf}\u2028\u2029]/gu,
    (char) => `\\u{${(char.codePointAt(0) ?? 0).toString(16)}}`,
  );

/**
 * Multi-line text from mail (a message body) as a terminal may show it: line breaks and tabs
 * stay, a carriage return becomes a line break, and other control characters, bidi embeddings,
 * overrides and isolates (U+202A-202E, U+2066-2069) and line or paragraph separators become
 * visible `\u{...}` escapes. Other format characters, such as the joiners in emoji, stay.
 */
export const printableLines = (text: string): string =>
  text
    .replace(/\r\n?/g, "\n")
    .replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069\u2028\u2029]/gu, (char) =>
      char === "\n" || char === "\t" ? char : `\\u{${(char.codePointAt(0) ?? 0).toString(16)}}`,
    );

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
  Schema.Struct({
    status: Schema.Literal("applied"),
    flush: Schema.optionalKey(FlushResult),
    /**
     * `keychain-item-left`: the account was removed, but the keychain refused to delete its
     * stored sign-in (locked or denied). The person deletes the item in Keychain Access.
     */
    warning: Schema.optionalKey(Schema.Literal("keychain-item-left")),
  }),
  Schema.Struct({ status: Schema.Literal("proposed"), proposalId: Schema.Number }),
  Schema.Struct({ status: Schema.Literal("denied"), reason: Schema.String }),
]);
export type Outcome = typeof Outcome.Type;

/** What MCP clients may do: nothing, or propose changes for the person to approve. */
export const AgentWriteMode = Schema.Literals(["off", "propose"]);
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

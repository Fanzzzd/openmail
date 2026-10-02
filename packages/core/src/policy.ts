import type { Actor, AgentWriteMode, Command } from "./domain.js";

export type Decision =
  | { readonly status: "applied" }
  | { readonly status: "proposed" }
  | { readonly status: "denied"; readonly reason: string };

/**
 * Who may do what. People may do anything except "perform" a draft (drafts
 * open in the compose window). Agents may read, propose sends and drafts, and
 * modify mail only as their write mode allows. An agent never sends directly
 * and never removes an account; no setting changes that.
 *
 * `mode` gates every MCP proposal. Other agents retain their existing write policy.
 */
export function decide(command: Command, actor: Actor, mode: AgentWriteMode): Decision {
  if (actor.kind === "user") {
    return command.kind === "draft"
      ? { status: "denied", reason: "Drafts open in the compose window; send them from there." }
      : { status: "applied" };
  }
  if (actor.surface === "mcp") {
    switch (command.kind) {
      case "modify":
        if (!["archive", "read", "star", "label"].includes(command.op.kind))
          return { status: "denied", reason: "This operation is not available to MCP agents." };
        break;
      case "snooze":
      case "draft":
        break;
      default:
        return {
          status: "denied",
          reason: "MCP can only propose supported changes and local drafts.",
        };
    }
    if (mode === "off")
      return {
        status: "denied",
        reason: "Enable agent writes in openmail under Settings > AI 权限 to create proposals.",
      };
    return { status: "proposed" };
  }
  if (actor.surface === "rule" && actor.name === "openmail-assistant") {
    return command.kind === "removeAccount"
      ? { status: "denied", reason: "Agents cannot remove accounts." }
      : { status: "proposed" };
  }
  switch (command.kind) {
    case "send":
    case "draft":
      return { status: "proposed" };
    case "removeAccount":
      return { status: "denied", reason: "Agents cannot remove accounts." };
    default:
      if (mode === "allow") return { status: "applied" };
      if (mode === "propose") return { status: "proposed" };
      return {
        status: "denied",
        reason:
          "Changing mail is turned off for agents. The person can turn it on in openmail under Settings > AI 权限.",
      };
  }
}

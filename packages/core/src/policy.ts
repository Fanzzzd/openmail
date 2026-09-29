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
 * `mode` is the agent's write mode; it only matters for agent modify commands.
 */
export function decide(command: Command, actor: Actor, mode: AgentWriteMode): Decision {
  if (actor.kind === "user") {
    return command.kind === "draft"
      ? { status: "denied", reason: "Drafts open in the compose window; send them from there." }
      : { status: "applied" };
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

import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { activityClient, CLIENTS } from "../settings/sections/ai-clients-ui";
import { printable } from "@openmail/core/schema";

/**
 * People-facing names for the ids AI activity records: the MCP client an AI app announces, the
 * surface a change came from, and the MCP tool it called. AI Access names the apps the same way.
 */

/** "claude-code" reads as Claude Code; a client AI Access does not know keeps its own name. */
export function aiClientName(name: string): string {
  const known = activityClient(name);
  return known ? CLIENTS[known].name : printable(name);
}

export const AI_APP = msg({
  context: "change source",
  comment: "An AI app connected to OpenMail, such as Claude Code. Glossary term AI app.",
  message: "AI app",
});
export const COMMAND_LINE = msg({
  context: "change source",
  comment: "The openmail command-line tool.",
  message: "Command line",
});

/** Where a change came from: OpenMail itself, the command line, an AI app or the assistant. */
export function changeSource(
  i18n: I18n,
  actor: { kind: "user" | "agent"; surface: string; name?: string },
): string {
  if (actor.kind === "user") return actor.surface === "cli" ? i18n._(COMMAND_LINE) : "OpenMail";
  if (actor.surface === "mcp") return `${i18n._(AI_APP)} · ${aiClientName(actor.name ?? "")}`;
  // The surface is trusted; the name is what the agent reported, so it is shown beside it.
  const assistant = i18n._(msg`Assistant`);
  return actor.name && actor.name !== "openmail-assistant"
    ? `${assistant} · ${printable(actor.name)}`
    : assistant;
}

const TOOL_NAMES: Record<string, MessageDescriptor> = {
  access_status: msg({ context: "AI tool call", message: "Check access" }),
  list_accounts: msg({ context: "AI tool call", message: "List accounts" }),
  list_profiles: msg({ context: "AI tool call", message: "List spaces" }),
  list_labels: msg({ context: "AI tool call", message: "List labels and folders" }),
  list_threads: msg({ context: "AI tool call", message: "List conversations" }),
  search: msg({ context: "AI tool call", message: "Search mail" }),
  semantic_search: msg({ context: "AI tool call", message: "Search by meaning" }),
  read_thread: msg({ context: "AI tool call", message: "Read a conversation" }),
  sync: msg({ context: "AI tool call", message: "Sync" }),
  list_templates: msg({ context: "AI tool call", message: "List templates" }),
  read_template: msg({ context: "AI tool call", message: "Read a template" }),
  list_signatures: msg({ context: "AI tool call", message: "List signatures" }),
  read_signature: msg({ context: "AI tool call", message: "Read a signature" }),
  suggest_contacts: msg({ context: "AI tool call", message: "Suggest recipients" }),
  list_invites: msg({ context: "AI tool call", message: "Read invitations" }),
  calendar_overlap: msg({ context: "AI tool call", message: "Check calendar overlap" }),
  list_attachments: msg({ context: "AI tool call", message: "List attachments" }),
  attachment_text: msg({ context: "AI tool call", message: "Read attachment text" }),
  list_proposals: msg({ context: "AI tool call", message: "List AI suggestions" }),
  read_proposal: msg({ context: "AI tool call", message: "Read an AI suggestion" }),
  modify_threads: msg({ context: "AI tool call", message: "Suggest changes to conversations" }),
  snooze_threads: msg({ context: "AI tool call", message: "Suggest snoozing conversations" }),
  draft_message: msg({ context: "AI tool call", message: "Suggest a draft" }),
};
export const AI_TOOL_IDS = Object.keys(TOOL_NAMES);

/** modify_threads reads as Suggest changes to conversations; an unknown tool as Its words. */
export function aiToolName(i18n: I18n, tool: string): string {
  const known = Object.hasOwn(TOOL_NAMES, tool) ? TOOL_NAMES[tool] : undefined;
  if (known) return i18n._(known);
  const words = printable(tool).replaceAll("_", " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

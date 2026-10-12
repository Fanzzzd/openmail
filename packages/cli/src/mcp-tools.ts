import { MailToolkit, ReadMailToolkit } from "@openmail/core";
import { Context } from "effect";
import { Tool } from "effect/ai";

export type McpToolName = keyof typeof MailToolkit.tools;

export interface McpToolInfo {
  name: McpToolName;
  /** Offered without `--allow-writes`. */
  default: boolean;
  /** Annotated read-only. `sync` is offered by default but can push queued changes. */
  readOnly: boolean;
}

/**
 * Every tool `openmail mcp` can offer, in registry order: mcp-server.ts serves ReadMailToolkit,
 * or MailToolkit with `--allow-writes`. The docs site lists these.
 */
export const MCP_TOOLS: readonly McpToolInfo[] = Object.values(MailToolkit.tools).map((tool) => ({
  name: tool.name,
  default: Object.hasOwn(ReadMailToolkit.tools, tool.name),
  readOnly: Context.get(tool.annotations, Tool.Readonly),
}));

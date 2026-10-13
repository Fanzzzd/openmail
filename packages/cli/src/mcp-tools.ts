import { MailToolkit, ReadMailToolkit } from "@openmail/core";
import { Context } from "effect";
import { Tool } from "effect/ai";
import { Command } from "effect/cli";

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

/** The first sentence of a tool description: the blurb in `openmail --help`. */
export const firstSentence = (text: string): string => /^.*?[.!?](?=\s|$)/s.exec(text)?.[0] ?? text;

/**
 * The first sentence in the command list, without its full stop like the other blurbs; the
 * full description in `<command> --help`.
 */
export const withToolDescription =
  (description: string) =>
  <const Name extends string, Input, ContextInput, E, R>(
    command: Command.Command<Name, Input, ContextInput, E, R>,
  ) =>
    command.pipe(
      Command.withDescription(description),
      Command.withShortDescription(firstSentence(description).replace(/\.$/, "")),
    );

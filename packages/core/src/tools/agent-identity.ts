/** Who is calling a mail tool: an MCP client, the CLI or the in-app assistant. */

import type { Actor } from "../domain/command.js";
import { Context, Effect, Layer, Option } from "effect";
import { McpSchema } from "effect/ai";

/** Longest MCP client name kept, in code points. */
export const MCP_CLIENT_NAME_MAX = 64;

/**
 * An MCP client's self-reported name as OpenMail stores it: NFC, whitespace runs as one space,
 * no control, format or separator characters, at most MCP_CLIENT_NAME_MAX code points, and
 * "mcp" when nothing is left. Policies, proposals and activity all key on this form.
 */
export const cleanMcpClientName = (name: string): string =>
  Array.from(
    name
      .normalize("NFC")
      .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, (char) => (/\s/u.test(char) ? " " : ""))
      .replace(/\s+/gu, " ")
      .trim(),
  )
    .slice(0, MCP_CLIENT_NAME_MAX)
    .join("")
    .trim() || "mcp";

type AgentSurface = Extract<Actor, { kind: "agent" }>["surface"];

/**
 * Who the model is. Read on every call: one MCP server can serve several
 * clients, and the client name keys the agent's policy and audit entries.
 */
export class AgentIdentity extends Context.Service<
  AgentIdentity,
  {
    readonly current: Effect.Effect<{
      readonly surface: AgentSurface;
      readonly name: string;
      /** The session offers proposal tools: `openmail mcp --allow-writes`. */
      readonly proposalTools?: boolean;
      /** Tool calls go to agent_activity. Only MCP server sessions; CLI commands don't. */
      readonly recordsActivity?: boolean;
    }>;
  }
>()("openmail/AgentIdentity") {
  /**
   * An MCP server session. The name is the client's from its initialize request, or "mcp"
   * when it sent none.
   */
  static mcpSession(options: { readonly proposalTools: boolean }): Layer.Layer<AgentIdentity> {
    return Layer.succeed(AgentIdentity, {
      current: Effect.serviceOption(McpSchema.McpRequestContext).pipe(
        Effect.map((ctx) => ({
          surface: "mcp" as const,
          name: cleanMcpClientName(Option.getOrUndefined(ctx)?.clientInfo?.name ?? "mcp"),
          proposalTools: options.proposalTools,
          recordsActivity: true,
        })),
      ),
    });
  }

  static fixed(
    surface: AgentSurface,
    name: string,
    options: { readonly proposalTools?: boolean; readonly recordsActivity?: boolean } = {},
  ): Layer.Layer<AgentIdentity> {
    return Layer.succeed(AgentIdentity, {
      current: Effect.succeed({ surface, name, ...options }),
    });
  }
}

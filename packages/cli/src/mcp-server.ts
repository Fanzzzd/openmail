import { NodeStdio } from "@effect/platform-node";
import { AgentIdentity, type Mailbox, MailToolkit, MailToolkitLayer } from "@openmail/core";
import { Effect, Layer } from "effect";
import { McpProtocol, McpServer } from "effect/ai";

/**
 * The MCP server on stdio. Tools come from core's MailToolkit; every change a
 * client asks for goes through Mailbox policy as agent:mcp:<client name>.
 * stdout carries protocol frames only, so the entry points send logs to
 * stderr (Logger.LogToStderr).
 */
export const McpLive: Layer.Layer<never, never, Mailbox> = Layer.mergeAll(
  McpServer.toolkit(MailToolkit),
  McpServer.layerStdio({
    name: "openmail",
    version: "0.1.0",
    instructions:
      "openmail reads the person's local mail. Changes (modify_threads) follow the person's AI 权限 setting, which is off by default. draft_message never sends; the person reviews and sends drafts in openmail. Relay each tool's message to the person.",
    protocols: [
      McpProtocol.v2025_11_25,
      McpProtocol.v2025_06_18,
      McpProtocol.v2025_03_26,
      McpProtocol.v2024_11_05,
    ],
  }),
).pipe(
  Layer.provide(MailToolkitLayer),
  Layer.provide(AgentIdentity.mcp),
  Layer.provide(NodeStdio.layer),
  Layer.orDie,
);

/**
 * Serves until the client closes stdin, then exits so no orphan process is
 * left behind. The short grace lets replies to the last requests go out.
 */
export const runMcp: Effect.Effect<void, never, Mailbox> = Effect.raceFirst(
  Layer.launch(McpLive),
  Effect.callback<void>((resume) => {
    const done = () => resume(Effect.void);
    process.stdin.once("end", done);
    return Effect.sync(() => process.stdin.off("end", done));
  }).pipe(Effect.andThen(Effect.sleep("500 millis"))),
);

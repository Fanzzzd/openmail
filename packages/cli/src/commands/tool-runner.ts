/** Runs one core agent tool from the command line, with the same checks and output as MCP. */

import {
  MailToolkit,
  ProposalMailToolkit,
  MailToolkitLayer,
  AgentIdentity,
  MailToolError,
  agentAccountGap,
  unknownArguments,
} from "@openmail/core";
import { Tool } from "effect/ai";
import { Effect, Layer, Option, Schema, Stream } from "effect";
import { Flag } from "effect/cli";
import { fail, print } from "./common.js";

export type ToolName = keyof typeof MailToolkit.tools;
export const toolNames = Object.keys(MailToolkit.tools).filter(
  (name): name is ToolName => name in MailToolkit.tools,
);
export const isWriteTool = (name: ToolName) => name in ProposalMailToolkit.tools;
const toolHandlers = MailToolkitLayer.pipe(
  Layer.provide(AgentIdentity.fixed("mcp", "openmail-cli")),
);
const ToolFailure = Schema.toEncoded(MailToolError);
const gapText = (gap: string) =>
  `${gap}\nhint: Run \`openmail tool access_status\` to see what is readable.`;
/**
 * Runs the tool as MCP does. With --json, stdout gets exactly the object MCP returns, the
 * result or `{message, code, hint}`. Anything only the CLI says goes to stderr: a failure's
 * message and hint, and why a call reads no account. A failure exits 1, and so does a result
 * that is empty because the account is unknown, turned off or lacks AI consent.
 */
/** @internal */
export function invokeTool(name: ToolName, input: unknown, json: boolean) {
  // The top level prints the Failed message on stderr after "error: ".
  const toolFailure = (failure: typeof ToolFailure.Type, gap: string | null) =>
    (json ? print(failure, true) : Effect.void).pipe(
      Effect.andThen(
        fail(gap === null ? `${failure.message}\nhint: ${failure.hint}` : gapText(gap)),
      ),
    );
  return Effect.gen(function* () {
    const unknown = unknownArguments(Tool.getJsonSchema(MailToolkit.tools[name]), input);
    if (unknown) return yield* toolFailure(Schema.encodeSync(MailToolError)(unknown), null);
    const parameters = yield* Schema.decodeUnknownEffect(
      Schema.toEncoded(MailToolkit.tools[name].parametersSchema),
    )(input);
    const gap = yield* agentAccountGap(name, parameters);
    const toolkit = yield* MailToolkit;
    const stream = yield* toolkit.handle(name, parameters);
    const last = yield* Stream.runLast(stream);
    if (Option.isNone(last)) return yield* fail("The tool returned no result.");
    if (last.value.isFailure)
      return yield* toolFailure(
        Option.getOrElse(
          Schema.decodeUnknownOption(ToolFailure)(last.value.encodedResult),
          (): typeof ToolFailure.Type => ({
            message: JSON.stringify(last.value.encodedResult),
            code: "invalid_input",
            hint: "Report this result to the OpenMail developers.",
          }),
        ),
        gap,
      );
    if (gap === null) return last.value.encodedResult;
    yield* print(last.value.encodedResult, json);
    return yield* fail(gapText(gap));
  }).pipe(Effect.provide(toolHandlers));
}
/** @internal */
export function runToolCommand(
  name: ToolName,
  { input, json, allowWrites }: { input: string; json: boolean; allowWrites: boolean },
) {
  return Effect.gen(function* () {
    if (isWriteTool(name) && !allowWrites)
      return yield* fail("Proposal tools require --allow-writes and app AI write permission.");
    const parsed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(input);
    const result = yield* invokeTool(name, parsed, json);
    return yield* print(result, json);
  });
}
export const toolInput = Flag.String("input-json").pipe(
  Flag.withDescription("Tool parameters as a JSON object. Use tools --json for schemas."),
  Flag.withDefault("{}"),
);
export const allowWritesFlag = Flag.Boolean("allow-writes").pipe(
  Flag.withDescription(
    "Permit creating proposals only; app AI write permission required. No approval or send.",
  ),
  Flag.withDefault(false),
);

import { MailToolError, MailToolkit, ReadMailToolkit } from "@openmail/core";
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

/** The parts of a JSON Schema property that `tool <name> --help` prints. */
interface PropertySchema {
  readonly type?: unknown;
  readonly enum?: unknown;
  readonly anyOf?: unknown;
  readonly items?: unknown;
  readonly description?: unknown;
}
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** "string", "integer or string", "array of string", or the enum's values. */
const typeText = (property: PropertySchema): string => {
  if (Array.isArray(property.enum)) return `one of ${property.enum.map(String).join(", ")}`;
  if (Array.isArray(property.anyOf))
    return property.anyOf
      .filter(isObject)
      .map((option) => typeText(option))
      .join(" or ");
  if (property.type === "array" && isObject(property.items))
    return `array of ${typeText(property.items)}`;
  return typeof property.type === "string" ? property.type : "any";
};

/**
 * The tool's parameters from its input schema, one per line, for `openmail tool <name> --help`:
 * name, type, required or optional, and the description the model reads.
 */
export const parameterHelp = (schema: unknown): string => {
  const properties = isObject(schema) && isObject(schema.properties) ? schema.properties : {};
  const required = new Set(
    isObject(schema) && Array.isArray(schema.required) ? schema.required.map(String) : [],
  );
  const names = Object.keys(properties);
  if (!names.length) return "PARAMETERS\n  None. Call it without --input-json.";
  const width = Math.max(...names.map((name) => name.length));
  const lines = names.map((name) => {
    const property: PropertySchema = isObject(properties[name]) ? properties[name] : {};
    const description = typeof property.description === "string" ? ` ${property.description}` : "";
    const need = required.has(name) ? "required" : "optional";
    return `  ${name.padEnd(width)}  ${typeText(property)}, ${need}.${description}`;
  });
  return ["PARAMETERS (as keys of the --input-json object)", ...lines].join("\n");
};

/**
 * Arguments that fail the tool's input schema, as MCP and `openmail tool` both report them:
 * code invalid_input with a hint the model or person can act on.
 */
export const invalidArguments = (tool: string, problem: string): MailToolError =>
  new MailToolError({
    code: "invalid_input",
    message: `The arguments for ${tool} do not match its input schema: ${problem}`,
    hint: "Fix the arguments as described and call the tool again.",
  });

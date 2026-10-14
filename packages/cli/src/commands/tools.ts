/** tools, and tool with one subcommand per agent tool. */

import { MailToolkit, ReadMailToolkit } from "@openmail/core";
import { Effect } from "effect";
import { Tool } from "effect/ai";
import { Command } from "effect/cli";
import { withToolDescription } from "../mcp-tools.js";
import { jsonFlag, print } from "./common.js";
import {
  type ToolName,
  allowWritesFlag,
  isWriteTool,
  toolNames,
  toolInput,
  runToolCommand,
} from "./tool-runner.js";

const tools = Command.make(
  "tools",
  { json: jsonFlag, allowWrites: allowWritesFlag },
  Effect.fn(function* ({ json, allowWrites }) {
    const rows = Object.values(allowWrites ? MailToolkit.tools : ReadMailToolkit.tools).map(
      (tool) => ({
        name: tool.name,
        description: tool.description,
        // As MCP advertises it: unknown keys fail the call.
        inputSchema: { ...Tool.getJsonSchema(tool), additionalProperties: false },
      }),
    );
    yield* print(rows, json, (all) =>
      all.map((row) => `${row.name}: ${row.description}`).join("\n"),
    );
  }),
).pipe(
  Command.withDescription(
    "List agent tools and their exact input schemas. Read tools by default; --allow-writes adds the proposal tools.",
  ),
  Command.withShortDescription("List agent tools and their input schemas"),
);
const toolCommand = (name: ToolName) => {
  const description = MailToolkit.tools[name].description ?? name;
  // Only proposal tools take --allow-writes; read tools never change mail.
  return isWriteTool(name)
    ? Command.make(
        name,
        { input: toolInput, json: jsonFlag, allowWrites: allowWritesFlag },
        (options) => runToolCommand(name, options),
      ).pipe(withToolDescription(description))
    : Command.make(name, { input: toolInput, json: jsonFlag }, (options) =>
        runToolCommand(name, { ...options, allowWrites: false }),
      ).pipe(withToolDescription(description));
};

/** `openmail tool <name>`: one subcommand per agent tool, named as in MCP. */
const tool = Command.make("tool").pipe(
  Command.withDescription(
    "Call an agent tool as an AI app would, with the same consent checks, parameters and results as MCP. Parameters are validated against tools --json; results honor cursors and byte budgets.",
  ),
  Command.withShortDescription("Call an agent tool as an AI app would"),
  Command.withExamples([
    { command: "openmail tool list_templates --json", description: "List template ids" },
    {
      command: `openmail tool read_thread --input-json '{"id":"gmail:me@example.com/m1"}' --json`,
      description: "Read bounded plain-text model context",
    },
  ]),
  Command.withSubcommands(toolNames.map(toolCommand)),
);

/** @internal */
export const toolCommands = [tools, tool] as const;

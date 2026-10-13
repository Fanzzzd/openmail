/** tools, tool and one command per agent tool. */

import { MailToolkit, ReadMailToolkit } from "@openmail/core";
import { Effect } from "effect";
import { Tool } from "effect/ai";
import { Argument, Command } from "effect/cli";
import { withToolDescription } from "../mcp-tools.js";
import { jsonFlag, print } from "./common.js";
import { allowWritesFlag, toolNames, toolInput, runToolCommand } from "./tool-runner.js";

const tools = Command.make(
  "tools",
  { json: jsonFlag, allowWrites: allowWritesFlag },
  Effect.fn(function* ({ json, allowWrites }) {
    const rows = Object.values(allowWrites ? MailToolkit.tools : ReadMailToolkit.tools).map(
      (tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: Tool.getJsonSchema(tool),
      }),
    );
    yield* print(rows, json, (all) =>
      all.map((row) => `${row.name}: ${row.description}`).join("\n"),
    );
  }),
).pipe(
  Command.withDescription("List agent tools and their exact input schemas. Read-only by default."),
);
const tool = Command.make(
  "tool",
  {
    name: Argument.Literals("name", toolNames),
    input: toolInput,
    json: jsonFlag,
    allowWrites: allowWritesFlag,
  },
  ({ name, input, json, allowWrites }) => runToolCommand(name, { input, json, allowWrites }),
).pipe(
  Command.withDescription(
    "Call any agent tool through the shared core Toolkit. Parameters are validated against tools --json; results honor cursors and byte budgets.",
  ),
  Command.withExamples([
    { command: "openmail tool list_templates --json", description: "List template ids" },
    {
      command: `openmail tool read_thread --input-json '{"id":"gmail:me@example.com/m1"}' --json`,
      description: "Read bounded plain-text model context",
    },
  ]),
);

// A named command for each tool keeps --help and the CLI aligned with core descriptions.
const perToolCommands = toolNames
  .filter((name) => name !== "sync" && name !== "search")
  .map((name) =>
    Command.make(
      name.replaceAll("_", "-"),
      { input: toolInput, json: jsonFlag, allowWrites: allowWritesFlag },
      (options) => runToolCommand(name, options),
    ).pipe(withToolDescription(MailToolkit.tools[name].description ?? name)),
  );

/** @internal */
export const toolCommands = [tools, tool, ...perToolCommands] as const;

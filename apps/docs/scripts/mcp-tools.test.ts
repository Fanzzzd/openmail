import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { MCP_TOOLS } from "../../../packages/cli/src/mcp-tools";
import { TOOL_SUMMARIES, withToolTables } from "./mcp-tools";

const page = new URL("../content/docs/cli-and-mcp.mdx", import.meta.url);

test("every MCP tool has a summary and no summary names a removed tool", () => {
  expect(Object.keys(TOOL_SUMMARIES).toSorted()).toEqual(
    MCP_TOOLS.map((tool) => tool.name).toSorted(),
  );
});

test("sync is offered by default and is not read-only", () => {
  expect(MCP_TOOLS.find((tool) => tool.name === "sync")).toMatchObject({
    default: true,
    readOnly: false,
  });
});

test("the CLI and MCP page lists the MCP tool registry", async () => {
  await expect(withToolTables(readFileSync(fileURLToPath(page), "utf8"))).toMatchFileSnapshot(
    "../content/docs/cli-and-mcp.mdx",
  );
});

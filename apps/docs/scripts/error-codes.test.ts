import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { CLI_ERROR_CODES } from "../../../packages/cli/src/error-codes";
import { MCP_ERROR_CODES } from "../../../packages/cli/src/mcp-tools";

const page = readFileSync(
  fileURLToPath(new URL("../content/docs/cli-and-mcp.mdx", import.meta.url)),
  "utf8",
);

// The page said scripts can read every failure the same way but listed only the MCP codes.
test("the CLI and MCP page lists every CLI error code once", () => {
  const start = page.indexOf("{/* cli-error-codes:start */}");
  const end = page.indexOf("{/* cli-error-codes:end */}");
  expect(start).toBeGreaterThan(-1);
  const listed = [...page.slice(start, end).matchAll(/^- `([a-z_]+)`: /gm)].map((m) => m[1]);
  expect(listed).toEqual([...CLI_ERROR_CODES]);
});

test("the CLI and MCP page lists every MCP tool error code", () => {
  const sentence = /A failed call returns `isError`[^\n]*?The codes are ([^.]+)\./.exec(page)?.[1];
  const listed = [...(sentence ?? "").matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
  expect(listed).toHaveLength(MCP_ERROR_CODES.length);
  expect(new Set(listed)).toEqual(new Set(MCP_ERROR_CODES));
});

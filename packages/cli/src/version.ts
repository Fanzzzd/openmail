import { readFileSync } from "node:fs";
import { Schema } from "effect";

/**
 * The version in packages/cli/package.json, the only place it is written. `openmail --version`
 * and the MCP server's serverInfo both use it. The file sits one level above src/ and dist/, and
 * every install ships it (the package exports ./package.json).
 */
export const CLI_VERSION: string = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
)(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

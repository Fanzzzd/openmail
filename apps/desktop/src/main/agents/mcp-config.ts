import { applyEdits, modify } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";

import type { DiffLine, McpLaunch } from "../../shared/ai-clients";

/** The server name in every client's config. */
export const SERVER_NAME = "openmail";

/** Thrown when a config can't be read or edited safely. The message is shown to the person. */
export class ConfigProblem extends Error {
  constructor(
    readonly reason: "unreadable" | "unsupportedLayout",
    message: string,
  ) {
    super(message);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A config entry as a launch, or null when it has no command (an HTTP server, say).
 * Unknown fields are ignored; only the command, string arguments and string env count.
 */
export function launchOf(entry: unknown): McpLaunch | null {
  if (!isRecord(entry) || typeof entry.command !== "string") return null;
  const args = Array.isArray(entry.args)
    ? entry.args.filter((arg): arg is string => typeof arg === "string")
    : [];
  const env: Record<string, string> = {};
  if (isRecord(entry.env))
    for (const [key, value] of Object.entries(entry.env))
      if (typeof value === "string") env[key] = value;
  return { command: entry.command, args, env };
}

// JSON: Claude Code's ~/.claude.json, Claude Desktop and Cursor. All keep servers in `mcpServers`.

function parseJson(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ConfigProblem("unreadable", error instanceof Error ? error.message : String(error));
  }
  if (!isRecord(value)) throw new ConfigProblem("unreadable", "The file is not a JSON object.");
  return value;
}

/** The `mcpServers.openmail` entry, or undefined. Null text is a missing file. */
export function readJsonEntry(text: string | null): unknown {
  if (!text?.trim()) return undefined;
  const servers = parseJson(text).mcpServers;
  if (servers === undefined) return undefined;
  if (!isRecord(servers))
    throw new ConfigProblem("unsupportedLayout", "mcpServers is not a JSON object.");
  return servers[SERVER_NAME];
}

/** Indentation and line ending the file already uses, so an edit looks like the rest. */
function jsonFormat(text: string) {
  const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? "  ";
  return {
    insertSpaces: !indent.startsWith("\t"),
    tabSize: indent.startsWith("\t") ? 1 : indent.length,
    eol: text.includes("\r\n") ? "\r\n" : "\n",
  };
}

/**
 * Sets or removes `mcpServers.openmail` with a minimal text edit: every other key, the key order,
 * the indentation and the rest of the file stay byte for byte.
 */
export function editJson(text: string | null, entry: Record<string, unknown> | undefined): string {
  if (!text?.trim()) {
    if (entry === undefined) return text ?? "";
    return `${JSON.stringify({ mcpServers: { [SERVER_NAME]: entry } }, null, 2)}\n`;
  }
  readJsonEntry(text);
  const edits = modify(text, ["mcpServers", SERVER_NAME], entry, {
    formattingOptions: jsonFormat(text),
  });
  const next = applyEdits(text, edits);
  const check = readJsonEntry(next);
  if (JSON.stringify(check) !== JSON.stringify(entry))
    throw new ConfigProblem("unsupportedLayout", "The edited file did not read back as expected.");
  return next;
}

// TOML: Codex's ~/.codex/config.toml keeps servers in [mcp_servers.<name>] tables.

function parseTomlText(text: string): Record<string, unknown> {
  try {
    return parseToml(text);
  } catch (error) {
    throw new ConfigProblem("unreadable", error instanceof Error ? error.message : String(error));
  }
}

export function readTomlEntry(text: string | null): unknown {
  if (!text?.trim()) return undefined;
  const servers = parseTomlText(text).mcp_servers;
  if (servers === undefined) return undefined;
  if (!isRecord(servers))
    throw new ConfigProblem("unsupportedLayout", "mcp_servers is not a TOML table.");
  return servers[SERVER_NAME];
}

const tomlString = (value: string) => JSON.stringify(value);
const tomlKey = (key: string) => (/^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key));

/** The `[mcp_servers.openmail]` table as Codex's own `codex mcp add` writes it. */
export function tomlBlock(launch: McpLaunch): string[] {
  const lines = [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${tomlString(launch.command)}`,
    `args = [${launch.args.map(tomlString).join(", ")}]`,
  ];
  const env = Object.entries(launch.env);
  if (env.length)
    lines.push(
      `env = { ${env.map(([key, value]) => `${tomlKey(key)} = ${tomlString(value)}`).join(", ")} }`,
    );
  return lines;
}

const OWN_HEADER =
  /^\s*\[\s*mcp_servers\s*\.\s*(?:openmail|"openmail")\s*(?:\.[^\]]*)?\]\s*(?:#.*)?$/;
const ANY_HEADER = /^\s*\[/;

/**
 * Replaces, adds or removes the `[mcp_servers.openmail]` table and its subtables as one block of
 * lines. Everything outside the block, comments included, is left as it was. An entry written
 * another way (an inline table or dotted keys) is refused instead of guessed at.
 */
export function editToml(text: string | null, launch: McpLaunch | undefined): string {
  const source = text ?? "";
  const existing = readTomlEntry(source);
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.length ? source.split(/\r?\n/) : [];
  const start = lines.findIndex((line) => OWN_HEADER.test(line));
  if (existing !== undefined && start < 0)
    throw new ConfigProblem(
      "unsupportedLayout",
      "The openmail server is not written as an [mcp_servers.openmail] table.",
    );
  let next: string[];
  if (start < 0) {
    if (!launch) return source;
    const body = [...lines];
    while (body.length && body.at(-1)?.trim() === "") body.pop();
    next = [...body, ...(body.length ? [""] : []), ...tomlBlock(launch), ""];
  } else {
    let end = start + 1;
    while (
      end < lines.length &&
      !(ANY_HEADER.test(lines[end] ?? "") && !OWN_HEADER.test(lines[end] ?? ""))
    )
      end++;
    // Blank lines and comments right before the next table belong to it.
    while (end > start + 1 && /^\s*(#.*)?$/.test(lines[end - 1] ?? "")) end--;
    if (lines.slice(end).some((line) => OWN_HEADER.test(line)))
      throw new ConfigProblem(
        "unsupportedLayout",
        "The openmail server's tables are split across the file.",
      );
    const before = lines.slice(0, start);
    let after = lines.slice(end);
    if (!launch) {
      // Drop the blank line that separated the removed block from the next table.
      while (before.length && before.at(-1)?.trim() === "" && after[0]?.trim() === "")
        after = after.slice(1);
      next = [...before, ...after];
    } else next = [...before, ...tomlBlock(launch), ...after];
  }
  const result = next.join(eol);
  const check = launchOf(readTomlEntry(result));
  const expected = launch ?? null;
  if (JSON.stringify(check) !== JSON.stringify(expected))
    throw new ConfigProblem("unsupportedLayout", "The edited file did not read back as expected.");
  return result;
}

// Preview

const LONG_LINE = 240;
const clip = (line: string) => (line.length > LONG_LINE ? `${line.slice(0, LONG_LINE)}…` : line);

/**
 * A unified-style diff of one contiguous change, with a little context. Config edits here always
 * change one block, so the common prefix and suffix are the context.
 */
export function lineDiff(before: string, after: string, context = 2): DiffLine[] {
  const a = before.length ? before.split(/\r?\n/) : [];
  const b = after.length ? after.split(/\r?\n/) : [];
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++;
  const out: DiffLine[] = [];
  const head = Math.max(0, prefix - context);
  if (head > 0) out.push({ kind: "gap", text: "" });
  for (const line of a.slice(head, prefix)) out.push({ kind: "context", text: clip(line) });
  for (const line of a.slice(prefix, a.length - suffix))
    out.push({ kind: "remove", text: clip(line) });
  for (const line of b.slice(prefix, b.length - suffix))
    out.push({ kind: "add", text: clip(line) });
  const tail = Math.min(suffix, context);
  for (const line of a.slice(a.length - suffix, a.length - suffix + tail))
    out.push({ kind: "context", text: clip(line) });
  if (suffix > tail) out.push({ kind: "gap", text: "" });
  return out;
}

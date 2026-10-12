import { isDeepStrictEqual } from "node:util";

import { applyEdits, modify } from "jsonc-parser";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

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

export const isRecord = (value: unknown): value is Record<string, unknown> =>
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

/**
 * The entry after Connect: the existing entry with only `command`, `args` and `env.OPENMAIL_HOME`
 * changed, so the person's own keys (`disabled`, `autoApprove`, `startup_timeout_sec`, other env)
 * survive a reconnect. Without a usable entry it is `fresh` plus the launch. `emptyEnv` keeps an
 * empty env object.
 */
export function mergedEntry(
  existing: unknown,
  launch: McpLaunch,
  fresh: { readonly type?: string; readonly emptyEnv: boolean },
): Record<string, unknown> {
  const reuse = isRecord(existing) && launchOf(existing) !== null;
  const base: Record<string, unknown> = reuse ? existing : fresh.type ? { type: fresh.type } : {};
  const env: Record<string, unknown> = isRecord(base.env) ? { ...base.env } : {};
  delete env.OPENMAIL_HOME;
  Object.assign(env, launch.env);
  const next: Record<string, unknown> = {
    ...base,
    command: launch.command,
    args: [...launch.args],
  };
  // JSON clients write `"env": {}`; Codex leaves an empty env out.
  if (Object.keys(env).length || (fresh.emptyEnv && ("env" in base || !reuse))) next.env = env;
  else delete next.env;
  return next;
}

/** Plain data, so values compare the same whichever parser made them. */
const plain = (value: unknown): unknown =>
  value === undefined ? undefined : JSON.parse(JSON.stringify(value));

/** The parsed file without the openmail server, and without a server table left empty. */
function withoutOwnEntry(parsed: Record<string, unknown>, serversKey: string): unknown {
  const copy = { ...parsed };
  const servers = copy[serversKey];
  if (isRecord(servers)) {
    const rest = { ...servers };
    delete rest[SERVER_NAME];
    if (Object.keys(rest).length) copy[serversKey] = rest;
    else delete copy[serversKey];
  }
  return plain(copy);
}

/**
 * Parses the file before and after an edit and refuses the edit unless the openmail entry is
 * exactly `expected` and everything else in the file is unchanged.
 */
function checkEdit(
  parse: (text: string) => Record<string, unknown>,
  serversKey: string,
  before: string,
  after: string,
  expected: Record<string, unknown> | undefined,
) {
  const a = before.trim() ? parse(before) : {};
  const b = after.trim() ? parse(after) : {};
  const servers = b[serversKey];
  const entry = isRecord(servers) ? servers[SERVER_NAME] : undefined;
  if (
    !isDeepStrictEqual(plain(entry), plain(expected)) ||
    !isDeepStrictEqual(withoutOwnEntry(a, serversKey), withoutOwnEntry(b, serversKey))
  )
    throw new ConfigProblem("unsupportedLayout", "The edited file did not read back as expected.");
}

// JSON: Claude Code's ~/.claude.json, Claude Desktop and Cursor. All keep servers in `mcpServers`.

const BOM = "\uFEFF";
const stripBom = (text: string) => (text.startsWith(BOM) ? text.slice(1) : text);

function parseJson(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(stripBom(text));
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
 * Sets or removes `mcpServers.openmail` with minimal text edits. A reconnect touches only
 * `command`, `args` and `env.OPENMAIL_HOME` inside the existing entry; every other key, the key
 * order, the indentation and the rest of the file stay byte for byte. A byte order mark stays.
 */
export function editJson(
  text: string | null,
  launch: McpLaunch | undefined,
  fresh: { readonly type?: string } = {},
): string {
  const expected = (existing: unknown) =>
    launch ? mergedEntry(existing, launch, { ...fresh, emptyEnv: true }) : undefined;
  if (!text?.trim()) {
    if (!launch) return text ?? "";
    return `${JSON.stringify({ mcpServers: { [SERVER_NAME]: expected(undefined) } }, null, 2)}\n`;
  }
  const bom = text.startsWith(BOM) ? BOM : "";
  const body = stripBom(text);
  const existing = readJsonEntry(body);
  const target = expected(existing);
  const formattingOptions = jsonFormat(body);
  const set = (source: string, path: string[], value: unknown) =>
    applyEdits(
      source,
      modify(source, ["mcpServers", SERVER_NAME, ...path], value, { formattingOptions }),
    );
  let next: string;
  if (!target || !isRecord(existing) || launchOf(existing) === null) next = set(body, [], target);
  else {
    next = set(body, ["command"], target.command);
    next = set(next, ["args"], target.args);
    const home = launch?.env.OPENMAIL_HOME;
    const hadHome = isRecord(existing.env) && "OPENMAIL_HOME" in existing.env;
    if (home !== undefined || hadHome) next = set(next, ["env", "OPENMAIL_HOME"], home);
  }
  checkEdit(parseJson, "mcpServers", body, next, target);
  return bom + next;
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

/** An entry with only a command, string args and string env: written the way Codex writes it. */
const isPlainLaunch = (entry: Record<string, unknown>) =>
  Object.keys(entry).every((key) => ["command", "args", "env"].includes(key)) &&
  // tomlBlock leaves out an empty env.
  (!isRecord(entry.env) || Object.keys(entry.env).length > 0) &&
  isDeepStrictEqual(plain(launchOf(entry)), plain({ args: [], env: {}, ...entry }));

/** The block for a merged entry. Extra keys and subtables go through the TOML writer. */
function entryBlock(entry: Record<string, unknown>): string[] {
  const launch = launchOf(entry);
  if (launch && isPlainLaunch(entry)) return tomlBlock(launch);
  const lines = stringifyToml({ mcp_servers: { [SERVER_NAME]: entry } }).split("\n");
  while (lines.length && lines.at(-1)?.trim() === "") lines.pop();
  return lines;
}

const OWN_HEADER =
  /^\s*\[\s*mcp_servers\s*\.\s*(?:openmail|"openmail")\s*(?:\.[^\]]*)?\]\s*(?:#.*)?$/;
const ANY_HEADER = /^\s*\[/;

/**
 * Replaces, adds or removes the `[mcp_servers.openmail]` table and its subtables as one block of
 * lines. A reconnect keeps the entry's own keys and changes only `command`, `args` and
 * `env.OPENMAIL_HOME`. Everything outside the block, comments included, is left as it was. An
 * entry written another way (an inline table or dotted keys) is refused instead of guessed at.
 */
export function editToml(text: string | null, launch: McpLaunch | undefined): string {
  const source = text ?? "";
  const existing = readTomlEntry(source);
  const target = launch ? mergedEntry(existing, launch, { emptyEnv: false }) : undefined;
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
    if (!target) return source;
    const body = [...lines];
    while (body.length && body.at(-1)?.trim() === "") body.pop();
    next = [...body, ...(body.length ? [""] : []), ...entryBlock(target), ""];
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
    if (!target) {
      // Drop the blank line that separated the removed block from the next table.
      while (before.length && before.at(-1)?.trim() === "" && after[0]?.trim() === "")
        after = after.slice(1);
      next = [...before, ...after];
    } else next = [...before, ...entryBlock(target), ...after];
  }
  const result = next.join(eol);
  checkEdit(parseTomlText, "mcp_servers", source, result, target);
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

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";

import {
  AI_CLIENT_IDS,
  type AiClientChange,
  AiClientError,
  type AiClientId,
  type AiClientPreview,
  type AiClientView,
  type AiLaunchProblem,
  type McpLaunch,
} from "../../shared/ai-clients";
import {
  ConfigProblem,
  editJson,
  editToml,
  launchOf,
  lineDiff,
  readJsonEntry,
  readTomlEntry,
  SERVER_NAME,
} from "./mcp-config";

/** The flag that adds the proposal tools to `openmail mcp`. */
export const WRITE_FLAG = "--allow-writes";

/** Where to look and how to run things. Tests point every path into a temporary directory. */
export interface AiClientsHost {
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Install folders for apps, normally /Applications. */
  readonly applications: string;
  /** Install folders for CLIs beyond PATH and ~/.local/bin, such as Homebrew's. */
  readonly binDirs: readonly string[];
  readonly now: () => Date;
}

export const systemHost = (): AiClientsHost => ({
  home: process.env.HOME ?? "",
  env: process.env,
  applications: "/Applications",
  binDirs: ["/opt/homebrew/bin", "/usr/local/bin"],
  now: () => new Date(),
});

// The command clients run

/**
 * The MCP server command for this app. A packaged app runs its own executable with `--mcp`
 * (see mcp-mode.ts); a development build runs the CLI from the repository with Node.
 * OPENMAIL_HOME is added only when the app uses a data folder other than the default.
 */
export async function appLaunch(options: {
  packaged: boolean;
  execPath: string;
  /** apps/desktop in a development build. */
  appPath: string;
  dataDir: string;
  defaultDataDir: string;
  env: Readonly<Record<string, string | undefined>>;
}): Promise<{ launch: McpLaunch; problem: AiLaunchProblem | null }> {
  const env: Record<string, string> =
    options.dataDir === options.defaultDataDir ? {} : { OPENMAIL_HOME: options.dataDir };
  if (options.packaged)
    return {
      launch: { command: options.execPath, args: ["--mcp"], env },
      problem:
        options.execPath.includes("/AppTranslocation/") || options.execPath.startsWith("/Volumes/")
          ? "translocated"
          : null,
    };
  const cli = join(options.appPath, "..", "..", "packages", "cli", "dist", "cli.js");
  // Version managers (fnm, nvm) put a per-shell symlink first on PATH; its target outlives it.
  const found = await findExecutable("node", pathDirs(options.env.PATH));
  const node = found ? await realpath(found).catch(() => found) : null;
  return {
    launch: { command: node ?? "node", args: [cli, "mcp"], env },
    problem: (await isFile(cli)) ? null : "cliNotBuilt",
  };
}

export const withWrites = (launch: McpLaunch, proposalTools: boolean): McpLaunch => ({
  ...launch,
  args: proposalTools ? [...launch.args, WRITE_FLAG] : launch.args,
});

/** Whether an entry starts this app's server. --allow-writes is a choice, not a mismatch. */
export function matches(entry: McpLaunch, expected: McpLaunch): boolean {
  const args = entry.args.filter((arg) => arg !== WRITE_FLAG);
  return (
    entry.command === expected.command &&
    JSON.stringify(args) === JSON.stringify(expected.args) &&
    (entry.env.OPENMAIL_HOME ?? "") === (expected.env.OPENMAIL_HOME ?? "")
  );
}

// Finding things

const pathDirs = (path: string | undefined) =>
  (path ?? "").split(delimiter).filter((dir) => isAbsolute(dir));

async function isFile(path: string) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findExecutable(name: string, dirs: readonly string[]) {
  for (const dir of dirs) {
    const candidate = join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      if (await isFile(candidate)) return candidate;
    } catch {
      // Next folder.
    }
  }
  return null;
}

/** An app launched from Finder has a minimal PATH, so the usual install folders come first. */
const cliDirs = (host: AiClientsHost) => [
  join(host.home, ".local", "bin"),
  ...host.binDirs,
  ...pathDirs(host.env.PATH),
];

// Clients

type Format = "claudeJson" | "json" | "toml";

interface ClientSpec {
  readonly id: AiClientId;
  readonly format: Format;
  configPath(host: AiClientsHost): string;
  /** CLI names and extra places the client installs its CLI. */
  findCli?(host: AiClientsHost): Promise<string | null>;
  /** Signs that the app is installed even without a CLI. */
  installed(host: AiClientsHost): Promise<boolean>;
}

const SPECS: Record<AiClientId, ClientSpec> = {
  "claude-code": {
    id: "claude-code",
    format: "claudeJson",
    configPath: (host) =>
      join(host.env.CLAUDE_CONFIG_DIR ? host.env.CLAUDE_CONFIG_DIR : host.home, ".claude.json"),
    findCli: (host) =>
      findExecutable("claude", [join(host.home, ".claude", "local"), ...cliDirs(host)]),
    installed: async () => false,
  },
  codex: {
    id: "codex",
    format: "toml",
    configPath: (host) =>
      join(host.env.CODEX_HOME ? host.env.CODEX_HOME : join(host.home, ".codex"), "config.toml"),
    findCli: async (host) =>
      (await findExecutable("codex", cliDirs(host))) ??
      (await findExecutable("codex", [
        join(host.applications, "Codex.app", "Contents", "Resources"),
      ])),
    installed: (host) =>
      exists(host.env.CODEX_HOME ? host.env.CODEX_HOME : join(host.home, ".codex")),
  },
  "claude-desktop": {
    id: "claude-desktop",
    format: "json",
    configPath: (host) =>
      join(host.home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    installed: async (host) =>
      (await exists(join(host.applications, "Claude.app"))) ||
      exists(join(host.home, "Library", "Application Support", "Claude")),
  },
  cursor: {
    id: "cursor",
    format: "json",
    configPath: (host) => join(host.home, ".cursor", "mcp.json"),
    installed: async (host) =>
      (await exists(join(host.applications, "Cursor.app"))) || exists(join(host.home, ".cursor")),
  },
};

const readEntry = (format: Format, text: string | null) =>
  format === "toml" ? readTomlEntry(text) : readJsonEntry(text);

/** Claude Code writes `type` in its entries; the others take the plain launch. */
function jsonEntry(format: Format, launch: McpLaunch): Record<string, unknown> {
  const base = { command: launch.command, args: [...launch.args], env: { ...launch.env } };
  return format === "claudeJson" ? { type: "stdio", ...base } : base;
}

function editConfig(format: Format, text: string | null, launch: McpLaunch | undefined) {
  return format === "toml"
    ? editToml(text, launch)
    : editJson(text, launch ? jsonEntry(format, launch) : undefined);
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

const tokenOf = (text: string | null) =>
  createHash("sha256")
    .update(text === null ? "\u0000missing" : `\u0001${text}`)
    .digest("hex");

/** A POSIX shell word, for the copyable command only. OpenMail itself never uses a shell. */
const shellWord = (word: string) =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

const envFlags = (flag: string, env: Record<string, string>) =>
  Object.entries(env).flatMap(([key, value]) => [flag, `${key}=${value}`]);

/** The client CLI's argv to add or remove the server, without the CLI itself. */
function cliArgs(id: AiClientId, launch: McpLaunch | undefined): string[] {
  if (id === "claude-code")
    return launch
      ? [
          "mcp",
          "add",
          "--scope",
          "user",
          "--transport",
          "stdio",
          SERVER_NAME,
          ...envFlags("-e", launch.env),
          "--",
          launch.command,
          ...launch.args,
        ]
      : ["mcp", "remove", "--scope", "user", SERVER_NAME];
  return launch
    ? [
        "mcp",
        "add",
        SERVER_NAME,
        ...envFlags("--env", launch.env),
        "--",
        launch.command,
        ...launch.args,
      ]
    : ["mcp", "remove", SERVER_NAME];
}

/** What a person types or pastes to connect without OpenMail's help. */
function manualText(spec: ClientSpec, launch: McpLaunch): string {
  if (spec.id === "claude-code" || spec.id === "codex")
    return [spec.id === "claude-code" ? "claude" : "codex", ...cliArgs(spec.id, launch)]
      .map(shellWord)
      .join(" ");
  return `${JSON.stringify({ mcpServers: { [SERVER_NAME]: jsonEntry(spec.format, launch) } }, null, 2)}\n`;
}

export async function clientView(
  host: AiClientsHost,
  id: AiClientId,
  launch: McpLaunch,
): Promise<AiClientView> {
  const spec = SPECS[id];
  const configPath = spec.configPath(host);
  const cliPath = spec.findCli ? await spec.findCli(host) : null;
  const installed = cliPath !== null || (await spec.installed(host));
  const method = cliPath ? "cli" : spec.format === "claudeJson" ? "manual" : "file";
  const base = {
    id,
    installed,
    method,
    cliPath,
    configPath,
    manual: manualText(spec, launch),
  } as const;
  try {
    const entry = readEntry(spec.format, await readText(configPath));
    if (entry === undefined)
      return { ...base, state: "notConnected", entry: null, proposalTools: false, problem: null };
    const current = launchOf(entry);
    return {
      ...base,
      state: current && matches(current, launch) ? "connected" : "stale",
      entry: current,
      proposalTools: current?.args.includes(WRITE_FLAG) ?? false,
      problem: null,
    };
  } catch (error) {
    return {
      ...base,
      state: "unreadable",
      entry: null,
      proposalTools: false,
      problem: error instanceof Error ? error.message : String(error),
    };
  }
}

export const clientViews = (host: AiClientsHost, launch: McpLaunch) =>
  Promise.all(AI_CLIENT_IDS.map((id) => clientView(host, id, launch)));

// Changes

interface Plan {
  readonly file: string;
  readonly before: string | null;
  readonly after: string;
  /** argv lists, the CLI first. Empty: OpenMail writes `after` itself. */
  readonly commands: readonly (readonly string[])[];
}

const fail = (reason: AiClientError["reason"], detail = "") =>
  new AiClientError({ reason, detail });

const asClientError = (error: unknown) =>
  error instanceof AiClientError
    ? error
    : error instanceof ConfigProblem
      ? fail(error.reason, error.message)
      : fail("writeFailed", error instanceof Error ? error.message : String(error));

async function plan(host: AiClientsHost, change: AiClientChange, launch: McpLaunch): Promise<Plan> {
  const spec = SPECS[change.client];
  const view = await clientView(host, change.client, launch);
  if (view.state === "unreadable") throw fail("unreadable", view.problem ?? "");
  if (view.method === "manual") throw fail("notInstalled");
  const target = change.action === "connect" ? withWrites(launch, change.proposalTools) : undefined;
  const file = spec.configPath(host);
  const before = await readText(file);
  const after = editConfig(spec.format, before, target);
  const commands: string[][] = [];
  if (view.method === "cli" && view.cliPath && after !== (before ?? "")) {
    // `mcp add` refuses an existing name, so a reconnect removes the old entry first.
    if (view.state !== "notConnected")
      commands.push([view.cliPath, ...cliArgs(change.client, undefined)]);
    if (target) commands.push([view.cliPath, ...cliArgs(change.client, target)]);
  }
  return { file, before, after, commands };
}

export async function previewChange(
  host: AiClientsHost,
  change: AiClientChange,
  launch: McpLaunch,
): Promise<AiClientPreview> {
  try {
    const result = await plan(host, change, launch);
    return {
      change,
      file: result.file,
      commands: result.commands,
      diff: lineDiff(result.before ?? "", result.after),
      backup: result.before !== null,
      token: tokenOf(result.before),
    };
  } catch (error) {
    throw asClientError(error);
  }
}

/** `config.json.openmail-backup-20261012-204501`, next to the file. */
const backupSuffix = ".openmail-backup-";
const stamp = (date: Date) =>
  date
    .toISOString()
    .replace(/\.\d+Z$/, "")
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace("T", "-");
const KEPT_BACKUPS = 5;

/** Copies the file next to itself, keeping its mode, and prunes OpenMail's older copies. */
async function backup(file: string, now: Date) {
  let target = `${file}${backupSuffix}${stamp(now)}`;
  for (let n = 2; await exists(target); n++) target = `${file}${backupSuffix}${stamp(now)}-${n}`;
  await copyFile(file, target, constants.COPYFILE_EXCL);
  await chmod(target, (await stat(file)).mode & 0o777);
  const prefix = `${basename(file)}${backupSuffix}`;
  const ours = (await readdir(dirname(file))).filter((name) => name.startsWith(prefix)).toSorted();
  for (const old of ours.slice(0, Math.max(0, ours.length - KEPT_BACKUPS)))
    await rm(join(dirname(file), old), { force: true });
  return target;
}

/** Temp file in the same folder, then rename, so the client never reads half a file. */
async function writeAtomically(file: string, text: string) {
  // A symlinked config (dotfiles) is written where the link points, and stays a link.
  const real = await realpath(file).catch(() => file);
  const mode = await stat(real).then(
    (s) => s.mode & 0o777,
    () => 0o600,
  );
  await mkdir(dirname(real), { recursive: true });
  const temp = join(dirname(real), `.${basename(real)}.openmail-${randomBytes(6).toString("hex")}`);
  try {
    await writeFile(temp, text, { mode, flag: "wx" });
    await chmod(temp, mode);
    await rename(temp, real);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** Runs a client CLI with a fixed argv and no shell. */
export function runCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ code: number; stderr: string }> {
  const [file, ...args] = argv;
  return new Promise((resolve) => {
    if (!file) {
      resolve({ code: 1, stderr: "No command." });
      return;
    }
    execFile(
      file,
      args,
      // npm-installed CLIs are `#!/usr/bin/env node` scripts; their own folder usually has node.
      {
        env: { ...env, PATH: [dirname(file), env.PATH ?? ""].join(delimiter) },
        timeout: 30_000,
        shell: false,
      },
      (error, _stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stderr });
      },
    );
  });
}

/**
 * Makes the change the person confirmed. Refuses when the file changed since the preview,
 * saves a backup first, then runs the client's CLI or writes the file atomically.
 */
export async function applyChange(
  host: AiClientsHost,
  change: AiClientChange,
  launch: McpLaunch,
  token: string,
  run: typeof runCli = runCli,
): Promise<void> {
  try {
    const result = await plan(host, change, launch);
    if (tokenOf(result.before) !== token)
      throw fail("changed", "The file changed after the preview.");
    if (result.after === (result.before ?? "")) return;
    if (result.before !== null) await backup(result.file, host.now());
    if (!result.commands.length) {
      await writeAtomically(result.file, result.after);
      return;
    }
    for (const argv of result.commands) {
      const { code, stderr } = await run(argv, host.env);
      if (code !== 0)
        throw fail(
          "cliFailed",
          stderr.trim().split("\n").slice(-3).join("\n") || `Exit code ${code}`,
        );
    }
  } catch (error) {
    throw asClientError(error);
  }
}

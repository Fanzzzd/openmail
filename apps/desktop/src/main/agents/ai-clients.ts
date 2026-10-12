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
  isRecord,
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

async function isExecutable(path: string) {
  try {
    await access(path, constants.X_OK);
    return await isFile(path);
  } catch {
    return false;
  }
}

async function findExecutable(name: string, dirs: readonly string[]) {
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

/** The real folder a link points to, only when it resolves to an absolute folder. */
async function realDir(path: string) {
  const real = await realpath(path).catch(() => null);
  return real && isAbsolute(real) && (await stat(real).catch(() => null))?.isDirectory()
    ? real
    : null;
}

const versionParts = (name: string) =>
  name
    .replace(/^v/, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
const newestFirst = (a: string, b: string) => {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++)
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
};

/**
 * The global bin folders of Node version managers. An app launched from Finder never ran the
 * shell hook that puts them on PATH, and the hook's per-shell folders (fnm's multishell) vanish
 * with the shell, so only the managers' default installs count.
 */
async function versionManagerDirs(host: AiClientsHost): Promise<string[]> {
  const dirs: string[] = [];
  const fnmRoots = [
    host.env.FNM_DIR,
    join(host.home, ".local", "share", "fnm"),
    join(host.home, "Library", "Application Support", "fnm"),
  ];
  for (const root of fnmRoots) {
    if (!root || !isAbsolute(root)) continue;
    const install = await realDir(join(root, "aliases", "default"));
    if (install) dirs.push(join(install, "bin"));
  }
  const nvm =
    host.env.NVM_DIR && isAbsolute(host.env.NVM_DIR) ? host.env.NVM_DIR : join(host.home, ".nvm");
  const versions = (await readdir(join(nvm, "versions", "node")).catch(() => []))
    .filter((name) => /^v\d+(\.\d+)*$/.test(name))
    .toSorted(newestFirst);
  const alias = (await readFile(join(nvm, "alias", "default"), "utf8").catch(() => "")).trim();
  const wanted = /^v?\d+(\.\d+)*$/.test(alias) ? `v${alias.replace(/^v/, "")}` : null;
  const preferred = wanted
    ? versions.find((name) => name === wanted || name.startsWith(`${wanted}.`))
    : undefined;
  for (const name of preferred ? [preferred, ...versions.filter((v) => v !== preferred)] : versions)
    dirs.push(join(nvm, "versions", "node", name, "bin"));
  return dirs;
}

/** An app launched from Finder has a minimal PATH, so the usual install folders come first. */
const cliDirs = async (host: AiClientsHost) => [
  join(host.home, ".local", "bin"),
  ...host.binDirs,
  join(host.home, ".npm-global", "bin"),
  join(host.home, ".volta", "bin"),
  join(host.home, ".bun", "bin"),
  host.env.PNPM_HOME && isAbsolute(host.env.PNPM_HOME)
    ? host.env.PNPM_HOME
    : join(host.home, "Library", "pnpm"),
  ...(await versionManagerDirs(host)),
  ...pathDirs(host.env.PATH),
];

// Config formats

type Format = "claudeJson" | "json" | "toml";

const FORMATS: Record<
  Format,
  {
    read(text: string | null): unknown;
    edit(text: string | null, launch: McpLaunch | undefined): string;
  }
> = {
  // Claude Code writes `type` in its entries.
  claudeJson: {
    read: readJsonEntry,
    edit: (text, launch) => editJson(text, launch, { type: "stdio" }),
  },
  json: { read: readJsonEntry, edit: (text, launch) => editJson(text, launch) },
  toml: { read: readTomlEntry, edit: editToml },
};

// Clients

interface ClientSpec {
  readonly format: Format;
  configPath(host: AiClientsHost): string;
  /** CLI names and extra places the client installs its CLI. */
  findCli?(host: AiClientsHost): Promise<string | null>;
  /** Signs that the app is installed even without a CLI. */
  installed(host: AiClientsHost): Promise<boolean>;
}

const codexHome = (host: AiClientsHost) =>
  host.env.CODEX_HOME && isAbsolute(host.env.CODEX_HOME)
    ? host.env.CODEX_HOME
    : join(host.home, ".codex");

const SPECS: Record<AiClientId, ClientSpec> = {
  "claude-code": {
    format: "claudeJson",
    configPath: (host) =>
      join(
        host.env.CLAUDE_CONFIG_DIR && isAbsolute(host.env.CLAUDE_CONFIG_DIR)
          ? host.env.CLAUDE_CONFIG_DIR
          : host.home,
        ".claude.json",
      ),
    findCli: async (host) =>
      findExecutable("claude", [join(host.home, ".claude", "local"), ...(await cliDirs(host))]),
    installed: async () => false,
  },
  codex: {
    format: "toml",
    configPath: (host) => join(codexHome(host), "config.toml"),
    findCli: async (host) =>
      (await findExecutable("codex", await cliDirs(host))) ??
      (await findExecutable("codex", [
        join(host.applications, "Codex.app", "Contents", "Resources"),
      ])),
    installed: (host) => exists(codexHome(host)),
  },
  "claude-desktop": {
    format: "json",
    configPath: (host) =>
      join(host.home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    installed: async (host) =>
      (await exists(join(host.applications, "Claude.app"))) ||
      exists(join(host.home, "Library", "Application Support", "Claude")),
  },
  cursor: {
    format: "json",
    configPath: (host) => join(host.home, ".cursor", "mcp.json"),
    installed: async (host) =>
      (await exists(join(host.applications, "Cursor.app"))) || exists(join(host.home, ".cursor")),
  },
};

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

/** `claude mcp …` argv without the CLI. add-json carries the whole entry, extra keys included. */
const claudeArgs = {
  add: (launch: McpLaunch) => [
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
  ],
  addJson: (entry: Record<string, unknown>) => [
    "mcp",
    "add-json",
    "--scope",
    "user",
    SERVER_NAME,
    JSON.stringify(entry),
  ],
  remove: () => ["mcp", "remove", "--scope", "user", SERVER_NAME],
};

/** `codex mcp …` argv without the CLI. */
const codexArgs = {
  add: (launch: McpLaunch) => [
    "mcp",
    "add",
    SERVER_NAME,
    ...envFlags("--env", launch.env),
    "--",
    launch.command,
    ...launch.args,
  ],
  remove: () => ["mcp", "remove", SERVER_NAME],
};

/** What a person types or pastes to connect without OpenMail's help. */
function manualText(id: AiClientId, launch: McpLaunch): string {
  if (id === "claude-code") return ["claude", ...claudeArgs.add(launch)].map(shellWord).join(" ");
  if (id === "codex") return ["codex", ...codexArgs.add(launch)].map(shellWord).join(" ");
  const entry = { command: launch.command, args: launch.args, env: launch.env };
  return `${JSON.stringify({ mcpServers: { [SERVER_NAME]: entry } }, null, 2)}\n`;
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
    manual: manualText(id, launch),
  } as const;
  let raw: unknown;
  try {
    raw = FORMATS[spec.format].read(await readText(configPath));
  } catch (error) {
    return {
      ...base,
      state: "unreadable",
      problem: error instanceof Error ? error.message : String(error),
    };
  }
  if (raw === undefined) return { ...base, state: "notConnected" };
  const entry = launchOf(raw);
  const proposalTools = entry?.args.includes(WRITE_FLAG) ?? false;
  // A command that is gone (an old version manager folder, a deleted build) can't start.
  const runnable =
    entry !== null && (!isAbsolute(entry.command) || (await isExecutable(entry.command)));
  const state = entry && runnable && matches(entry, launch) ? "connected" : "stale";
  return { ...base, state, entry, proposalTools };
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
  /** Run when a later command fails, to put the old entry back. */
  readonly rollback: readonly (readonly string[])[];
  readonly token: string;
}

const fail = (reason: AiClientError["reason"], detail = "") =>
  new AiClientError({ reason, detail });

/** The one mapping from anything thrown here to what Settings shows. */
export const asClientError = (error: unknown) =>
  error instanceof AiClientError
    ? error
    : error instanceof ConfigProblem
      ? fail(error.reason, error.message)
      : fail("writeFailed", error instanceof Error ? error.message : String(error));

/**
 * The CLI calls for a change, or none when OpenMail edits the file itself.
 *
 * Claude Code: `mcp add-json` with the merged entry, so the person's own keys survive. `mcp add`
 * refuses an existing name, so a reconnect removes the old entry first and puts it back if the
 * add fails.
 * Codex: `mcp add` and `mcp remove`. Its `add` can only write command, args and env, so a
 * reconnect edits the file instead and keeps the entry's other keys.
 */
function cliPlan(
  id: AiClientId,
  cli: string,
  existing: unknown,
  target: Record<string, unknown> | undefined,
  launch: McpLaunch | undefined,
) {
  const run = (args: string[]) => [cli, ...args];
  const old = isRecord(existing) ? existing : null;
  if (id === "claude-code") {
    const commands = [
      ...(existing === undefined ? [] : [run(claudeArgs.remove())]),
      ...(target ? [run(claudeArgs.addJson(target))] : []),
    ];
    const rollback = target && old ? [run(claudeArgs.addJson(old))] : [];
    return { commands, rollback };
  }
  if (existing !== undefined && launch) return null;
  return {
    commands: [run(launch ? codexArgs.add(launch) : codexArgs.remove())],
    rollback: [],
  };
}

async function plan(host: AiClientsHost, change: AiClientChange, launch: McpLaunch): Promise<Plan> {
  const spec = SPECS[change.client];
  const view = await clientView(host, change.client, launch);
  if (view.state === "unreadable") throw fail("unreadable", view.problem);
  if (view.method === "manual") throw fail("notInstalled");
  const target = change.action === "connect" ? withWrites(launch, change.proposalTools) : undefined;
  const format = FORMATS[spec.format];
  const file = spec.configPath(host);
  const before = await readText(file);
  const existing = format.read(before);
  const after = format.edit(before, target);
  const none = { file, before, after, commands: [], rollback: [] };
  if (after === (before ?? "")) return { ...none, token: tokenOf(before) };
  const entry = format.read(after);
  const cli =
    view.method === "cli" && view.cliPath
      ? cliPlan(change.client, view.cliPath, existing, isRecord(entry) ? entry : undefined, target)
      : null;
  if (!cli) return { ...none, token: tokenOf(before) };
  // The CLI edits only the entry, and the rest of the file may change at any time.
  return { file, before, after, ...cli, token: tokenOf(JSON.stringify(existing ?? null)) };
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
      backup: result.before !== null && !result.commands.length,
      token: result.token,
    };
  } catch (error) {
    throw asClientError(error);
  }
}

/** `config.json.openmail-backup-20261012-204501`, then `-2`, `-3` within the same second. */
const backupSuffix = ".openmail-backup-";
const stamp = (date: Date) =>
  date
    .toISOString()
    .replace(/\.\d+Z$/, "")
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace("T", "-");
const KEPT_BACKUPS = 5;
const BACKUP_NAME = /^(\d{8}-\d{6})(?:-(\d+))?$/;

/** Oldest first: by timestamp, then by the same-second counter as a number. */
function backupOrder(prefix: string, names: readonly string[]) {
  return names
    .map((name) => ({ name, match: BACKUP_NAME.exec(name.slice(prefix.length)) }))
    .filter((item) => item.name.startsWith(prefix) && item.match)
    .toSorted(
      (a, b) =>
        (a.match?.[1] ?? "").localeCompare(b.match?.[1] ?? "") ||
        Number(a.match?.[2] ?? 1) - Number(b.match?.[2] ?? 1),
    )
    .map((item) => item.name);
}

/** Copies the file next to itself, keeping its mode, and prunes OpenMail's older copies. */
async function backup(file: string, now: Date) {
  const prefix = `${basename(file)}${backupSuffix}`;
  const ours = backupOrder(prefix, await readdir(dirname(file)));
  // After the newest copy of this second, so pruning never removes the copy just made.
  const sameSecond = ours
    .map((name) => BACKUP_NAME.exec(name.slice(prefix.length)))
    .filter((match) => match?.[1] === stamp(now))
    .map((match) => Number(match?.[2] ?? 1));
  const n = sameSecond.length ? Math.max(...sameSecond) + 1 : 1;
  const target = `${file}${backupSuffix}${stamp(now)}${n > 1 ? `-${n}` : ""}`;
  await copyFile(file, target, constants.COPYFILE_EXCL);
  await chmod(target, (await stat(file)).mode & 0o777);
  ours.push(basename(target));
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

const cliError = (code: number, stderr: string) =>
  stderr.trim().split("\n").slice(-3).join("\n") || `Exit code ${code}`;

/**
 * Makes the change the person confirmed. Refuses when what the preview showed changed since.
 * A file edit saves a backup and writes atomically; a CLI change runs the client's commands and,
 * when one fails after the old entry was removed, puts the old entry back.
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
    if (result.token !== token) throw fail("changed", "The file changed after the preview.");
    if (result.after === (result.before ?? "")) return;
    if (!result.commands.length) {
      if (result.before !== null) await backup(result.file, host.now());
      await writeAtomically(result.file, result.after);
      return;
    }
    for (const [index, argv] of result.commands.entries()) {
      const { code, stderr } = await run(argv, host.env);
      if (code === 0) continue;
      let detail = cliError(code, stderr);
      if (index > 0)
        for (const undo of result.rollback) {
          const restored = await run(undo, host.env);
          if (restored.code !== 0)
            detail += `\nPutting the old entry back failed too: ${cliError(restored.code, restored.stderr)}`;
        }
      throw fail("cliFailed", detail);
    }
  } catch (error) {
    throw asClientError(error);
  }
}

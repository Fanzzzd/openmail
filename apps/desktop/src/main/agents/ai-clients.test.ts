import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AiClientError, type McpLaunch } from "../../shared/ai-clients";
import {
  type AiClientsHost,
  appLaunch,
  applyChange,
  clientView,
  clientViews,
  matches,
  previewChange,
  withWrites,
} from "./ai-clients";
import { ConfigProblem, editJson, editToml, lineDiff, readTomlEntry } from "./mcp-config";

const LAUNCH: McpLaunch = {
  command: "/Applications/OpenMail.app/Contents/MacOS/OpenMail",
  args: ["--mcp"],
  env: {},
};
/** A launch whose command exists, so an entry for it can count as connected. */
const RUNNABLE: McpLaunch = { ...LAUNCH, command: process.execPath };

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A fake home with nothing installed. Every path the code touches is inside it. */
async function fakeHost(): Promise<AiClientsHost & { log: string }> {
  const root = await mkdtemp(join(tmpdir(), "openmail-ai-clients-"));
  temps.push(root);
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  await mkdir(join(root, "Applications"));
  const log = join(root, "cli.log");
  return {
    home,
    // No real PATH: the fake CLIs below are the only ones these tests can find or run.
    env: { HOME: home, PATH: "", FAKE_LOG: log },
    applications: join(root, "Applications"),
    binDirs: [],
    now: () => new Date("2026-10-12T12:34:56Z"),
    log,
  };
}

/**
 * What a stand-in CLI does to its config in the fake home, like the real one: Claude Code keeps
 * entries in ~/.claude.json, Codex in ~/.codex/config.toml.
 */
const FAKE_EDITS = `
const fs = require("fs"), path = require("path");
const [group, verb] = args;
if (group === "mcp" && name === "claude") {
  const file = path.join(process.env.HOME, ".claude.json");
  let config = {};
  try { config = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  config.mcpServers = config.mcpServers || {};
  if (verb === "remove") delete config.mcpServers[args.at(-1)];
  if (verb === "add-json") config.mcpServers[args[4]] = JSON.parse(args[5]);
  fs.writeFileSync(file, JSON.stringify(config));
}
if (group === "mcp" && name === "codex") {
  const file = path.join(process.env.HOME, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch {}
  text = text.replace(/\\[mcp_servers\\.openmail\\][^\\[]*/, "");
  if (verb === "add") {
    const rest = args.slice(args.indexOf("--") + 1);
    text += "[mcp_servers.openmail]\\ncommand = " + JSON.stringify(rest[0]) + "\\nargs = " + JSON.stringify(rest.slice(1)) + "\\n";
  }
  fs.writeFileSync(file, text);
}
`;

/**
 * A stand-in CLI that records its argv, one JSON array per line, and edits its config in the
 * fake home as the real CLI would (`writes: false` makes it exit 0 and change nothing). It
 * exits with `exitCode`, or fails only when its second argument is `failOn` (`add-json`, say).
 */
async function fakeCli(
  host: AiClientsHost,
  name: string,
  exitCode = 0,
  options: { dir?: string; failOn?: string; writes?: boolean } = {},
) {
  const dir = options.dir ?? join(host.home, ".local", "bin");
  await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  const fails = options.failOn
    ? `process.argv[3] === ${JSON.stringify(options.failOn)}`
    : String(exitCode !== 0);
  await writeFile(
    file,
    `#!${process.execPath}\nconst args = process.argv.slice(2), name = ${JSON.stringify(name)};\nrequire("fs").appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + "\\n");\nif (${fails}) { process.stderr.write("boom\\n"); process.exit(${exitCode || 1}); }\n${options.writes === false ? "" : FAKE_EDITS}`,
  );
  await chmod(file, 0o755);
  return file;
}

const calls = async (host: { log: string }) =>
  (await readFile(host.log, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((line): unknown => JSON.parse(line));

describe("JSON configs", () => {
  const original = `{
    "globalShortcut": "",
    "mcpServers": {
        "filesystem": {
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me"]
        }
    },
    "zeta": [1, 2, 3]
}
`;

  it("adds, replaces and removes only the openmail entry", () => {
    const added = editJson(original, { command: "x", args: ["mcp"], env: {} });
    expect(added).toContain(
      '"args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me"]',
    );
    expect(added).toContain('"zeta": [1, 2, 3]');
    expect(added).toContain('\n        "openmail": {');
    expect(JSON.parse(added).mcpServers.openmail).toEqual({ command: "x", args: ["mcp"], env: {} });
    const replaced = editJson(added, { command: "y", args: [], env: {} });
    expect(JSON.parse(replaced).mcpServers.openmail.command).toBe("y");
    expect(editJson(replaced, undefined)).toBe(original);
  });

  it("creates a missing file and refuses one that doesn't parse", () => {
    expect(JSON.parse(editJson(null, { command: "x", args: [], env: {} }))).toEqual({
      mcpServers: { openmail: { command: "x", args: [], env: {} } },
    });
    expect(() => editJson("{ // comment\n}", undefined)).toThrow(ConfigProblem);
    expect(() => editJson('{"mcpServers": []}', { command: "x", args: [], env: {} })).toThrow(
      /not a JSON object/,
    );
  });

  it("reconnects by changing only command, args and OPENMAIL_HOME", () => {
    const mine = `{
  "mcpServers": {
    "openmail": {
      "disabled": false,
      "command": "/old",
      "args": ["--mcp"],
      "autoApprove": ["search"],
      "env": { "OPENMAIL_HOME": "/old/data", "DEBUG": "1" }
    }
  }
}
`;
    const next = editJson(mine, { command: "/new", args: ["--mcp", "--allow-writes"], env: {} });
    expect(JSON.parse(next).mcpServers.openmail).toEqual({
      disabled: false,
      command: "/new",
      args: ["--mcp", "--allow-writes"],
      autoApprove: ["search"],
      env: { DEBUG: "1" },
    });
    expect(Object.keys(JSON.parse(next).mcpServers.openmail)).toEqual([
      "disabled",
      "command",
      "args",
      "autoApprove",
      "env",
    ]);
    expect(next).toContain('"autoApprove": ["search"],');
  });

  it("reads and keeps a byte order mark", () => {
    const withBom = `\uFEFF${original}`;
    const added = editJson(withBom, { command: "x", args: [], env: {} });
    expect(added.startsWith("\uFEFF{")).toBe(true);
    expect(editJson(added, undefined)).toBe(withBom);
  });
});

describe("Codex TOML", () => {
  const original = `# My Codex settings
model = "gpt-5"

[mcp_servers.wechat]
command = "/usr/local/bin/wechat"  # keep this comment
args = ["--transport", "stdio"]

[mcp_servers.openmail]
command = "/old/OpenMail"
args = ["--mcp"]

[mcp_servers.openmail.env]
OPENMAIL_HOME = "/tmp/x"

# Projects
[projects."/Users/me/code"]
trust_level = "trusted"
`;

  it("replaces the openmail table and its subtables, nothing else", () => {
    const next = editToml(original, LAUNCH);
    expect(next).toBe(
      original.replace(
        `[mcp_servers.openmail]
command = "/old/OpenMail"
args = ["--mcp"]

[mcp_servers.openmail.env]
OPENMAIL_HOME = "/tmp/x"
`,
        `[mcp_servers.openmail]
command = "/Applications/OpenMail.app/Contents/MacOS/OpenMail"
args = ["--mcp"]
`,
      ),
    );
  });

  it("removes the block and appends a new one at the end", () => {
    const removed = editToml(original, undefined);
    expect(removed).not.toContain("openmail");
    expect(removed).toContain("# keep this comment");
    expect(removed).toContain('args = ["--transport", "stdio"]\n\n# Projects');
    const added = editToml(removed, { ...LAUNCH, env: { OPENMAIL_HOME: '/tmp/a "b"' } });
    expect(
      added.endsWith(`[mcp_servers.openmail]
command = "/Applications/OpenMail.app/Contents/MacOS/OpenMail"
args = ["--mcp"]
env = { OPENMAIL_HOME = "/tmp/a \\"b\\"" }
`),
    ).toBe(true);
    expect(readTomlEntry(added)).toEqual({
      command: LAUNCH.command,
      args: ["--mcp"],
      env: { OPENMAIL_HOME: '/tmp/a "b"' },
    });
  });

  it("keeps the entry's own keys and subtables on reconnect", () => {
    const mine = `[mcp_servers.openmail]
command = "/old"
args = ["--mcp"]
startup_timeout_sec = 30

[mcp_servers.openmail.env]
OPENMAIL_HOME = "/old/data"
DEBUG = "1"

[projects."/x"]
trust_level = "trusted"
`;
    const next = editToml(mine, LAUNCH);
    expect(readTomlEntry(next)).toEqual({
      command: LAUNCH.command,
      args: ["--mcp"],
      startup_timeout_sec: 30,
      env: { DEBUG: "1" },
    });
    expect(next).toContain('\n[projects."/x"]\ntrust_level = "trusted"\n');
  });

  it("refuses inline definitions and files that don't parse", () => {
    expect(() => editToml('[mcp_servers]\nopenmail = { command = "x" }\n', LAUNCH)).toThrow(
      /not written as an \[mcp_servers.openmail\] table/,
    );
    expect(() => editToml("model = \n", LAUNCH)).toThrow(ConfigProblem);
  });
});

describe("diff preview", () => {
  it("shows the changed block with two lines of context", () => {
    expect(lineDiff("a\nb\nc\nd\ne\nf\n", "a\nb\nc\nX\ne\nf\n")).toEqual([
      { kind: "gap", text: "" },
      { kind: "context", text: "b" },
      { kind: "context", text: "c" },
      { kind: "remove", text: "d" },
      { kind: "add", text: "X" },
      { kind: "context", text: "e" },
      { kind: "context", text: "f" },
      { kind: "gap", text: "" },
    ]);
  });
});

describe("the launch command", () => {
  it("runs the packaged app with --mcp and names the data folder only when it isn't the default", async () => {
    const base = {
      packaged: true,
      execPath: "/Applications/OpenMail.app/Contents/MacOS/OpenMail",
      appPath: "/unused",
      defaultDataDir: "/Users/me/Library/Application Support/openmail",
      env: {},
    };
    expect(await appLaunch({ ...base, dataDir: base.defaultDataDir })).toEqual({
      launch: LAUNCH,
      problem: null,
    });
    expect((await appLaunch({ ...base, dataDir: "/tmp/other" })).launch.env).toEqual({
      OPENMAIL_HOME: "/tmp/other",
    });
    expect(
      (
        await appLaunch({
          ...base,
          dataDir: base.defaultDataDir,
          execPath:
            "/private/var/folders/x/AppTranslocation/1/d/OpenMail.app/Contents/MacOS/OpenMail",
        })
      ).problem,
    ).toBe("translocated");
  });

  it("runs the repository CLI with Node in a development build", async () => {
    const host = await fakeHost();
    const result = await appLaunch({
      packaged: false,
      execPath: "/electron",
      appPath: join(host.home, "repo", "apps", "desktop"),
      dataDir: "/d",
      defaultDataDir: "/d",
      env: { PATH: "" },
    });
    expect(result.launch).toEqual({
      command: "node",
      args: [join(host.home, "repo", "packages", "cli", "dist", "cli.js"), "mcp"],
      env: {},
    });
    expect(result.problem).toBe("cliNotBuilt");
  });

  it("matches entries regardless of --allow-writes", () => {
    expect(matches(withWrites(LAUNCH, true), LAUNCH)).toBe(true);
    expect(matches({ ...LAUNCH, command: "/Volumes/OpenMail/OpenMail" }, LAUNCH)).toBe(false);
    expect(matches({ ...LAUNCH, env: { OPENMAIL_HOME: "/x" } }, LAUNCH)).toBe(false);
  });
});

describe("clients in a fake home", () => {
  it("detects nothing in an empty home", async () => {
    const host = await fakeHost();
    const views = await clientViews(host, LAUNCH);
    expect(views.map((v) => [v.id, v.installed, v.method, v.state])).toEqual([
      ["claude-code", false, "manual", "notConnected"],
      ["codex", false, "file", "notConnected"],
      ["claude-desktop", false, "file", "notConnected"],
      ["cursor", false, "file", "notConnected"],
    ]);
    expect(views[0]?.manual).toBe(
      "claude mcp add --scope user --transport stdio openmail -- /Applications/OpenMail.app/Contents/MacOS/OpenMail --mcp",
    );
  });

  it("reads each client's state from its config", async () => {
    const host = await fakeHost();
    await fakeCli(host, "claude");
    await writeFile(
      join(host.home, ".claude.json"),
      JSON.stringify({
        mcpServers: { openmail: { type: "stdio", ...withWrites(RUNNABLE, true) } },
      }),
    );
    await mkdir(join(host.home, ".codex"));
    await writeFile(
      join(host.home, ".codex", "config.toml"),
      '[mcp_servers.openmail]\ncommand = "/old"\n',
    );
    await mkdir(join(host.home, ".cursor"));
    await writeFile(join(host.home, ".cursor", "mcp.json"), "{ not json");
    const views = await clientViews(host, RUNNABLE);
    const proposals = (v: (typeof views)[number]) => "proposalTools" in v && v.proposalTools;
    expect(views.map((v) => [v.id, v.installed, v.method, v.state, proposals(v)])).toEqual([
      ["claude-code", true, "cli", "connected", true],
      ["codex", true, "file", "stale", false],
      ["claude-desktop", false, "file", "notConnected", false],
      ["cursor", true, "file", "unreadable", false],
    ]);
    expect(views[3]?.state === "unreadable" && views[3].problem).toBeTruthy();
  });

  it("edits Claude Desktop's file after a preview, with a backup and the original mode", async () => {
    const host = await fakeHost();
    const dir = join(host.home, "Library", "Application Support", "Claude");
    await mkdir(dir, { recursive: true });
    const file = join(dir, "claude_desktop_config.json");
    const before = `${JSON.stringify({ mcpServers: { other: { command: "o" } }, theme: "dark" }, null, 2)}\n`;
    await writeFile(file, before, { mode: 0o640 });
    await chmod(file, 0o640);
    const change = { client: "claude-desktop", action: "connect", proposalTools: false } as const;
    const preview = await previewChange(host, change, RUNNABLE);
    expect(preview.commands).toEqual([]);
    expect(preview.backup).toBe(true);
    expect(
      preview.diff.filter((line) => line.kind === "add").map((line) => line.text.trim()),
    ).toContain(`"command": ${JSON.stringify(RUNNABLE.command)},`);
    await applyChange(host, change, RUNNABLE, preview.token);
    const after = JSON.parse(await readFile(file, "utf8"));
    expect(after.theme).toBe("dark");
    expect(after.mcpServers.other).toEqual({ command: "o" });
    expect(after.mcpServers.openmail).toEqual({ ...RUNNABLE, args: ["--mcp"] });
    expect((await stat(file)).mode & 0o777).toBe(0o640);
    const backups = (await readdir(dir)).filter((name) => name.includes(".openmail-backup-"));
    expect(backups).toEqual(["claude_desktop_config.json.openmail-backup-20261012-123456"]);
    expect(await readFile(join(dir, backups[0]!), "utf8")).toBe(before);
    expect((await clientView(host, "claude-desktop", RUNNABLE)).state).toBe("connected");
    // No temp files left behind.
    expect((await readdir(dir)).filter((name) => name.startsWith("."))).toEqual([]);
  });

  it("refuses when the file changed after the preview", async () => {
    const host = await fakeHost();
    await mkdir(join(host.home, ".cursor"));
    const file = join(host.home, ".cursor", "mcp.json");
    await writeFile(file, "{}\n");
    const change = { client: "cursor", action: "connect", proposalTools: true } as const;
    const preview = await previewChange(host, change, LAUNCH);
    await writeFile(file, '{"mcpServers": {}}\n');
    await expect(applyChange(host, change, LAUNCH, preview.token)).rejects.toMatchObject({
      reason: "changed",
    });
    expect(await readFile(file, "utf8")).toBe('{"mcpServers": {}}\n');
  });

  it("writes through a symlinked config and keeps the link", async () => {
    const host = await fakeHost();
    const real = join(host.home, "dotfiles-mcp.json");
    await writeFile(real, "{}\n");
    await mkdir(join(host.home, ".cursor"));
    const link = join(host.home, ".cursor", "mcp.json");
    await symlink(real, link);
    const change = { client: "cursor", action: "connect", proposalTools: false } as const;
    await applyChange(host, change, LAUNCH, (await previewChange(host, change, LAUNCH)).token);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(real, "utf8")).mcpServers.openmail.command).toBe(
      LAUNCH.command,
    );
  });

  it("uses Claude Code's own CLI with a fixed argv, removing a stale entry first", async () => {
    const host = await fakeHost();
    const cli = await fakeCli(host, "claude");
    const config = join(host.home, ".claude.json");
    const mine = { command: "/old", autoApprove: ["search"] };
    const write = (startups: number, entry: unknown) =>
      writeFile(
        config,
        `${JSON.stringify({ numStartups: startups, mcpServers: { openmail: entry } })}\n`,
      );
    await write(1, mine);
    const launch = { ...LAUNCH, env: { OPENMAIL_HOME: "/tmp/a b; rm -rf ~" } };
    const change = { client: "claude-code", action: "connect", proposalTools: true } as const;
    const preview = await previewChange(host, change, launch);
    const entry = {
      command: LAUNCH.command,
      autoApprove: ["search"],
      args: ["--mcp", "--allow-writes"],
      env: { OPENMAIL_HOME: "/tmp/a b; rm -rf ~" },
    };
    expect(preview.commands).toEqual([
      [cli, "mcp", "remove", "--scope", "user", "openmail"],
      [cli, "mcp", "add-json", "--scope", "user", "openmail", JSON.stringify(entry)],
    ]);
    expect(preview.backup).toBe(false);
    // Claude Code rewrites the rest of its file all the time; only the entry has to stay put.
    await write(2, mine);
    await applyChange(host, change, launch, preview.token);
    expect(await calls(host)).toEqual(preview.commands.map((argv) => argv.slice(1)));
    // The CLI does the edit, so OpenMail saves no copy of the file.
    expect((await readdir(host.home)).filter((name) => name.includes("openmail-backup"))).toEqual(
      [],
    );
    await write(3, { command: "/x" });
    await expect(applyChange(host, change, launch, preview.token)).rejects.toMatchObject({
      reason: "changed",
    });
  });

  it("reports a CLI that exits 0 but writes nothing as failed, for connect and disconnect", async () => {
    for (const name of ["claude", "codex"] as const) {
      const host = await fakeHost();
      await fakeCli(host, name, 0, { writes: false });
      const client = name === "claude" ? "claude-code" : "codex";
      const connect = { client, action: "connect", proposalTools: false } as const;
      const preview = await previewChange(host, connect, RUNNABLE);
      expect(preview.commands.length).toBeGreaterThan(0);
      const error = await applyChange(host, connect, RUNNABLE, preview.token).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(AiClientError);
      expect(error).toMatchObject({
        reason: "cliFailed",
        detail: expect.stringContaining("no openmail entry"),
      });
    }
    const host = await fakeHost();
    await fakeCli(host, "claude", 0, { writes: false });
    await writeFile(
      join(host.home, ".claude.json"),
      JSON.stringify({ mcpServers: { openmail: { command: RUNNABLE.command, args: ["--mcp"] } } }),
    );
    const disconnect = {
      client: "claude-code",
      action: "disconnect",
      proposalTools: false,
    } as const;
    const removal = await previewChange(host, disconnect, RUNNABLE);
    await expect(applyChange(host, disconnect, RUNNABLE, removal.token)).rejects.toMatchObject({
      reason: "cliFailed",
      detail: expect.stringContaining("still in its config"),
    });
  });

  it("reports done only when the config read back shows the change", async () => {
    for (const name of ["claude", "codex"] as const) {
      const host = await fakeHost();
      await fakeCli(host, name);
      const client = name === "claude" ? "claude-code" : "codex";
      const connect = { client, action: "connect", proposalTools: false } as const;
      const preview = await previewChange(host, connect, RUNNABLE);
      await applyChange(host, connect, RUNNABLE, preview.token);
      expect((await clientView(host, client, RUNNABLE)).state).toBe("connected");
      const disconnect = { ...connect, action: "disconnect" } as const;
      const removal = await previewChange(host, disconnect, RUNNABLE);
      await applyChange(host, disconnect, RUNNABLE, removal.token);
      expect((await clientView(host, client, RUNNABLE)).state).toBe("notConnected");
    }
  });

  it("puts Claude Code's old entry back when the add fails after the remove", async () => {
    const host = await fakeHost();
    await fakeCli(host, "claude", 2, { failOn: "add-json" });
    const old = { type: "stdio", command: "/old", args: [], env: {} };
    await writeFile(
      join(host.home, ".claude.json"),
      JSON.stringify({ mcpServers: { openmail: old } }),
    );
    const change = { client: "claude-code", action: "connect", proposalTools: false } as const;
    const preview = await previewChange(host, change, LAUNCH);
    const error = await applyChange(host, change, LAUNCH, preview.token).catch((e: unknown) => e);
    expect(error).toMatchObject({ reason: "cliFailed" });
    const log = await calls(host);
    expect(log.map((argv) => (Array.isArray(argv) ? argv[1] : null))).toEqual([
      "remove",
      "add-json",
      "add-json",
    ]);
    expect(log[2]).toEqual(["mcp", "add-json", "--scope", "user", "openmail", JSON.stringify(old)]);
  });

  it("finds CLIs in version manager folders, never in a per-shell folder", async () => {
    const host = await fakeHost();
    const fnm = join(host.home, ".local", "share", "fnm");
    const install = join(fnm, "node-versions", "v22.1.0", "installation");
    await fakeCli(host, "claude", 0, { dir: join(install, "bin") });
    await mkdir(join(fnm, "aliases"), { recursive: true });
    await symlink(install, join(fnm, "aliases", "default"));
    const nvm = join(host.home, ".nvm");
    for (const version of ["v9.0.0", "v20.1.0", "v20.10.0", "v21.0.0"])
      await fakeCli(host, "codex", 0, { dir: join(nvm, "versions", "node", version, "bin") });
    await mkdir(join(nvm, "alias"), { recursive: true });
    await writeFile(join(nvm, "alias", "default"), "20\n");
    const views = await clientViews(host, LAUNCH);
    expect(views[0]?.cliPath).toBe(join(await realpath(install), "bin", "claude"));
    expect(views[1]?.cliPath).toBe(join(nvm, "versions", "node", "v20.10.0", "bin", "codex"));
  });

  it("counts an entry whose command is gone as stale", async () => {
    const host = await fakeHost();
    await mkdir(join(host.home, ".cursor"));
    const file = join(host.home, ".cursor", "mcp.json");
    const gone = { ...LAUNCH, command: join(host.home, "gone", "node") };
    await writeFile(file, JSON.stringify({ mcpServers: { openmail: gone } }));
    expect((await clientView(host, "cursor", gone)).state).toBe("stale");
    await writeFile(file, JSON.stringify({ mcpServers: { openmail: RUNNABLE } }));
    expect((await clientView(host, "cursor", RUNNABLE)).state).toBe("connected");
  });

  it("keeps the newest five backups, counting same-second copies as numbers", async () => {
    const host = await fakeHost();
    const dir = join(host.home, ".cursor");
    await mkdir(dir);
    const file = join(dir, "mcp.json");
    await writeFile(file, "{}\n");
    const stamp = "mcp.json.openmail-backup-20261012-123456";
    for (const suffix of ["", "-2", "-3", "-9", "-10"])
      await writeFile(join(dir, `${stamp}${suffix}`), "{}\n");
    await writeFile(join(dir, "mcp.json.openmail-backup-20261011-000000"), "{}\n");
    const change = { client: "cursor", action: "connect", proposalTools: false } as const;
    await applyChange(host, change, LAUNCH, (await previewChange(host, change, LAUNCH)).token);
    const left = (await readdir(dir)).filter((name) => name.includes("backup"));
    expect(left.toSorted()).toEqual(
      [`${stamp}-10`, `${stamp}-11`, `${stamp}-2`, `${stamp}-3`, `${stamp}-9`].toSorted(),
    );
  });

  it("reconnects Codex by editing the file, keeping the entry's own keys", async () => {
    const host = await fakeHost();
    const cli = await fakeCli(host, "codex");
    await mkdir(join(host.home, ".codex"));
    const file = join(host.home, ".codex", "config.toml");
    await writeFile(file, '[mcp_servers.openmail]\ncommand = "/old"\nstartup_timeout_sec = 30\n');
    const change = { client: "codex", action: "connect", proposalTools: false } as const;
    const preview = await previewChange(host, change, LAUNCH);
    expect(preview.commands).toEqual([]);
    expect(preview.backup).toBe(true);
    await applyChange(host, change, LAUNCH, preview.token);
    expect(readTomlEntry(await readFile(file, "utf8"))).toEqual({
      command: LAUNCH.command,
      startup_timeout_sec: 30,
      args: ["--mcp"],
    });
    expect(await calls(host)).toEqual([]);
    const disconnect = { ...change, action: "disconnect" } as const;
    const removal = await previewChange(host, disconnect, LAUNCH);
    expect(removal.commands).toEqual([[cli, "mcp", "remove", "openmail"]]);
  });

  it("uses codex mcp add and reports a failing CLI", async () => {
    const host = await fakeHost();
    const cli = await fakeCli(host, "codex", 3);
    const change = { client: "codex", action: "connect", proposalTools: false } as const;
    const preview = await previewChange(host, change, LAUNCH);
    expect(preview.commands).toEqual([
      [cli, "mcp", "add", "openmail", "--", LAUNCH.command, "--mcp"],
    ]);
    expect(preview.backup).toBe(false);
    const error = await applyChange(host, change, LAUNCH, preview.token).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiClientError);
    expect(error).toMatchObject({ reason: "cliFailed", detail: "boom" });
  });

  it("disconnects by removing only the entry", async () => {
    const host = await fakeHost();
    await mkdir(join(host.home, ".codex"));
    const file = join(host.home, ".codex", "config.toml");
    const before = 'model = "x"\n\n[mcp_servers.openmail]\ncommand = "/old"\nargs = []\n';
    await writeFile(file, before);
    const change = { client: "codex", action: "disconnect", proposalTools: false } as const;
    const preview = await previewChange(host, change, LAUNCH);
    expect(preview.diff.filter((line) => line.kind === "remove").map((line) => line.text)).toEqual([
      "[mcp_servers.openmail]",
      'command = "/old"',
      "args = []",
      "",
    ]);
    await applyChange(host, change, LAUNCH, preview.token);
    expect(await readFile(file, "utf8")).toBe('model = "x"\n');
  });
});

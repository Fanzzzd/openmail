import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
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

/** A stand-in CLI that records its argv, one JSON array per line. */
async function fakeCli(host: AiClientsHost, name: string, exitCode = 0) {
  const dir = join(host.home, ".local", "bin");
  await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  await writeFile(
    file,
    `#!${process.execPath}\nrequire("fs").appendFileSync(process.env.FAKE_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");\nprocess.stderr.write("boom\\n");\nprocess.exit(${exitCode});\n`,
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
    expect(() => editJson('{"mcpServers": []}', { command: "x" })).toThrow(/not a JSON object/);
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
      JSON.stringify({ mcpServers: { openmail: { type: "stdio", ...withWrites(LAUNCH, true) } } }),
    );
    await mkdir(join(host.home, ".codex"));
    await writeFile(
      join(host.home, ".codex", "config.toml"),
      '[mcp_servers.openmail]\ncommand = "/old"\n',
    );
    await mkdir(join(host.home, ".cursor"));
    await writeFile(join(host.home, ".cursor", "mcp.json"), "{ not json");
    const views = await clientViews(host, LAUNCH);
    expect(views.map((v) => [v.id, v.installed, v.method, v.state, v.proposalTools])).toEqual([
      ["claude-code", true, "cli", "connected", true],
      ["codex", true, "file", "stale", false],
      ["claude-desktop", false, "file", "notConnected", false],
      ["cursor", true, "file", "unreadable", false],
    ]);
    expect(views[3]?.problem).toBeTruthy();
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
    const preview = await previewChange(host, change, LAUNCH);
    expect(preview.commands).toEqual([]);
    expect(preview.backup).toBe(true);
    expect(
      preview.diff.filter((line) => line.kind === "add").map((line) => line.text.trim()),
    ).toContain('"command": "/Applications/OpenMail.app/Contents/MacOS/OpenMail",');
    await applyChange(host, change, LAUNCH, preview.token);
    const after = JSON.parse(await readFile(file, "utf8"));
    expect(after.theme).toBe("dark");
    expect(after.mcpServers.other).toEqual({ command: "o" });
    expect(after.mcpServers.openmail).toEqual({ ...LAUNCH, args: ["--mcp"] });
    expect((await stat(file)).mode & 0o777).toBe(0o640);
    const backups = (await readdir(dir)).filter((name) => name.includes(".openmail-backup-"));
    expect(backups).toEqual(["claude_desktop_config.json.openmail-backup-20261012-123456"]);
    expect(await readFile(join(dir, backups[0]!), "utf8")).toBe(before);
    expect((await clientView(host, "claude-desktop", LAUNCH)).state).toBe("connected");
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
    await writeFile(
      config,
      `${JSON.stringify({ mcpServers: { openmail: { command: "/old" } } }, null, 2)}\n`,
    );
    const launch = { ...LAUNCH, env: { OPENMAIL_HOME: "/tmp/a b; rm -rf ~" } };
    const change = { client: "claude-code", action: "connect", proposalTools: true } as const;
    const preview = await previewChange(host, change, launch);
    expect(preview.commands).toEqual([
      [cli, "mcp", "remove", "--scope", "user", "openmail"],
      [
        cli,
        "mcp",
        "add",
        "--scope",
        "user",
        "--transport",
        "stdio",
        "openmail",
        "-e",
        "OPENMAIL_HOME=/tmp/a b; rm -rf ~",
        "--",
        LAUNCH.command,
        "--mcp",
        "--allow-writes",
      ],
    ]);
    await applyChange(host, change, launch, preview.token);
    expect(await calls(host)).toEqual(preview.commands.map((argv) => argv.slice(1)));
    // OpenMail backs the file up even though the CLI does the edit.
    expect(
      (await readdir(host.home)).some((name) => name.startsWith(".claude.json.openmail-backup-")),
    ).toBe(true);
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

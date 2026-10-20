// scripts/setup-oauth.sh saved clients to the installed app's data folder while CONTRIBUTING
// ran the dev app with --user-data-dir. These runs answer no to every question, so the wizard
// exits before it opens a browser or calls the CLI; they check only which folder it uses.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const script = new URL("../../setup-oauth.sh", import.meta.url);
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** A checkout with the script and a stand-in for the built CLI, and an empty HOME. */
function checkout() {
  // Real path: bash resolves the working folder, and macOS tmpdir() is a symlink.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "openmail-setup-oauth-")));
  directories.push(root);
  mkdirSync(join(root, "repo", "scripts"), { recursive: true });
  mkdirSync(join(root, "repo", "packages", "cli", "dist"), { recursive: true });
  copyFileSync(script, join(root, "repo", "scripts", "setup-oauth.sh"));
  writeFileSync(join(root, "repo", "packages", "cli", "dist", "cli.js"), "process.exit(1);\n");
  mkdirSync(join(root, "home"));
  return root;
}

function wizard(root: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const { OPENMAIL_HOME: _home, XDG_DATA_HOME: _xdg, ...inherited } = process.env;
  const result = spawnSync("bash", [join(root, "repo", "scripts", "setup-oauth.sh"), ...args], {
    cwd: root,
    env: { ...inherited, HOME: join(root, "home"), ...env },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const installedFolder = (home: string) =>
  process.platform === "darwin"
    ? join(home, "Library", "Application Support", "openmail")
    : join(home, ".local", "share", "openmail");

it("parses as bash", () => {
  expect(spawnSync("bash", ["-n", script.pathname]).status).toBe(0);
});

it("uses the folder argument, relative to where it runs, and reads config.json from it", () => {
  const root = checkout();
  mkdirSync(join(root, "dev"));
  writeFileSync(join(root, "dev", "config.json"), JSON.stringify({ google: { clientId: "x" } }));
  const run = wizard(root, ["dev"], { OPENMAIL_HOME: join(root, "other") });
  expect(run.code, run.stderr).toBe(0);
  expect(run.stdout).toContain(`Data folder: ${join(root, "dev")}\n`);
  expect(run.stdout).toContain("A Google client is already saved.");
  expect(run.stdout).not.toContain("installed OpenMail");
  expect(run.stdout).toContain("Nothing selected. Exiting.");
});

it("uses OPENMAIL_HOME without an argument", () => {
  const root = checkout();
  const run = wizard(root, [], { OPENMAIL_HOME: join(root, "OpenMail-dev") });
  expect(run.code, run.stderr).toBe(0);
  expect(run.stdout).toContain(`Data folder: ${join(root, "OpenMail-dev")}\n`);
  expect(run.stdout).not.toContain("installed OpenMail");
});

it("names the installed app's folder as such, and writes nothing on the way out", () => {
  const root = checkout();
  const run = wizard(root, []);
  expect(run.code, run.stderr).toBe(0);
  expect(run.stdout).toContain(`Data folder: ${installedFolder(join(root, "home"))}\n`);
  expect(run.stdout).toContain("This is the installed OpenMail's data folder.");
  expect(readdirSync(join(root, "home"))).toEqual([]);
});

it("refuses more than one folder or an unknown flag", () => {
  const root = checkout();
  for (const args of [["a", "b"], ["--folder"]]) {
    const run = wizard(root, args);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("Usage: scripts/setup-oauth.sh [data-folder]");
  }
  const help = wizard(root, ["--help"]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("Usage: scripts/setup-oauth.sh [data-folder]");
});

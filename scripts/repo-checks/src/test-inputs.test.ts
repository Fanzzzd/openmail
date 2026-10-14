import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, matchesGlob, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { expect, it } from "vitest";

// Turbo hashes a package's own files. A test that reads a file outside its package replays a
// stale cached pass when that file changes, unless the file is a `$TURBO_ROOT$` input of the
// package's test task or belongs to a workspace dependency, whose build hash covers it already.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const TURBO_ROOT = "$TURBO_ROOT$/";

/** Reads that stay out of the hash on purpose, with the reason. */
const EXEMPT: ReadonlySet<string> = new Set([
  // Opt-in on-device inference under OPENMAIL_TEST_MODELS=1, an env input of the task.
  // Hashing hundreds of MB of git-ignored model weights on every run would cost more than
  // a forced rerun.
  "@openmail/core#test reads spikes/media/models",
  // The default catalog root of i18n-missing.mjs. Mobile passes its own src/locales.
  "@openmail/mobile#test reads apps/desktop/src/renderer/src/locales",
]);

const Task = Schema.Struct({
  inputs: Schema.optional(Schema.Array(Schema.String)),
  cache: Schema.optional(Schema.Boolean),
});
const Turbo = Schema.Struct({ tasks: Schema.Record(Schema.String, Task) });
const Manifest = Schema.Struct({
  name: Schema.String,
  scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
type Manifest = typeof Manifest.Type;

const turbo = Schema.decodeUnknownSync(Schema.fromJsonString(Turbo))(
  readFileSync(join(root, "turbo.json"), "utf8"),
);
const packages = ["apps", "packages"].flatMap((group) =>
  readdirSync(join(root, group))
    .map((name) => join(group, name))
    .filter((dir) => existsSync(join(root, dir, "package.json")))
    .map((dir) => ({
      dir,
      manifest: Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(
        readFileSync(join(root, dir, "package.json"), "utf8"),
      ),
    })),
);
const packageDir = new Map(packages.map(({ dir, manifest }) => [manifest.name, dir]));

const inside = (dir: string, path: string) => path === dir || path.startsWith(`${dir}/`);
const repoPath = (absolute: string) => relative(root, absolute).split(sep).join("/");

function workspaceDependencies(manifest: Manifest): string[] {
  return Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter(([, version]) => version.startsWith("workspace:"))
    .flatMap(([name]) => packageDir.get(name) ?? []);
}

const SKIP = new Set([
  "node_modules",
  "dist",
  "out",
  ".next",
  "release",
  ".expo",
  "ios",
  "android",
]);
function testFiles(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return SKIP.has(entry.name) ? [] : testFiles(path);
    return /\.test\.[cm]?[jt]sx?$|^vitest\..*config\.[cm]?[jt]s$/.test(entry.name) ||
      path.includes("/test-support/")
      ? [path]
      : [];
  });
}

const LITERAL = /(["'`])((?:\.\.\/)+[^"'`\s$]*|[\w.@-]+(?:\/[\w.@*-]+)+\/?)\1/g;
const SCRIPT_FILE = /\.[cm]?js$/;

/**
 * Existing repo paths outside `dir` named in `file`. Scripts that the file loads or runs are
 * followed, unless they belong to a workspace dependency, whose build hash covers them already.
 */
function outsideReads(
  dir: string,
  dependencies: readonly string[],
  file: string,
  seen = new Set<string>(),
): string[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const source = readFileSync(join(root, file), "utf8");
  const own = inside(dir, file);
  const reads: string[] = [];
  for (const [, , literal = ""] of source.matchAll(LITERAL)) {
    const upward = literal.startsWith("../");
    // Root scripts name repo paths from the root; package tests only count upward paths.
    if (!upward && own) continue;
    const candidates = upward
      ? [resolve(root, dirname(file), literal), resolve(root, dir, literal)]
      : [resolve(root, literal)];
    // A path that does not exist is test data, such as a hostile attachment name.
    const target = candidates.find((path) => existsSync(path));
    if (target === undefined) continue;
    const path = repoPath(target).replace(/\/$/, "");
    if (path.startsWith("..") || dependencies.some((dependency) => inside(dependency, path)))
      continue;
    // Package scripts that a test loads, such as a build config, can name root files too.
    if (SCRIPT_FILE.test(path) && statSync(target).isFile())
      reads.push(...outsideReads(dir, dependencies, path, seen));
    if (!inside(dir, path)) reads.push(path);
  }
  return reads;
}

/** The test script plus the package scripts it runs through `pnpm <name>`. */
function testCommand(scripts: Readonly<Record<string, string>>, name = "test"): string {
  const command = scripts[name] ?? "";
  const nested = [...command.matchAll(/\bpnpm (?:run )?([\w:-]+)/g)].flatMap(([, script = ""]) =>
    script !== name && script in scripts ? [testCommand(scripts, script)] : [],
  );
  return [command, ...nested].join(" ");
}

function covered(path: string, inputs: readonly string[]): boolean {
  return inputs
    .filter((input) => input.startsWith(TURBO_ROOT))
    .map((input) => input.slice(TURBO_ROOT.length))
    .some(
      (glob) =>
        matchesGlob(path, glob) ||
        matchesGlob(`${path}/file`, glob) ||
        glob.replace(/\/\*\*$/, "") === path,
    );
}

it("files that package tests read outside their package are turbo inputs of the test task", () => {
  const gaps: string[] = [];
  for (const { dir, manifest } of packages) {
    if (!manifest.scripts?.test) continue;
    const test = testCommand(manifest.scripts);
    const task = turbo.tasks[`${manifest.name}#test`] ?? turbo.tasks.test;
    if (task?.cache === false) continue;
    const inputs = task?.inputs ?? [];
    const dependencies = workspaceDependencies(manifest);
    // The test script itself may run files outside the package, such as a shared checker.
    const scriptReads = test
      .split(/\s+/)
      .filter((token) => token.startsWith("../") && SCRIPT_FILE.test(token))
      .map((token) => repoPath(resolve(root, dir, token)));
    const reads = [
      ...scriptReads,
      ...scriptReads.flatMap((script) => outsideReads(dir, dependencies, script)),
      ...testFiles(dir).flatMap((file) => outsideReads(dir, dependencies, file)),
    ];
    for (const path of new Set(reads)) {
      const gap = `${manifest.name}#test reads ${path}`;
      if (!EXEMPT.has(gap) && !covered(path, inputs)) gaps.push(gap);
    }
  }
  expect(gaps).toEqual([]);
});

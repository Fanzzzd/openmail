// Fails when a package the desktop app ships has no license file and no section in
// docs/licenses/npm-packages-without-license.txt.
//
//   node scripts/check-licenses.mjs                 # the production closure of apps/desktop
//   node scripts/check-licenses.mjs <node_modules>  # every package under a packaged app's node_modules
//
// The closure is what electron-builder packs: apps/desktop's dependencies and optional
// dependencies, followed through workspace packages, plus peer dependencies that are
// installed (such as redis for @effect/platform-node). Workspace packages are OpenMail's own.
// After a build it also checks the packages Vite compiled into the bundles, which
// apps/desktop/bundled-licenses.ts lists in apps/desktop/out/licenses/.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const listFile = join(root, "docs/licenses/npm-packages-without-license.txt");

/** Package names with a section in the list: the line after each opening rule. */
function listedNames() {
  const lines = readFileSync(listFile, "utf8").split("\n");
  const names = new Set();
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!/^={20,}$/.test(lines[i]) || !/^={20,}$/.test(lines[i + 3] ?? "")) continue;
    for (const part of lines[i + 1].split(",")) {
      const name = part.trim().split(/\s+/)[0];
      if (name) names.add(name);
    }
  }
  return names;
}

const LICENSE_FILE = /^(licen[cs]e|copying)/i;
const hasLicenseFile = (dir) => readdirSync(dir).some((file) => LICENSE_FILE.test(file));
const readPackage = (dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

/** Node's lookup: the nearest node_modules/<name> above `from`. */
function resolvePackage(name, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    if (basename(dir) !== "node_modules") {
      const candidate = join(dir, "node_modules", name);
      if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    }
    if (dirname(dir) === dir) return null;
  }
}

/** The installed production closure of apps/desktop, as real package directories. */
function closure() {
  const seen = new Set();
  const packages = [];
  const visit = (dir) => {
    if (seen.has(dir)) return;
    seen.add(dir);
    const pkg = readPackage(dir);
    if (dir.includes("/node_modules/"))
      packages.push({ dir, name: pkg.name, version: pkg.version });
    const required = { ...pkg.dependencies };
    const optional = { ...pkg.optionalDependencies, ...pkg.peerDependencies };
    for (const [names, mustExist] of [
      [Object.keys(required), true],
      [Object.keys(optional), false],
    ])
      for (const name of names) {
        const found = resolvePackage(name, dir);
        if (found) visit(found);
        else if (mustExist && !(name in optional))
          throw new Error(`${pkg.name} depends on ${name}, which is not installed`);
      }
  };
  visit(realpathSync(join(root, "apps/desktop")));
  return packages;
}

/** Every package directory under a node_modules tree, nested ones included. */
function installed(nodeModules) {
  const packages = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".")) continue;
      const path = join(dir, entry);
      if (!statSync(path).isDirectory()) continue;
      if (entry.startsWith("@")) {
        walk(path);
        continue;
      }
      if (existsSync(join(path, "package.json"))) {
        const pkg = readPackage(path);
        packages.push({ dir: path, name: pkg.name, version: pkg.version });
      }
      if (existsSync(join(path, "node_modules"))) walk(join(path, "node_modules"));
    }
  };
  walk(nodeModules);
  return packages;
}

/** Packages compiled into the bundles, from the lists the build writes. */
function bundled() {
  const dir = join(root, "apps/desktop/out/licenses");
  if (!existsSync(dir)) return [];
  const packages = [];
  for (const file of readdirSync(dir)
    .filter((name) => name.endsWith(".txt"))
    .toSorted()) {
    const lines = readFileSync(join(dir, file), "utf8").split("\n");
    for (const [i, line] of lines.entries()) {
      if (!line.startsWith("(The package ships no license file.")) continue;
      const id = lines[i - 3] ?? "";
      const at = id.lastIndexOf("@");
      packages.push({ dir: null, name: id.slice(0, at), version: id.slice(at + 1) });
    }
  }
  return packages;
}

const target = process.argv[2];
const packages = target ? installed(resolve(target)) : [...closure(), ...bundled()];
const listed = listedNames();
const missing = [
  ...new Set(
    packages
      .filter(({ dir, name }) => !(dir && hasLicenseFile(dir)) && !listed.has(name))
      .map(({ name, version }) => `${name}@${version}`),
  ),
].toSorted();

if (missing.length) {
  console.error(
    `These packages ship no license file and have no section in ${listFile.slice(root.length)}:
${missing.map((id) => `  ${id}`).join("\n")}
Add each one with its license text from the project's repository.`,
  );
  process.exit(1);
}
console.log(
  `check-licenses: ${packages.length} packages, each has a license file or a listed notice.`,
);

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Plugin } from "vite";

/**
 * Vite inlines the npm packages a bundle imports (React, Base UI, TanStack
 * Router, Lucide and others) into out/, so the packaged app has no
 * node_modules copy of them and no license file. This plugin lists every
 * package in the bundle's module graph with its license file and NOTICE, in
 * out/licenses/<name>.txt, which electron-builder ships in
 * Contents/Resources/licenses/bundled/. A bundle without npm packages writes
 * no file. The file is sorted and has no timestamps, so a rebuild writes the
 * same bytes.
 */
export function bundledLicenses(name: string): Plugin {
  return {
    name: "openmail-bundled-licenses",
    apply: "build",
    generateBundle() {
      const packages = new Map<string, string>();
      for (const id of this.getModuleIds()) {
        const dir = packageDir(id);
        if (dir && !packages.has(dir)) packages.set(dir, describe(dir));
      }
      const entries = [...new Set(packages.values())].toSorted();
      const out = resolve(import.meta.dirname, "out/licenses");
      const file = join(out, `${name}.txt`);
      if (!entries.length) {
        rmSync(file, { force: true });
        return;
      }
      mkdirSync(out, { recursive: true });
      writeFileSync(
        file,
        `Third-party npm packages compiled into OpenMail's ${name} bundle, with their license texts.
OpenMail itself is MIT licensed; see LICENSE and THIRD_PARTY_NOTICES.md.

${entries.join("\n")}`,
      );
    },
  };
}

const NODE_MODULES = "/node_modules/";

/** The package directory under node_modules a module id belongs to, or null for app code. */
function packageDir(id: string): string | null {
  const path = id.replace(/^\0/, "").split("?")[0] ?? "";
  const at = path.lastIndexOf(NODE_MODULES);
  if (at < 0) return null;
  const rest = path.slice(at + NODE_MODULES.length).split("/");
  const scoped = rest[0]?.startsWith("@");
  const parts = rest.slice(0, scoped ? 2 : 1);
  if (parts.length < (scoped ? 2 : 1)) return null;
  const dir = path.slice(0, at + NODE_MODULES.length) + parts.join("/");
  return existsSync(join(dir, "package.json")) ? dir : null;
}

interface PackageJson {
  name?: string;
  version?: string;
  license?: string | { type?: string };
}

/** One section: name, version, declared license, then the license and notice files. */
function describe(dir: string): string {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- IO boundary: a package's own package.json.
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as PackageJson;
  const license = typeof pkg.license === "string" ? pkg.license : (pkg.license?.type ?? "unknown");
  const files = readdirSync(dir)
    .filter((file) => /^(licen[cs]e|copying|notice)/i.test(file))
    .toSorted();
  const texts = files.map(
    (file) => `--- ${file} ---\n${readFileSync(join(dir, file), "utf8").trim()}\n`,
  );
  const heading = `${pkg.name ?? dirname(dir)}@${pkg.version ?? "unknown"}`;
  return [
    `${"=".repeat(72)}\n${heading}\nLicense: ${license}\n`,
    ...(texts.length
      ? texts
      : [
          "(The package ships no license file. Its notice is in ../npm-packages-without-license.txt.)\n",
        ]),
  ].join("\n");
}

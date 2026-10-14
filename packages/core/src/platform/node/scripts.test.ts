import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The benchmark scripts in packages/core/scripts load built modules from dist.
// Each dist path must still map to a source file that exports what the script uses,
// so moving a module breaks this test instead of the script.
const root = join(import.meta.dirname, "../../..");
const scripts = readdirSync(join(root, "scripts")).filter((name) => name.endsWith(".mjs"));

const distImports = (source: string) =>
  [
    ...source.matchAll(
      /import\s*(?:\{([^}]*)\}\s*from\s*)?["'](\.\.\/dist\/[^"']+)["']|["'](\.\.\/dist\/[^"']+)["']/g,
    ),
  ].map((match) => ({
    path: match[2] ?? match[3] ?? "",
    names: (match[1] ?? "")
      .split(",")
      .map((name) => name.trim().split(/\s+as\s+/)[0] ?? "")
      .filter(Boolean),
  }));

const sourceOf = (distPath: string) => {
  const relative = distPath.replace(/^\.\.\/dist\//, "src/");
  const candidates = [relative.replace(/\.js$/, ".ts"), relative];
  return candidates.map((path) => join(root, path)).find((path) => existsSync(path));
};

describe("core scripts", () => {
  it.each(scripts)("%s imports dist modules that exist in src", (script) => {
    const source = readFileSync(join(root, "scripts", script), "utf8");
    for (const { path, names } of distImports(source)) {
      const file = sourceOf(path);
      expect(file, `${script}: ${path}`).toBeDefined();
      const text = file ? readFileSync(file, "utf8") : "";
      for (const name of names)
        expect(text, `${script}: ${path} exports ${name}`).toMatch(
          new RegExp(
            `export\\s+(?:async\\s+)?(?:const|function\\*?|class|let)\\s+${name}\\b|export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`,
          ),
        );
    }
  });
});

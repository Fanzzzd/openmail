import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

// Vitest runs in apps/desktop. A mock of a path that no longer exists silently mocks nothing.
const root = join(process.cwd(), "src");
const mockers = new Set(["mock", "doMock", "unmock", "doUnmock", "importActual", "importMock"]);

const sources = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "locales" ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });

function mockedSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "vi" &&
      mockers.has(node.expression.name.text)
    ) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument) && argument.text.startsWith("."))
        found.push(argument.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const resolves = (from: string, specifier: string) => {
  const base = resolve(dirname(from), specifier);
  return [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    base.replace(/\.js$/, ".ts"),
  ].some((candidate) => existsSync(candidate) && statSync(candidate).isFile());
};

it("every relative vi.mock and vi.doMock specifier names an existing module", () => {
  const files = sources(root);
  expect(files.length).toBeGreaterThan(100);
  const missing = files.flatMap((file) =>
    mockedSpecifiers(file)
      .filter((specifier) => !resolves(file, specifier))
      .map((specifier) => `${relative(root, file)}: ${specifier}`),
  );
  expect(missing).toEqual([]);
});

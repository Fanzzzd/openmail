import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";
import { desktopRoot } from "../test-support/paths";

const root = join(desktopRoot, "src");
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
  // `for (const name of ["./a", "./b"]) vi.doUnmock(name)` names its modules in the array.
  const loops = new Map<string, readonly string[]>();
  const visit = (node: ts.Node) => {
    if (
      ts.isForOfStatement(node) &&
      ts.isArrayLiteralExpression(node.expression) &&
      ts.isVariableDeclarationList(node.initializer) &&
      node.initializer.declarations[0] &&
      ts.isIdentifier(node.initializer.declarations[0].name)
    )
      loops.set(
        node.initializer.declarations[0].name.text,
        node.expression.elements.flatMap((element) =>
          ts.isStringLiteralLike(element) ? [element.text] : [],
        ),
      );
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "vi" &&
      mockers.has(node.expression.name.text)
    ) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument)) found.push(argument.text);
      if (argument && ts.isIdentifier(argument)) found.push(...(loops.get(argument.text) ?? []));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found.filter((specifier) => specifier.startsWith("."));
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

it("every relative vi.mock, vi.doMock and vi.doUnmock specifier names an existing module", () => {
  const files = sources(root);
  expect(files.length).toBeGreaterThan(100);
  const missing = files.flatMap((file) =>
    mockedSpecifiers(file)
      .filter((specifier) => !resolves(file, specifier))
      .map((specifier) => `${relative(root, file)}: ${specifier}`),
  );
  expect(missing).toEqual([]);
});

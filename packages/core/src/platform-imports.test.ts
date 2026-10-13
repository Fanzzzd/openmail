import { execFileSync } from "node:child_process";
import { builtinModules } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import ts from "typescript";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("./", import.meta.url));
const native = join(root, "platform", "node");
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const Config = Schema.Struct({
  overrides: Schema.Array(
    Schema.Struct({
      files: Schema.Array(Schema.String),
      rules: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
});
const Rule = Schema.Tuple([
  Schema.Literal("error"),
  Schema.Struct({ patterns: Schema.Array(Schema.Struct({ group: Schema.Array(Schema.String) })) }),
]);
const config = Schema.decodeUnknownSync(Schema.fromJsonString(Config))(
  readFileSync(resolve(root, "../../../.oxlintrc.json"), "utf8"),
);
const override = config.overrides.find((item) => item.files.includes("packages/core/src/**"));
const patterns = Schema.decodeUnknownSync(Rule)(
  override?.rules["eslint/no-restricted-imports"],
)[1].patterns.flatMap((pattern) => pattern.group);
const denied = (name: string) =>
  name.startsWith("node:") ||
  builtins.has(name) ||
  patterns.some((pattern) =>
    pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern,
  );

function imports(source: string): string[] {
  const file = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      found.push(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument)) found.push(argument.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (path === native || entry.name === "tests" || entry.name === "__tests__") return [];
    if (entry.isDirectory()) return sources(path);
    return /\.([cm]?[jt]s|tsx|jsx)$/.test(path) && !/\.(test|spec)\./.test(path) ? [path] : [];
  });
}
it("keeps native imports, exports, dynamic imports and requires inside platform/node", () => {
  const violations = sources(root).flatMap((file) =>
    imports(readFileSync(file, "utf8"))
      .filter(denied)
      .map((name) => `${relative(root, file)}: ${name}`),
  );
  expect(violations).toEqual([]);
});
it("the portable entry never loads a Node adapter through another core module", () => {
  const visited = new Set<string>();
  const violations: string[] = [];
  const visit = (file: string) => {
    if (visited.has(file)) return;
    visited.add(file);
    if (file.startsWith(`${native}/`)) {
      violations.push(relative(root, file));
      return;
    }
    for (const name of imports(readFileSync(file, "utf8"))) {
      if (denied(name)) violations.push(`${relative(root, file)}: ${name}`);
      if (name.startsWith(".")) visit(resolve(dirname(file), name.replace(/\.js$/, ".ts")));
    }
  };
  visit(join(root, "portable.ts"));
  expect(violations).toEqual([]);
  expect(visited.has(join(root, "mailbox", "mailbox-live.ts"))).toBe(true);
  expect(visited.has(join(root, "providers", "gmail", "gmail.ts"))).toBe(true);
  expect(visited.has(join(root, "providers", "outlook", "outlook.ts"))).toBe(true);
});
it("the Node entry does not load mobile adapters or mobile-only workflows", () => {
  const visited = new Set<string>();
  const violations: string[] = [];
  const mobileOnly = new Set([
    join(root, "mailbox", "mobile-background.ts"),
    join(root, "compose", "mobile-compose.ts"),
    join(root, "platform", "mail-socket.ts"),
  ]);
  const visit = (file: string) => {
    if (visited.has(file)) return;
    visited.add(file);
    if (file.startsWith(`${join(root, "platform", "react-native")}/`) || mobileOnly.has(file)) {
      violations.push(relative(root, file));
      return;
    }
    for (const name of imports(readFileSync(file, "utf8"))) {
      if (name === "postal-mime") violations.push(`${relative(root, file)}: ${name}`);
      if (name.startsWith(".")) visit(resolve(dirname(file), name.replace(/\.js$/, ".ts")));
    }
  };
  visit(join(native, "index.ts"));
  expect(violations).toEqual([]);
  expect(visited.has(join(root, "common.ts"))).toBe(true);
  expect(visited.has(join(root, "portable.ts"))).toBe(false);
});
it("checks syntax instead of matching comments or string literals", () => {
  expect(imports('// import "node:fs"\nconst text = "node:crypto";')).toEqual([]);
  expect(
    imports(
      'import type { X } from "node:fs"; export * from "imapflow/lib/foo.js"; void import("node:http"); require("nodemailer");',
    ),
  ).toEqual(["node:fs", "imapflow/lib/foo.js", "node:http", "nodemailer"]);
  expect(denied("buffer/index.js")).toBe(false);
  expect(denied("buffer")).toBe(true);
});
const nodeGlobalNames = new Set([
  "Buffer",
  "process",
  "__dirname",
  "__filename",
  "require",
  "global",
  "module",
  "exports",
]);
function nodeGlobals(source: string, allowBufferProbe = false): string[] {
  const file = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true);
  const scopes = new Map<ts.Node, Set<string>>();
  const each = (node: ts.Node, visit: (node: ts.Node) => void) => {
    visit(node);
    ts.forEachChild(node, (child) => each(child, visit));
  };
  each(file, (node) => {
    if (
      ts.isSourceFile(node) ||
      ts.isBlock(node) ||
      ts.isFunctionLike(node) ||
      ts.isCatchClause(node) ||
      ts.isClassLike(node)
    )
      scopes.set(node, new Set());
  });
  const scopeOf = (node: ts.Node | undefined) => {
    let current = node;
    while (current && !scopes.has(current)) current = current.parent;
    return current ? scopes.get(current) : undefined;
  };
  const bind = (name: ts.BindingName, scope: Set<string> | undefined) => {
    if (ts.isIdentifier(name)) scope?.add(name.text);
    else
      for (const element of name.elements)
        if (ts.isBindingElement(element)) bind(element.name, scope);
  };
  each(file, (node) => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node))
      bind(node.name, scopeOf(node.parent));
    else if (
      (ts.isImportClause(node) ||
        ts.isImportSpecifier(node) ||
        ts.isNamespaceImport(node) ||
        ts.isImportEqualsDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeParameterDeclaration(node)) &&
      node.name
    )
      bind(node.name, scopeOf(node.parent));
    else if (ts.isFunctionExpression(node) && node.name) bind(node.name, scopeOf(node));
  });
  const bound = (node: ts.Node, name: string) => {
    let current = node;
    for (;;) {
      if (scopes.get(current)?.has(name)) return true;
      if (ts.isSourceFile(current)) return false;
      current = current.parent;
    }
  };
  const found: string[] = [];
  each(file, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ts.isIdentifier(node.initializer) &&
      node.initializer.text === "globalThis" &&
      !bound(node, "globalThis")
    ) {
      for (const element of node.name.elements) {
        const property = element.propertyName ?? element.name;
        if (ts.isIdentifier(property) && nodeGlobalNames.has(property.text))
          found.push(`globalThis.${property.text}`);
      }
    }

    const globalProperty = ts.isPropertyAccessExpression(node)
      ? node.name.text
      : ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)
        ? node.argumentExpression.text
        : undefined;
    if (
      globalProperty &&
      nodeGlobalNames.has(globalProperty) &&
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "globalThis" &&
      !bound(node, "globalThis")
    ) {
      // Only the byte adapter may probe native Buffer, and only as an initializer read.
      const allowed =
        allowBufferProbe &&
        globalProperty === "Buffer" &&
        ts.isPropertyAccessExpression(node) &&
        ts.isVariableDeclaration(node.parent) &&
        ts.isIdentifier(node.parent.name) &&
        node.parent.name.text === "nativeBuffer" &&
        node.parent.initializer === node;
      if (!allowed) found.push(`globalThis.${globalProperty}`);
    }
    if (!ts.isIdentifier(node) || !nodeGlobalNames.has(node.text) || bound(node, node.text)) return;
    const parent = node.parent;
    if (
      ts.isImportSpecifier(parent) ||
      (ts.isBindingElement(parent) && parent.propertyName === node)
    )
      return;
    if (
      (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
      ((ts.isPropertyAssignment(parent) ||
        ts.isPropertyDeclaration(parent) ||
        ts.isPropertySignature(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isMethodSignature(parent) ||
        ts.isBindingElement(parent)) &&
        parent.name === node)
    )
      return;
    found.push(node.text);
  });
  return found;
}
it("portable code never depends on implicit Node globals", () => {
  const violations = sources(root).flatMap((file) =>
    nodeGlobals(readFileSync(file, "utf8"), file === join(root, "platform", "bytes.ts")).map(
      (name) => `${relative(root, file)}: ${name}`,
    ),
  );
  expect(violations).toEqual([]);
});
it("global checks respect imports and lexical bindings and only allow the byte adapter probe", () => {
  expect(nodeGlobals("const { Buffer: Bytes, process } = globalThis;")).toEqual([
    "globalThis.Buffer",
    "globalThis.process",
  ]);
  expect(
    nodeGlobals('import { Buffer as Bytes } from "./platform/bytes.js"; Bytes.from("x");'),
  ).toEqual([]);
  expect(
    nodeGlobals(
      'Buffer.from("x"); process.env.X; __dirname; require("x"); globalThis.process; globalThis["Buffer"];',
    ),
  ).toEqual([
    "Buffer",
    "process",
    "__dirname",
    "require",
    "globalThis.process",
    "globalThis.Buffer",
  ]);
  expect(
    nodeGlobals(
      'import { Buffer } from "./platform/bytes.js"; Buffer.from("x"); const process = () => 1; process(); const object = { Buffer: 1, process: 2 }; object.process;',
    ),
  ).toEqual([]);
  expect(nodeGlobals("function run(process: string) { return process; } process.env.X;")).toEqual([
    "process",
  ]);
  expect(
    nodeGlobals('// Buffer process require __dirname\nconst text = "Buffer process";'),
  ).toEqual([]);
  expect(nodeGlobals("const nativeBuffer = globalThis.Buffer;", true)).toEqual([]);
  expect(nodeGlobals("const other = globalThis.Buffer;", true)).toEqual(["globalThis.Buffer"]);
  expect(nodeGlobals("globalThis.Buffer = replacement;", true)).toEqual(["globalThis.Buffer"]);
});

it("production callers use public core entries without test support", () => {
  const cwd = resolve(root, "../../..");
  const files = execFileSync("git", ["ls-files", "apps", "packages"], { cwd, encoding: "utf8" });
  const violations: string[] = [];
  for (const file of files.trim().split("\n")) {
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    if (/^packages\/core\/|\.(test|spec)\.|\/(e2e|test-support|tests|__tests__)\//.test(file))
      continue;
    for (const name of imports(readFileSync(join(cwd, file), "utf8")))
      if (
        name === "@openmail/core/testing/node" ||
        resolve(dirname(join(cwd, file)), name).startsWith(root)
      )
        violations.push(`${file}: ${name}`);
  }
  expect(violations).toEqual([]);
});

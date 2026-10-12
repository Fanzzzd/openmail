import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { Schema } from "effect";
import ts from "typescript";
import { expect, it } from "vitest";
import { desktopRoot } from "../test-support/paths";

const root = join(desktopRoot, "src/renderer/src");
const entries = ["main.tsx", "recovery/main.tsx"];
const skipped = new Set(["locales", "e2e", "tests", "test-support"]);

type Kind = "static" | "type" | "dynamic";
interface Edge {
  readonly from: string;
  readonly to: string;
  readonly kind: Kind;
  readonly reexport: boolean;
}

const sources = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return skipped.has(entry.name) ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.(test|d)\.tsx?$/.test(entry.name) ? [path] : [];
  });

const resolveFile = (from: string, specifier: string) => {
  const base = resolve(dirname(from), specifier);
  return [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx"), base].find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  );
};

const typeOnlyImport = (node: ts.ImportDeclaration) => {
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  const bindings = clause.namedBindings;
  return (
    !clause.name &&
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly)
  );
};

function edgesOf(file: string): Edge[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest);
  const found: Edge[] = [];
  const add = (specifier: string, kind: Kind, reexport = false) => {
    if (!specifier.startsWith(".")) return;
    const to = resolveFile(file, specifier);
    if (to) found.push({ from: relative(root, file), to: relative(root, to), kind, reexport });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier))
      add(node.moduleSpecifier.text, typeOnlyImport(node) ? "type" : "static");
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const typeOnly =
        node.isTypeOnly ||
        (node.exportClause !== undefined &&
          ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.every((element) => element.isTypeOnly));
      add(node.moduleSpecifier.text, typeOnly ? "type" : "static", true);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      add(node.arguments[0].text, "dynamic");
    // typeof import("./x") in a type position.
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      add(node.argument.literal.text, "type");
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const edges = sources(root).flatMap(edgesOf);

/** Modules the window loads up front: everything statically reachable from an HTML entry. */
const eager = new Set<string>();
for (const queue = [...entries]; queue.length > 0;) {
  const file = queue.pop();
  if (file === undefined || eager.has(file)) continue;
  eager.add(file);
  for (const edge of edges) if (edge.from === file && edge.kind === "static") queue.push(edge.to);
}
const lazyTargets = new Set(edges.filter((edge) => edge.kind === "dynamic").map((e) => e.to));
const featureOf = (file: string) => /^features\/([^/]+)\//.exec(file)?.[1];

it("loads lazy screens only through import(), never from the always-loaded window", () => {
  expect(eager.size).toBeGreaterThan(100);
  expect(lazyTargets).toContain("features/settings/Settings.tsx");
  expect(lazyTargets).toContain("features/reader/body/MessageBody.tsx");
  expect([...lazyTargets].filter((file) => eager.has(file))).toEqual([]);
});

it("keeps feature indexes free of lazily loaded modules", () => {
  // A re-export runs its module for every importer of the index, so an index that names a
  // lazy-chunk module drags it into whatever imports the index.
  const indexes = sources(root)
    .map((file) => relative(root, file))
    .filter((file) => /(^|\/)index\.tsx?$/.test(file));
  expect(indexes.filter((file) => !/^features\/[^/]+\/index\.ts$/.test(file))).toEqual([]);
  const violations = edges
    .filter((edge) => indexes.includes(edge.from) && edge.reexport && edge.kind === "static")
    .filter((edge) => !eager.has(edge.to))
    .map((edge) => `${edge.from} re-exports ${edge.to}`);
  expect(violations).toEqual([]);
});

it("lets a feature reach another feature through its index, or a lazy-chunk module directly", () => {
  const violations = edges
    .filter((edge) => edge.kind !== "dynamic")
    .filter((edge) => {
      const from = featureOf(edge.from);
      const to = featureOf(edge.to);
      if (!from || !to || from === to) return false;
      return edge.to !== `features/${to}/index.ts` && eager.has(edge.to);
    })
    .map((edge) => `${edge.from} imports ${edge.to}`);
  expect(violations).toEqual([]);
});

it("applies the oxlint layer rules to import() and typeof import() too", () => {
  // oxlint's no-restricted-imports sees only import and export declarations.
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
    Schema.Struct({
      patterns: Schema.Array(Schema.Struct({ group: Schema.Array(Schema.String) })),
    }),
  ]);
  const config = Schema.decodeUnknownSync(Schema.fromJsonString(Config))(
    readFileSync(join(desktopRoot, "../../.oxlintrc.json"), "utf8"),
  );
  const prefix = "apps/desktop/src/renderer/src/";
  const forbidden = new Map<string, string[]>();
  for (const override of config.overrides) {
    const rule = override.rules["eslint/no-restricted-imports"];
    if (rule === undefined || !override.files.some((file) => file.startsWith(prefix))) continue;
    const layers = Schema.decodeUnknownSync(Rule)(rule)[1].patterns.flatMap((pattern) =>
      pattern.group.flatMap((group) => /^\*\*\/(\w[\w-]*)\/\*\*$/.exec(group)?.[1] ?? []),
    );
    for (const file of override.files) {
      const layer = file.startsWith(prefix)
        ? /^([\w-]+)\/\*\*$/.exec(file.slice(prefix.length))?.[1]
        : undefined;
      if (layer) forbidden.set(layer, layers);
    }
  }
  expect([...forbidden.keys()].toSorted()).toEqual([
    "app",
    "features",
    "i18n",
    "lib",
    "state",
    "ui",
  ]);
  const layerOf = (file: string) => file.split("/")[0] ?? "";
  const violations = edges
    .filter((edge) => forbidden.get(layerOf(edge.from))?.includes(layerOf(edge.to)))
    .map((edge) => `${edge.from} -> ${edge.to} (${edge.kind})`);
  expect(violations).toEqual([]);
});

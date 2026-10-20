import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";
import { desktopRoot } from "../test-support/paths";

const root = join(desktopRoot, "src/renderer/src");
/** The one file that may write the browser clipboard, for the web build only. */
const HELPER = "state/clipboard.ts";

const sources = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "locales" ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.(test|d)\.tsx?$/.test(entry.name) ? [path] : [];
  });

const isNavigator = (node: ts.Expression): boolean =>
  (ts.isIdentifier(node) && node.text === "navigator") ||
  (ts.isPropertyAccessExpression(node) && node.name.text === "navigator");

const memberName = (node: ts.Node) =>
  ts.isPropertyAccessExpression(node)
    ? node.name.text
    : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
      ? node.argumentExpression.text
      : undefined;

/**
 * Lines that write the system clipboard from the renderer, bypassing the main process. Only
 * `navigator.clipboard.read` and `.readText` may follow `navigator.clipboard`; anything else,
 * including an alias, counts as a write.
 */
function clipboardWrites(fileName: string, source: string): number[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const flag = (node: ts.Node) =>
    lines.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
  const visit = (node: ts.Node) => {
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      memberName(node) === "clipboard" &&
      isNavigator(node.expression)
    ) {
      const { parent } = node;
      const read =
        (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
        parent.expression === node &&
        (memberName(parent) === "read" || memberName(parent) === "readText");
      if (!read) flag(node);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      isNavigator(node.initializer) &&
      node.name.elements.some(
        (element) => (element.propertyName ?? element.name).getText(file) === "clipboard",
      )
    )
      flag(node);
    if (ts.isIdentifier(node) && node.text === "ClipboardItem") flag(node);
    if (
      ts.isCallExpression(node) &&
      memberName(node.expression) === "execCommand" &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      /^(copy|cut)$/i.test(node.arguments[0].text)
    )
      flag(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return lines;
}

it("the scan finds clipboard writes in their usual forms", () => {
  const cases = [
    "void navigator.clipboard.writeText(text);",
    "navigator.clipboard?.write([item]);",
    "window.navigator.clipboard.writeText(text);",
    'navigator["clipboard"].writeText(text);',
    "const c = navigator.clipboard; c.writeText(text);",
    "const { clipboard } = navigator;",
    "new ClipboardItem({});",
    'document.execCommand("copy");',
  ];
  for (const source of cases) expect(clipboardWrites("case.ts", source), source).not.toEqual([]);
  expect(clipboardWrites("case.ts", "void navigator.clipboard.readText();")).toEqual([]);
  expect(clipboardWrites("case.ts", 'document.execCommand("insertText", false, "x");')).toEqual([]);
});

// A hidden run keeps clipboard writes in the main process's memory (docs/testing.md). A renderer
// write through the browser API would reach the clipboard of the person at the keyboard.
it("renderer code copies only through the clipboard helper", () => {
  const found: string[] = [];
  for (const path of sources(root)) {
    const name = relative(root, path);
    if (name === HELPER) continue;
    for (const line of clipboardWrites(name, readFileSync(path, "utf8")))
      found.push(`${name}:${line}`);
  }
  expect(found).toEqual([]);
  expect(clipboardWrites(HELPER, readFileSync(join(root, HELPER), "utf8"))).toHaveLength(1);
});

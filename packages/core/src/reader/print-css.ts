/**
 * Scopes one message's sanitized CSS to its own box in a print document. The reader shows
 * each message in its own frame, but print puts every message in one document, where a
 * message's `<style>` would otherwise reach the other messages and the sender headers.
 */
import { DomUtils, ElementType, parseDocument } from "htmlparser2";
import { generate, ident, parse, walk, type CssNode } from "./css-tree-browser.js";

/** The print document's own classes. Mail selectors that name them are dropped. */
export const PRINT_CHROME_PREFIX = "om-print-";
/** Marks a message's scope box. Mail cannot set it: the sanitizer drops every data-* attribute. */
export const PRINT_SCOPE_ATTRIBUTE = "data-om-scope";

/** The selector of message `index`'s scope box. The attribute makes it unforgeable by a mail `id`. */
export const printScope = (index: number) => `#m-${index}[${PRINT_SCOPE_ATTRIBUTE}]`;

const DOCUMENT_TYPES = new Set(["html", "body", "head"]);
const DOCUMENT_PSEUDO = new Set(["root", "scope", "host", "host-context", "has"]);

type Children = Extract<CssNode, { type: "StyleSheet" }>["children"];

/** A selector that targets the document, the print chrome or another message's box. */
const outsideMessage = (selector: CssNode, nested: boolean) => {
  let found = false;
  walk(selector, (node) => {
    if (
      (node.type === "TypeSelector" &&
        DOCUMENT_TYPES.has(ident.decode(node.name).replace(/^.*\|/, "").toLowerCase())) ||
      (node.type === "PseudoClassSelector" &&
        DOCUMENT_PSEUDO.has(ident.decode(node.name).toLowerCase())) ||
      (node.type === "ClassSelector" &&
        ident.decode(node.name).toLowerCase().startsWith(PRINT_CHROME_PREFIX)) ||
      (node.type === "IdSelector" && /^m-\d+$/i.test(ident.decode(node.name))) ||
      (node.type === "AttributeSelector" &&
        ident.decode(node.name.name).toLowerCase().startsWith("data-om")) ||
      // At the top level `&` means the document root.
      (node.type === "NestingSelector" && !nested)
    )
      found = true;
  });
  return found;
};

const scopeRules = (children: Children, scope: string, nested: boolean): Children =>
  children.filter((node) => {
    if (node.type === "Raw") return false;
    if (node.type === "Atrule") {
      // @page sets the margins of the whole printout.
      if (ident.decode(node.name).toLowerCase() === "page") return false;
      if (node.block) node.block.children = scopeRules(node.block.children, scope, nested);
      return true;
    }
    if (node.type !== "Rule") return true;
    if (node.prelude.type !== "SelectorList") return false;
    node.prelude.children = node.prelude.children
      .filter((selector) => selector.type === "Selector" && !outsideMessage(selector, nested))
      // Nested rules already sit inside a scoped rule.
      .map((selector) =>
        nested ? selector : parse(`${scope} ${generate(selector)}`, { context: "selector" }),
      );
    if (node.prelude.children.isEmpty) return false;
    node.block.children = scopeRules(node.block.children, scope, true);
    return true;
  });

/** `css`, already sanitized, with every rule limited to descendants of `scope`. */
export function scopePrintCss(css: string, scope: string): string {
  try {
    const ast = parse(css, { context: "stylesheet", parseCustomProperty: true });
    if (ast.type !== "StyleSheet") return "";
    ast.children = scopeRules(ast.children, scope, false);
    // Same guard as the sanitizer: CSS strings can contain '<'.
    return generate(ast).replace(/<(?=\/style(?:[\s/>]|$))/gi, "\\3c ");
  } catch {
    return "";
  }
}

/** Sanitized message HTML with each `<style>` element scoped by `scopePrintCss`. */
export function scopePrintHtml(html: string, scope: string): string {
  const document = parseDocument(html);
  for (const style of DomUtils.getElementsByTagName("style", document.children, true))
    for (const child of style.children)
      if (child.type === ElementType.Text) child.data = scopePrintCss(child.data, scope);
  return DomUtils.getOuterHTML(document);
}

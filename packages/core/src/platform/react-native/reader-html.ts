import { DomUtils, parseDocument } from "htmlparser2";

/** Remove form subtrees before mobile WebView rendering; Android POST navigation can bypass its hook. */
export function stripMobileForms(html: string): string {
  const document = parseDocument(html);
  const strip = (parent: Pick<typeof document, "children">): void => {
    parent.children = parent.children.filter((child) => {
      if ("name" in child && child.name.toLowerCase() === "form") return false;
      if ("children" in child) strip(child);
      return true;
    });
  };
  strip(document);
  return DomUtils.getOuterHTML(document);
}

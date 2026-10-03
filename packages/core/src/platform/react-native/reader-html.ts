import { DomUtils, parseDocument } from "htmlparser2";
import { flattenHtmlChildren, MAX_HTML_DEPTH } from "../../html-depth.js";

/** Remove forms and automatic navigation/resource hints before mobile WebView rendering. */
export function stripMobileForms(html: string): string {
  const document = parseDocument(html);
  const strip = (parent: Pick<typeof document, "children">, depth = 0): void => {
    if (depth >= MAX_HTML_DEPTH)
      parent.children = flattenHtmlChildren(
        parent.children,
        (child) =>
          "name" in child &&
          ["form", "svg", "math", "textarea", "xmp", "plaintext", "noscript"].includes(child.name),
      );
    parent.children = parent.children.filter((child) => {
      if ("name" in child && "attribs" in child) {
        const name = child.name.toLowerCase();
        if (["form", "svg", "math", "textarea", "xmp", "plaintext", "noscript"].includes(name))
          return false;
        if (
          name === "meta" &&
          Object.keys(child.attribs).some((key) => key.toLowerCase() === "http-equiv")
        )
          return false;
        if (name === "link" && child.attribs.rel?.trim().toLowerCase() !== "stylesheet")
          return false;
      }
      if ("children" in child) strip(child, depth + 1);
      return true;
    });
  };
  strip(document);
  return DomUtils.getOuterHTML(document);
}

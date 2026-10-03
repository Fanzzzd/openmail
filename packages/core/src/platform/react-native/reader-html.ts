import { DomUtils, parseDocument } from "htmlparser2";

/** Remove forms and automatic navigation/resource hints before mobile WebView rendering. */
export function stripMobileForms(html: string): string {
  const document = parseDocument(html);
  const strip = (parent: Pick<typeof document, "children">): void => {
    parent.children = parent.children.filter((child) => {
      if ("name" in child && "attribs" in child) {
        const name = child.name.toLowerCase();
        if (name === "form") return false;
        if (
          name === "meta" &&
          Object.keys(child.attribs).some((key) => key.toLowerCase() === "http-equiv")
        )
          return false;
        if (name === "link" && child.attribs.rel?.trim().toLowerCase() !== "stylesheet")
          return false;
      }
      if ("children" in child) strip(child);
      return true;
    });
  };
  strip(document);
  return DomUtils.getOuterHTML(document);
}

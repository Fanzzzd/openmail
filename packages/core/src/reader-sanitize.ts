import { DomUtils, parseDocument, ElementType } from "htmlparser2";
import {
  parse,
  generate,
  walk,
  ident,
  type CssNode,
  type EnterOrLeaveFn,
} from "./css-tree-browser.js";
import { flattenHtmlChildren, MAX_HTML_DEPTH } from "./html-depth.js";

// HTML-only output avoids foreign-content/raw-text mutation during browser
// reparsing. Resource preparation still runs first to resolve CID and bases.
export const READER_TAGS = [
  "html",
  "head",
  "body",
  "style",
  "p",
  "div",
  "span",
  "a",
  "area",
  "map",
  "img",
  "br",
  "hr",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "caption",
  "col",
  "colgroup",
  "font",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "strike",
  "sub",
  "sup",
  "code",
  "pre",
  "blockquote",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "section",
  "article",
  "header",
  "footer",
  "center",
  "address",
  "details",
  "summary",
  "wbr",
  "del",
  "ins",
  "small",
  "big",
  "tt",
  "kbd",
  "mark",
  "abbr",
  "cite",
  "q",
  "figure",
  "figcaption",
  "nav",
  "main",
  "aside",
  "var",
  "samp",
  "dfn",
  "bdi",
  "bdo",
] as const;
const TAGS = new Set<string>(READER_TAGS);
export const READER_ATTRIBUTES: ReadonlySet<string> = new Set(
  "alt title width height align valign bgcolor color border cellpadding cellspacing colspan rowspan dir lang class id name type start reversed open hidden aria-hidden style href src background face size nowrap hspace vspace rules frame span usemap coords shape link vlink alink text".split(
    " ",
  ),
);
export const READER_DROP: ReadonlySet<string> = new Set(
  "script iframe object embed applet frame frameset form input button select textarea option template noscript xmp plaintext svg math audio video source track canvas base meta link basefont bgsound title desc datalist noembed noframes".split(
    " ",
  ),
);
const imageData =
  /^data:image\/(?:png|jpeg|pjpeg|gif|webp|avif|bmp|x-ms-bmp|tiff|tif|x-tiff|heic|heif|ico|x-icon|vnd\.microsoft\.icon|apng|jxl|jp2|jpx|x-xbitmap|x-xpixmap);base64,[a-z\d+/=\s]*$/i;
const normalizeResource = (value: string) =>
  value
    .trim()
    .replace(
      /^data:image\/(jpg|x-png);/i,
      (_match, type: string) => `data:image/${type.toLowerCase() === "jpg" ? "jpeg" : "png"};`,
    );
const resourceAllowed = (value: string, remote: boolean) => {
  if (imageData.test(value) || value === "data:," || /^cid:[\w.@+-]+$/i.test(value)) return true;
  if (!remote) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
};
const linkAllowed = (value: string) => {
  if (value.startsWith("#")) return true;
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
};

const unsafeCssValue = (value: CssNode) => {
  let rejected = false;
  walk(value, (node) => {
    if (node.type === "Raw") rejected = true;
    if (node.type === "Function") {
      const name = ident.decode(node.name).toLowerCase();
      if (name === "expression") rejected = true;
    }
  });
  return rejected;
};

/** Parse CSS tokens before filtering resources, including escaped identifiers. */
export function sanitizeReaderCss(input: string, remote: boolean, inline = false): string {
  if (input.length > 256 * 1024) return "";
  try {
    const ast = parse(input, {
      context: inline ? "declarationList" : "stylesheet",
      parseCustomProperty: true,
    });
    const filter: EnterOrLeaveFn = function (node, item, list) {
      if (node.type === "Atrule") {
        // Only inert layout/grouping rules. Imports and font sources never load.
        if (
          !["media", "supports", "layer", "container", "page"].includes(
            ident.decode(node.name).toLowerCase(),
          ) ||
          (node.prelude && unsafeCssValue(node.prelude))
        ) {
          list.remove(item);
          return this.skip;
        }
      } else if (node.type === "Declaration") {
        if (
          ["behavior", "-moz-binding"].includes(ident.decode(node.property).toLowerCase()) ||
          unsafeCssValue(node.value)
        ) {
          list.remove(item);
          return this.skip;
        }
      } else if (node.type === "Url") {
        node.value = normalizeResource(node.value);
        if (!resourceAllowed(node.value, remote)) item.data = { type: "Identifier", name: "none" };
      } else if (
        node.type === "Function" &&
        ["url", "image", "image-set", "-webkit-image-set"].includes(
          ident.decode(node.name).toLowerCase(),
        )
      ) {
        item.data = { type: "Identifier", name: "none" };
        return this.skip;
      } else if (node.type === "Raw" || node.type === "CDO" || node.type === "CDC") {
        list.remove(item);
        return this.skip;
      }
      return null;
    };
    walk(ast, { enter: filter });
    // CSS strings can contain '<'. Never emit an HTML raw-text closing tag.
    return generate(ast).replace(/<(?=\/style(?:[\s/>]|$))/gi, "\\3c ");
  } catch {
    return "";
  }
}

/** Inert, bounded portable reader/print markup. Sandbox and CSP remain required. */
export function sanitizeReaderHtml(
  input: string,
  remote = false,
  onOmit?: (node: ReturnType<typeof parseDocument>["children"][number]) => void,
): string {
  const document = parseDocument(input);
  type Node = (typeof document.children)[number];
  const clean = (nodes: Node[], depth = 0): Node[] => {
    const flatten = depth >= MAX_HTML_DEPTH;
    if (flatten)
      nodes = flattenHtmlChildren(nodes, (node) => {
        const drop = "name" in node && READER_DROP.has(node.name);
        if (drop) onOmit?.(node);
        return drop;
      });
    return nodes.flatMap((node): Node[] => {
      if (node.type === ElementType.Text) return [node];
      if (!("name" in node) || !("attribs" in node)) return [];
      if (READER_DROP.has(node.name)) {
        onOmit?.(node);
        return [];
      }
      if (!TAGS.has(node.name)) return flatten ? [] : clean(node.children, depth + 1);
      if (node.name === "style") {
        const text = node.children.filter((child) => child.type === ElementType.Text);
        for (const child of text) child.data = sanitizeReaderCss(child.data, remote);
        node.children = text;
      } else if (!flatten) node.children = clean(node.children, depth + 1);
      for (const [key, raw] of Object.entries(node.attribs)) {
        const value =
          key === "href"
            ? raw.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "")
            : ["src", "background"].includes(key)
              ? normalizeResource(raw)
              : raw;
        if (
          (!READER_ATTRIBUTES.has(key) && !(node.name === "style" && key === "media")) ||
          (key === "href" && !linkAllowed(value)) ||
          (key === "usemap" && !value.startsWith("#")) ||
          (["src", "background"].includes(key) && !resourceAllowed(value, remote))
        )
          delete node.attribs[key];
        else if (key === "style") {
          const css = sanitizeReaderCss(value, remote, true);
          if (css) node.attribs[key] = css;
          else delete node.attribs[key];
        } else node.attribs[key] = value;
      }
      if (node.name === "body" && Object.keys(node.attribs).length) {
        const attrs = node.attribs;
        const style = sanitizeReaderCss(
          [
            attrs.bgcolor ? `background-color:${attrs.bgcolor}` : "",
            attrs.text ? `color:${attrs.text}` : "",
            attrs.style ?? "",
          ]
            .filter(Boolean)
            .join(";"),
          remote,
          true,
        );
        if (style) attrs.style = style;
        const links = [
          ["link", "link"],
          ["vlink", "visited"],
          ["alink", "active"],
        ]
          .flatMap(([attribute, pseudo]) =>
            attrs[attribute ?? ""]
              ? [
                  `.openmail-reader-body a:${pseudo}{${sanitizeReaderCss(`color:${attrs[attribute ?? ""]}`, remote, true)}}`,
                ]
              : [],
          )
          .join("");
        attrs.class = `${attrs.class ? `${attrs.class} ` : ""}openmail-reader-body`;
        if (links)
          node.children = [...parseDocument(`<style>${links}</style>`).children, ...node.children];
        node.name = "div";
      }
      if (["html", "head", "body"].includes(node.name)) return node.children;
      if (node.name === "details" || node.name === "summary") node.name = "div";
      return [node];
    });
  };
  document.children = clean(document.children);
  return DomUtils.getOuterHTML(document);
}

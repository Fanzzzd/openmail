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
import { markSearchHits } from "./search-highlight.js";

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

/** Viewport-height units. */
const VIEWPORT_HEIGHT_UNIT = /^[sld]?v[hb]$/i;
/** The smaller or larger of the viewport's width and height. */
const VIEWPORT_EXTREME_UNIT = /^([sld]?)v(min|max)$/i;

/** One node parsed from `text` in `context`; css-tree builds its own lists. */
const parsedNode = (text: string, context: "value" | "mediaQueryList") => {
  const ast = parse(text, { context });
  const first = ast.type === "Value" ? ast.children.first : undefined;
  if (first) return first;
  if (ast.type !== "MediaQueryList") throw new Error(`no node in ${text}`);
  const condition = ast.children.first?.type === "MediaQuery" && ast.children.first.condition;
  const feature = condition ? condition.children.first : undefined;
  if (!feature) throw new Error(`no node in ${text}`);
  return feature;
};

/** Lengths a media query may use, in px. Media query `em` is the initial 16 px. */
const QUERY_PX: Record<string, number> = {
  px: 1,
  em: 16,
  rem: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
  pt: 4 / 3,
  pc: 16,
};

/** A media query length in px, or null when it depends on more than the height. */
function queryLength(node: CssNode | null, height: number): number | null {
  if (node?.type === "Number") return Number(node.value) === 0 ? 0 : null;
  if (node?.type !== "Dimension") return null;
  const unit = ident.decode(node.unit).toLowerCase();
  // vmin/vmax read as the height here, as elsewhere in a prelude.
  const scale =
    VIEWPORT_HEIGHT_UNIT.test(unit) || VIEWPORT_EXTREME_UNIT.test(unit)
      ? height / 100
      : QUERY_PX[unit];
  return scale === undefined ? null : Number(node.value) * scale;
}

/** A media query ratio, `16/9` or `1.5`. */
function queryRatio(node: CssNode | null): number | null {
  if (node?.type === "Number") return Number(node.value);
  if (node?.type !== "Ratio" || node.left.type !== "Number" || node.right?.type !== "Number")
    return null;
  const ratio = Number(node.left.value) / Number(node.right.value);
  return Number.isFinite(ratio) ? ratio : null;
}

type Comparison = "<" | "<=" | ">" | ">=" | "=";
const COMPARISON: Record<string, Comparison> = { "<": "<", "<=": "<=", ">": ">", ">=": ">=" };
/** `value op name` read as `name op value`. */
const FLIPPED: Record<string, Comparison> = { "<": ">", "<=": ">=", ">": "<", ">=": "<=" };
interface Constraint {
  op: Comparison;
  value: CssNode;
}
const compare = (a: number, op: Comparison, b: number) =>
  op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : op === ">=" ? a >= b : a === b;

/**
 * A media feature as `name op value` constraints: `(min-height: 9px)` is
 * `height >= 9px`, `(9px < height < 99px)` two of them, `(height)` none.
 */
function featureConstraints(node: CssNode): { name: string; constraints: Constraint[] } | null {
  if (node.type === "Feature") {
    const full = ident.decode(node.name).toLowerCase();
    const name = full.replace(/^(?:min|max)-/, "");
    const op: Comparison = full.startsWith("min-") ? ">=" : full.startsWith("max-") ? "<=" : "=";
    return { name, constraints: node.value ? [{ op, value: node.value }] : [] };
  }
  if (node.type !== "FeatureRange") return null;
  if (node.left.type === "Identifier")
    return {
      name: ident.decode(node.left.name).toLowerCase(),
      constraints: [{ op: COMPARISON[node.leftComparison] ?? "=", value: node.middle }],
    };
  if (node.middle.type !== "Identifier") return null;
  const constraints: Constraint[] = [{ op: FLIPPED[node.leftComparison] ?? "=", value: node.left }];
  if (node.right && node.rightComparison)
    constraints.push({ op: COMPARISON[node.rightComparison] ?? "=", value: node.right });
  return { name: ident.decode(node.middle.name).toLowerCase(), constraints };
}

const ALWAYS = "(width >= 0px)";
const NEVER = "(not (width >= 0px))";

/**
 * The media feature, as CSS, with the viewport `height` px tall; null when it
 * does not depend on the height. Height features become true or false; aspect
 * ratio and orientation become the width they imply, so they still follow the
 * frame's width. A height feature that cannot be read (an unknown unit or a
 * math function) is false: rules behind it never apply.
 */
function fixedHeightFeature(node: CssNode, height: number): string | null {
  const feature = featureConstraints(node);
  if (!feature) return null;
  const { name, constraints } = feature;
  if (name === "height" || name === "device-height")
    return constraints.every(({ op, value }) => {
      const length = queryLength(value, height);
      return length !== null && compare(height, op, length);
    })
      ? ALWAYS
      : NEVER;
  const width = name.startsWith("device-") ? "device-width" : "width";
  if (name === "aspect-ratio" || name === "device-aspect-ratio") {
    const widths: string[] = [];
    for (const { op, value } of constraints) {
      const ratio = queryRatio(value);
      if (ratio === null) return NEVER;
      const px = `${Math.round(ratio * height * 100) / 100}px`;
      widths.push(op === "=" ? `(${width}: ${px})` : `(${width} ${op} ${px})`);
    }
    return widths.length > 1 ? `(${widths.join(" and ")})` : (widths[0] ?? ALWAYS);
  }
  if (name === "orientation") {
    const value = constraints[0]?.value;
    if (!value) return ALWAYS;
    const orientation = value.type === "Identifier" ? value.name.toLowerCase() : "";
    // Portrait when the height is at least the width.
    return orientation === "portrait"
      ? `(width <= ${height}px)`
      : orientation === "landscape"
        ? `(width > ${height}px)`
        : NEVER;
  }
  return null;
}

/** Evaluates every height-dependent feature in a media query list against `height`. */
function fixMediaHeight(prelude: CssNode, height: number): void {
  walk(prelude, function (node, item) {
    // Features always sit in a condition's list.
    const fixed = fixedHeightFeature(node, height);
    if (fixed) item.data = parsedNode(fixed, "mediaQueryList");
  });
}

/** A `<style media>` value with its height features fixed (see fixMediaHeight). */
function fixMediaAttribute(value: string, height: number): string {
  try {
    const ast = parse(value, { context: "mediaQueryList" });
    fixMediaHeight(ast, height);
    // Width features stay live, but their viewport units mean the frame's height.
    walk(ast, (node) => {
      if (node.type !== "Dimension") return;
      const unit = ident.decode(node.unit);
      if (!VIEWPORT_HEIGHT_UNIT.test(unit) && !VIEWPORT_EXTREME_UNIT.test(unit)) return;
      node.value = String(Math.round(Number(node.value) * height) / 100);
      node.unit = "px";
    });
    return generate(ast);
  } catch {
    return "not all";
  }
}

/**
 * Parse CSS tokens before filtering resources, including escaped identifiers.
 * With `viewportHeight`, viewport-height units become px against that height,
 * vmin and vmax the smaller or larger of the width and that height, and media
 * queries on the height are evaluated at it, so the page cannot size itself to
 * the frame showing it.
 */
export function sanitizeReaderCss(
  input: string,
  remote: boolean,
  inline = false,
  viewportHeight?: number,
): string {
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
        if (viewportHeight && node.prelude && ident.decode(node.name).toLowerCase() === "media")
          fixMediaHeight(node.prelude, viewportHeight);
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
      } else if (viewportHeight && node.type === "Dimension") {
        const unit = ident.decode(node.unit);
        const px = String(Math.round(Number(node.value) * viewportHeight) / 100);
        const extreme = VIEWPORT_EXTREME_UNIT.exec(unit);
        // An at-rule prelude (a media feature or range operand) has no list
        // item to swap for a min()/max() call, so vmin/vmax there fall back
        // to the height in px.
        if (VIEWPORT_HEIGHT_UNIT.test(unit) || (extreme && this.atrulePrelude)) {
          node.value = px;
          node.unit = "px";
        } else if (extreme)
          item.data = parsedNode(
            `${extreme[2]?.toLowerCase()}(${node.value}${extreme[1] ?? ""}vw,${px}px)`,
            "value",
          );
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

/** The viewport height the desktop reader resolves `vh` against; its frame takes its height from the page. */
export const READER_VIEWPORT_HEIGHT = 800;

/**
 * Inert, bounded portable reader/print markup. Sandbox and CSP remain required.
 * `searchTerms` marks search hits in the cleaned text (see `markSearchHits`).
 * `viewportHeight` fixes viewport-height units (see `sanitizeReaderCss`).
 */
export function sanitizeReaderHtml(
  input: string,
  remote = false,
  onOmit?: (node: ReturnType<typeof parseDocument>["children"][number]) => void,
  searchTerms: readonly string[] = [],
  viewportHeight?: number,
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
        for (const child of text)
          child.data = sanitizeReaderCss(child.data, remote, false, viewportHeight);
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
          const css = sanitizeReaderCss(value, remote, true, viewportHeight);
          if (css) node.attribs[key] = css;
          else delete node.attribs[key];
        } else if (key === "media" && viewportHeight)
          node.attribs[key] = fixMediaAttribute(value, viewportHeight);
        else node.attribs[key] = value;
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
          viewportHeight,
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
  markSearchHits(document, searchTerms);
  return DomUtils.getOuterHTML(document);
}

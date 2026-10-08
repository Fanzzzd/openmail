import { DomUtils, ElementType, parseDocument } from "htmlparser2";
import { selectAll } from "css-select";
import { parse, generate, walk, ident } from "./css-tree-browser.js";
import { sanitizeReaderHtml, sanitizeReaderCss, READER_DROP } from "./reader-sanitize.js";
import { flattenHtmlChildren, MAX_HTML_DEPTH } from "./html-depth.js";
import { visibleHtmlMarkup } from "./visible-text.js";
import { stripMessageIdBrackets } from "./message-id.js";
import { composeStyleValue } from "./compose-format.js";
import { MAX_MATCH_CHECKS } from "./visible-text-constants.js";
import { parseColour } from "./visible-text-style.js";
import { composeColourContexts } from "./compose-colours.js";

type HtmlNode = ReturnType<typeof parseDocument>["children"][number];
const ZERO_LENGTH = /^0(?:\.0+)?(?:px|pt|pc|cm|mm|in|em|rem|ex|ch|vh|vw|vmin|vmax|%)?$/i;

function defaultTextColour(value: string): boolean {
  if (value.trim().toLowerCase() === "windowtext") return true;
  const colour = parseColour(value);
  return colour?.[3] === 1 && colour[0] === colour[1] && colour[1] === colour[2] && colour[0] <= 36;
}

function stripDefaultTextColours(input: string, inline: boolean, systemOnly = false): string {
  if (!/color|windowtext|\\/i.test(input)) return input;
  try {
    const ast = parse(input, { context: inline ? "declarationList" : "stylesheet" });
    const lastColour = { value: "", important: false };
    if (inline && !systemOnly)
      walk(ast, {
        visit: "Declaration",
        enter(node) {
          if (
            ident.decode(node.property).toLowerCase() === "color" &&
            (node.important || !lastColour.important)
          ) {
            lastColour.value = generate(node.value);
            lastColour.important = Boolean(node.important);
          }
        },
      });
    walk(ast, {
      visit: "Declaration",
      enter(node, item, list) {
        const value = generate(node.value);
        if (
          systemOnly &&
          ident.decode(node.property).toLowerCase() === "color" &&
          value.toLowerCase() === "windowtext"
        ) {
          const colour = parse("#000", { context: "value" });
          if (colour.type === "Value") node.value = colour;
          return;
        }
        if (
          ident.decode(node.property).toLowerCase() === "color" &&
          !systemOnly &&
          (inline ? defaultTextColour(lastColour.value) : defaultTextColour(value))
        )
          list.remove(item);
      },
    });
    return generate(ast).replace(/<(?=\/style(?:[\s/>]|$))/gi, "\\3c ");
  } catch {
    return input;
  }
}
const TRANSPORT_PROPERTIES = new Set([
  "color",
  "background",
  "background-color",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-variant",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-align",
  "text-decoration",
  "text-decoration-line",
  "text-decoration-color",
  "text-decoration-style",
  "direction",
  "unicode-bidi",
  "white-space",
  "word-wrap",
  "overflow-wrap",
  "word-break",
  "width",
  "height",
  "min-width",
  "min-height",
  "max-width",
  "max-height",
  "display",
  "vertical-align",
  "border-collapse",
  "border-spacing",
  "table-layout",
  "list-style-type",
  "list-style-position",
  "box-sizing",
  "flex",
  "flex-direction",
  "flex-wrap",
  "flex-flow",
  "flex-basis",
  "flex-grow",
  "flex-shrink",
  "grid-template-columns",
  "grid-template-rows",
  "grid-auto-columns",
  "grid-auto-rows",
  "grid-auto-flow",
  "align-items",
  "align-content",
  "align-self",
  "justify-content",
  "justify-items",
  "justify-self",
  "gap",
  "row-gap",
  "column-gap",
]);
const TRANSPORT_FUNCTIONS = new Set([
  "rgb",
  "rgba",
  "hsl",
  "hsla",
  "calc",
  "min",
  "max",
  "clamp",
  "linear-gradient",
  "radial-gradient",
  "repeating-linear-gradient",
  "repeating-radial-gradient",
]);

/** RFC 2392 URLs and MIME part ids share one decoded representation. */
export function composeCid(source: string): string | undefined {
  if (!/^cid:/i.test(source)) return undefined;
  try {
    const id = stripMessageIdBrackets(decodeURIComponent(source.slice(4)));
    return /^[\w.@+-]+$/.test(id) ? `cid:${id}` : undefined;
  } catch {
    return undefined;
  }
}

export function sanitizeComposeCss(input: string, inline = false): string {
  const safe = sanitizeReaderCss(input, false, inline);
  const ast = parse(safe, { context: inline ? "declarationList" : "stylesheet" });
  walk(ast, function (node, item, list) {
    if (node.type === "Rule") {
      const flags = { generated: false };
      walk(node.prelude, (selector) => {
        if (
          selector.type === "ClassSelector" &&
          ident.decode(selector.name) === "openmail-reader-body"
        )
          flags.generated = true;
        if (
          (selector.type === "PseudoElementSelector" || selector.type === "PseudoClassSelector") &&
          ["before", "after"].includes(ident.decode(selector.name).toLowerCase())
        )
          flags.generated = true;
      });
      if (flags.generated) {
        list.remove(item);
        return this.skip;
      }
    }
    if (node.type !== "Declaration") return null;
    const property = ident.decode(node.property).toLowerCase();
    const flags = { resource: false };
    walk(node.value, (value) => {
      if (
        value.type === "Url" ||
        (value.type === "Function" &&
          !TRANSPORT_FUNCTIONS.has(ident.decode(value.name).toLowerCase()))
      )
        flags.resource = true;
    });
    const value = generate(node.value).toLowerCase();
    if (
      flags.resource ||
      (!TRANSPORT_PROPERTIES.has(property) &&
        !/^(?:margin|padding)(?:-(?:left|right|top|bottom|inline|block|inline-start|inline-end|block-start|block-end))?$|^border(?:-(?:left|right|top|bottom))?(?:-(?:color|style|width))?$/.test(
          property,
        )) ||
      property === "content" ||
      property.startsWith("--") ||
      /^(position|inset|left|right|top|bottom|transform|translate|scale|zoom|clip|clip-path|filter|opacity|visibility|text-indent|animation.*|transition.*)$/.test(
        property,
      ) ||
      (property === "display" && value === "none") ||
      (/^(font-size|width|height|max-width|max-height)$/.test(property) &&
        /^0(?:[a-z%]+)?$/.test(value))
    )
      list.remove(item);
    return null;
  });
  walk(ast, {
    visit: "Rule",
    leave(node, item, list) {
      if (!node.block.children.size) list.remove(item);
    },
  });
  return generate(ast).replace(/<(?=\/style(?:[\s/>]|$))/gi, "\\3c ");
}

function editableClientStyle(input: string, element?: "blockquote" | "hr"): string | undefined {
  if (!input.trim()) return "";
  let ast;
  try {
    ast = parse(input, { context: "declarationList" });
  } catch {
    return undefined;
  }
  if (ast.type !== "DeclarationList") return undefined;
  const styles: string[] = [];
  for (const node of ast.children) {
    if (node.type !== "Declaration" || node.important) return undefined;
    const property = ident.decode(node.property).toLowerCase();
    let value = generate(node.value);
    if (property === "font-size" && /^\d+(\.\d+)?pt$/i.test(value))
      value = `${Math.round(((Number.parseFloat(value) * 4) / 3) * 100) / 100}px`;
    if (
      property === "margin" &&
      value.split(/\s+/).length <= 4 &&
      value.split(/\s+/).every((part) => ZERO_LENGTH.test(part))
    )
      continue;
    if (/^margin-(?:top|bottom|left|right)$/.test(property) && ZERO_LENGTH.test(value)) continue;
    if (property === "color" && value.toLowerCase() === "windowtext") continue;
    if ((property === "color" || property === "background-color") && /^[a-z]+$/i.test(value)) {
      const colour = parseColour(value);
      if (colour?.[3] === 1) value = `rgb(${colour[0]},${colour[1]},${colour[2]})`;
    }
    if (
      element === "blockquote" &&
      ((property === "margin" && /^(?:0(?:px)? ){3}0?\.8ex$/.test(value)) ||
        (property === "border-left" && /^1px solid\s*(?:#ccc|rgb\(204,204,204\))$/i.test(value)) ||
        (property === "padding-left" && value === "1ex"))
    )
      continue;
    if (["word-wrap", "overflow-wrap"].includes(property) && value === "break-word") continue;
    if (
      ["-webkit-nbsp-mode", "line-break", "-webkit-line-break"].includes(property) &&
      ["space", "after-white-space"].includes(value)
    )
      continue;
    const supported = composeStyleValue(property, value, element === "hr" ? "hr" : undefined);
    if (supported === undefined) return undefined;
    styles.push(`${property}:${supported}`);
  }
  return styles.join(";");
}

function wordReplyBorder(style: string): boolean {
  if (!/border-top/i.test(style)) return false;
  try {
    const ast = parse(style, { context: "declarationList" });
    if (ast.type !== "DeclarationList") return false;
    const values = new Map<string, string>();
    for (const node of ast.children) {
      if (node.type !== "Declaration" || node.important) return false;
      values.set(ident.decode(node.property).toLowerCase(), generate(node.value).toLowerCase());
    }
    const padding = (values.get("padding") ?? "").split(/\s+/);
    return (
      values.size === 3 &&
      values.get("border") === "none" &&
      /^solid#e1e1e11(?:\.0+)?pt$/.test((values.get("border-top") ?? "").replace(/\s+/g, "")) &&
      padding.length === 4 &&
      /^3(?:\.0+)?pt$/.test(padding[0] ?? "") &&
      padding.slice(1).every((value) => ZERO_LENGTH.test(value))
    );
  } catch {
    return false;
  }
}

function unwrapNeutralSpans(nodes: HtmlNode[]): void {
  for (let index = nodes.length - 1; index >= 0; index--) {
    const node = nodes[index];
    if (node?.type === ElementType.Tag && node.name === "span" && !Object.keys(node.attribs).length)
      nodes.splice(index, 1, ...node.children);
  }
}

/** Normalize client defaults only when every stylesheet has a representable cascade. */
export function normalizeComposeClientNodes(nodes: HtmlNode[]): void {
  const sheets: Extract<HtmlNode, { attribs: Record<string, string> }>[] = [];
  const pending = nodes.toReversed().map((node) => ({ node, depth: 0 }));
  let count = 0;
  while (pending.length) {
    const frame = pending.pop();
    if (!frame || ++count > 20_000) return;
    if (frame.node.type === ElementType.Style) sheets.push(frame.node);
    else if (frame.node.type === ElementType.Tag && frame.depth < 128)
      for (const child of frame.node.children.toReversed())
        pending.push({ node: child, depth: frame.depth + 1 });
  }
  const rules: { selector: string; style: string; weight: number }[] = [];
  let representable = true;
  for (const sheet of sheets) {
    // A style element's own presentation does not disable its stylesheet.
    delete sheet.attribs.style;
    const css = sheet.children
      .flatMap((node) => (node.type === ElementType.Text ? [node.data] : []))
      .join("");
    try {
      if (css.length > 256 * 1024) {
        representable = false;
        break;
      }
      const ast = parse(css);
      if (ast.type !== "StyleSheet") {
        representable = false;
        break;
      }
      for (const rule of ast.children) {
        if (rule.type === "CDO" || rule.type === "CDC") continue;
        if (
          rule.type === "Atrule" &&
          ["font-face", "page"].includes(ident.decode(rule.name).toLowerCase())
        )
          continue;
        if (rule.type !== "Rule") {
          representable = false;
          break;
        }
        if (!rule.block.children.size) continue;
        walk(rule.prelude, (selector) => {
          if (selector.type === "TypeSelector") selector.name = selector.name.toLowerCase();
        });
        for (const selector of generate(rule.prelude).split(",")) {
          if (/^a:(link|visited)$/i.test(selector.trim())) continue;
          const style = editableClientStyle(
            generate(rule.block).slice(1, -1),
            /^hr(?:\.|$)/i.test(selector.trim()) ? "hr" : undefined,
          );
          if (
            style === undefined ||
            !/^(?:[a-z][\w-]*|\.[\w-]+|#[\w-]+)(?:\.[\w-]+)?$/i.test(selector.trim())
          ) {
            representable = false;
            break;
          }
          const weight =
            (selector.match(/#/g)?.length ?? 0) * 100 +
            (selector.match(/\./g)?.length ?? 0) * 10 +
            (/^[a-z]/i.test(selector) ? 1 : 0);
          rules.push({ selector: selector.trim(), style, weight });
        }
        if (!representable || rules.length * count > MAX_MATCH_CHECKS) {
          representable = false;
          break;
        }
      }
    } catch {
      representable = false;
    }
    if (!representable) break;
  }
  if (representable) {
    const inlineStyles = new Map<HtmlNode, string>();
    const sheetStyles = new Map<HtmlNode, string>();
    for (const { selector, style } of rules.toSorted((a, b) => a.weight - b.weight)) {
      let elements = selectAll(selector, nodes.slice());
      if (selector === "body" && !elements.length) {
        const existing = nodes.find(
          (node) =>
            node.type === ElementType.Tag &&
            (node.attribs.class ?? "").split(/\s+/).includes("openmail-reader-body"),
        );
        const wrapper =
          existing ?? parseDocument('<div class="openmail-reader-body"></div>').children[0];
        if (wrapper && wrapper.type === ElementType.Tag) {
          if (!existing) {
            wrapper.children = nodes.slice();
            nodes.splice(0, nodes.length, wrapper);
          }
          elements = [wrapper];
        }
      }
      for (const element of elements) {
        if (!("attribs" in element)) continue;
        if (!inlineStyles.has(element)) inlineStyles.set(element, element.attribs.style ?? "");
        const cascade = [sheetStyles.get(element), style].filter(Boolean).join(";");
        sheetStyles.set(element, cascade);
        element.attribs.style = [cascade, inlineStyles.get(element)].filter(Boolean).join(";");
      }
    }
    for (const sheet of sheets) sheet.children = [];
  }
  const normalize = (children: HtmlNode[], depth = 0): void => {
    if (depth > 128) return;
    for (const node of children) {
      if (node.type !== ElementType.Tag) continue;
      if (node.name === "blockquote" && node.attribs.type === "cite") delete node.attribs.type;
      if (
        node.name === "body" ||
        (node.attribs.class ?? "").split(/\s+/).includes("openmail-reader-body")
      ) {
        delete node.attribs.lang;
        delete node.attribs.link;
        delete node.attribs.vlink;
      }
      const classes = (node.attribs.class ?? "")
        .split(/\s+/)
        .filter(
          (name) =>
            name &&
            (!representable ||
              !/^(MsoNormal|MsoHyperlink(?:Followed)?|MsoChpDefault|WordSection\d+|EmailStyle\d+)$/i.test(
                name,
              )),
        );
      if (classes.length) node.attribs.class = classes.join(" ");
      else delete node.attribs.class;
      if (node.name === "hr") delete node.attribs.tabindex;
      if (node.name === "div" && wordReplyBorder(node.attribs.style ?? "")) {
        delete node.attribs.style;
        const rule = parseDocument("<hr>").children[0];
        if (rule) node.children.unshift(rule);
      }
      if (node.name === "a" && node.attribs.name === "_MailAutoSig" && !node.attribs.href) {
        delete node.attribs.name;
        node.name = "span";
      }
      if (node.name === "img" && composeCid(node.attribs.src ?? "")) {
        delete node.attribs["apple-inline"];
        delete node.attribs.id;
      }
      if (node.name === "font") {
        const family = node.attribs.face
          ? composeStyleValue("font-family", node.attribs.face)
          : undefined;
        const size = node.attribs.size ? Number(node.attribs.size) : undefined;
        const legacySize =
          size !== undefined && Number.isInteger(size)
            ? [10, 13, 16, 18, 24, 32, 48][
                Math.min(7, Math.max(1, /^[+-]/.test(node.attribs.size ?? "") ? 3 + size : size)) -
                  1
              ]
            : undefined;
        const color = node.attribs.color
          ? composeStyleValue("color", node.attribs.color)
          : undefined;
        if (
          (!node.attribs.face || family) &&
          (!node.attribs.size || legacySize) &&
          (!node.attribs.color || color)
        ) {
          node.name = "span";
          node.attribs.style = [
            family ? `font-family:${family}` : "",
            legacySize ? `font-size:${legacySize}px` : "",
            color ? `color:${color}` : "",
            node.attribs.style ?? "",
          ]
            .filter(Boolean)
            .join(";");
          delete node.attribs.face;
          delete node.attribs.size;
          delete node.attribs.color;
        }
      }
      if (node.attribs["data-smartmail"] === "gmail_signature")
        delete node.attribs["data-smartmail"];
      const style = editableClientStyle(
        node.attribs.style ?? "",
        node.name === "blockquote" ? "blockquote" : node.name === "hr" ? "hr" : undefined,
      );
      if (style !== undefined) {
        if (style) node.attribs.style = style;
        else delete node.attribs.style;
      }
      normalize(node.children, depth + 1);
    }
    unwrapNeutralSpans(children);
  };
  normalize(nodes);
}

function normalizeComposeImages(nodes: HtmlNode[], depth = 0): void {
  for (const node of nodes) {
    if (node.type === ElementType.Style) {
      for (const child of node.children)
        if (child.type === ElementType.Text)
          child.data = stripDefaultTextColours(child.data, false, true);
      continue;
    }
    if (node.type !== ElementType.Tag) continue;
    if (node.attribs.style) {
      const style = stripDefaultTextColours(node.attribs.style, true, true);
      if (style) node.attribs.style = style;
      else delete node.attribs.style;
    }
    if (node.name === "img") {
      const cid = composeCid(node.attribs.src ?? "");
      if (cid) node.attribs.src = cid;
    }
    if (depth >= MAX_HTML_DEPTH)
      node.children = flattenHtmlChildren(
        node.children,
        (child) => "name" in child && READER_DROP.has(child.name),
      );
    normalizeComposeImages(node.children, depth + 1);
  }
}

function cleanTransportNodes(nodes: HtmlNode[]): HtmlNode[] {
  return nodes.filter((node) => {
    if (node.type === ElementType.Style) {
      for (const child of node.children)
        if (child.type === ElementType.Text) child.data = sanitizeComposeCss(child.data);
      return node.children.some((child) => child.type === ElementType.Text && child.data.trim());
    }
    if (node.type !== ElementType.Tag) return true;
    if (node.name === "img" && !composeCid(node.attribs.src ?? "")) return false;
    delete node.attribs.background;
    const classes = (node.attribs.class ?? "")
      .split(/\s+/)
      .filter((name) => name && name !== "openmail-reader-body");
    if (classes.length) node.attribs.class = classes.join(" ");
    else delete node.attribs.class;
    if (node.attribs.style) {
      const style = sanitizeComposeCss(node.attribs.style, true);
      if (style) node.attribs.style = style;
      else delete node.attribs.style;
    }
    node.children = cleanTransportNodes(node.children);
    // Check the style first: textContent walks the subtree, which is quadratic on deep HTML.
    if (node.attribs.style && !DomUtils.textContent(node).trim()) {
      const ast = parse(node.attribs.style, { context: "declarationList" });
      walk(ast, {
        visit: "Declaration",
        enter(declaration, item, list) {
          if (ident.decode(declaration.property).toLowerCase() === "color") list.remove(item);
        },
      });
      const style = generate(ast);
      if (style) node.attribs.style = style;
      else delete node.attribs.style;
      delete node.attribs.color;
    }
    if (node.attribs.style === "") delete node.attribs.style;
    return true;
  });
}

function normalizeImportedTextColours(nodes: HtmlNode[]): void {
  const contexts = composeColourContexts(nodes);
  // Leave unresolved stylesheet colours intact until the client cascade is inlined.
  const stylesheetColours = [...contexts.keys()].some(
    (node) =>
      node.type === ElementType.Style &&
      node.children.some(
        (child) => child.type === ElementType.Text && /color|\\/i.test(child.data),
      ),
  );
  for (const [node, context] of contexts) {
    if (node.type !== ElementType.Tag) continue;
    if (node.attribs.style && !context.protectedBackground && !stylesheetColours) {
      const style = stripDefaultTextColours(node.attribs.style, true);
      if (style) node.attribs.style = style;
      else delete node.attribs.style;
    }
    if (
      node.attribs.color &&
      defaultTextColour(node.attribs.color) &&
      !context.protectedBackground &&
      !stylesheetColours
    )
      delete node.attribs.color;
    if (context.inheritedDefault && defaultTextColour(context.inheritedDefault))
      node.attribs.style = [node.attribs.style, `color:${context.inheritedDefault}`]
        .filter(Boolean)
        .join(";");
  }
}
export function composeSourceHtml(input: string, onHiddenText?: () => void): string {
  const nodes = parseDocument(input).children;
  normalizeComposeImages(nodes);
  try {
    normalizeImportedTextColours(nodes);
  } catch {
    onHiddenText?.();
    return "";
  }
  // Inspect the original hiding styles before reducing CSS or resource attributes.
  const visible = visibleHtmlMarkup(DomUtils.getOuterHTML(nodes), onHiddenText);
  const clean = parseDocument(sanitizeReaderHtml(visible, false)).children;
  normalizeComposeClientNodes(clean);
  const transport = cleanTransportNodes(clean);
  normalizeComposeClientNodes(transport);
  const result = cleanTransportNodes(transport);
  try {
    normalizeImportedTextColours(result);
  } catch {
    onHiddenText?.();
    return "";
  }
  // Client inlining can expose default colours; inspect their final paint before transport.
  const finalVisible = visibleHtmlMarkup(DomUtils.getOuterHTML(result), onHiddenText);
  const finalNodes = cleanTransportNodes(parseDocument(finalVisible).children);
  normalizeComposeClientNodes(finalNodes);
  return DomUtils.getOuterHTML(cleanTransportNodes(finalNodes), { encodeEntities: "utf8" });
}

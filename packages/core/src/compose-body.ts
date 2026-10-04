import { parseDocument, ElementType } from "htmlparser2";
import {
  COMPOSE_FONT_FAMILIES,
  COMPOSE_FONT_SIZES,
  type ComposeFont,
  type OutgoingMessage,
} from "./domain.js";

import { composeStyle, composeStyleValue } from "./compose-format.js";

export type ComposeBody =
  | { kind: "plain"; text: string }
  | { kind: "markdown"; text: string }
  | { kind: "rich"; text: string; html: string; originalHtml?: string; font?: ComposeFont };
type RichBody = Extract<ComposeBody, { kind: "rich" }>;
type HtmlNode = ReturnType<typeof parseDocument>["children"][number];
type SafeNode =
  | { kind: "text"; value: string }
  | { kind: "tag"; name: string; attrs: Record<string, string>; children: SafeNode[] };

export function escapeComposeText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
export function composeLink(value: string): string | undefined {
  const href = value.trim();
  for (let index = 0; index < href.length; index++) {
    const code = href.charCodeAt(index);
    if (code <= 32 || (code >= 127 && code <= 159)) return undefined;
  }
  if (!/^(https?:\/\/|mailto:)/i.test(href)) return undefined;
  try {
    const url = new URL(href);
    if (url.protocol === "mailto:") return url.pathname ? href : undefined;
    return url.hostname && !url.username && !url.password ? href : undefined;
  } catch {
    return undefined;
  }
}
const DROP_CONTENT = new Set([
  "script",
  "style",
  "head",
  "title",
  "iframe",
  "object",
  "embed",
  "svg",
  "math",
  "template",
  "noscript",
  "audio",
  "video",
  "canvas",
]);
const BLOCKS = new Set([
  "p",
  "div",
  "section",
  "article",
  "header",
  "footer",
  "blockquote",
  "pre",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "tr",
]);
const LISTS = new Set(["ul", "ol", "li"]);
const NEUTRAL_TAGS = new Set(["html", "body", "br", "a", "span"]);
const INLINE = new Map([
  ["b", "strong"],
  ["strong", "strong"],
  ["i", "em"],
  ["em", "em"],
  ["u", "u"],
  ["s", "s"],
  ["strike", "s"],
  ["sub", "sub"],
  ["sup", "sup"],
  ["code", "code"],
]);
const RICH_TAGS = new Set(["span", "div", "pre", "blockquote", "ul", "ol", "li", "br"]);
function richAttrs(name: string, attrs: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  const style = composeStyle(attrs.style ?? "")
    .split(";")
    .filter((declaration) => name !== "span" || !declaration.startsWith("text-decoration:"))
    .join(";");
  if (style) result.style = style;
  if (attrs.dir === "ltr" || attrs.dir === "rtl" || attrs.dir === "auto") result.dir = attrs.dir;
  if (
    (name === "ul" && ["disc", "dash"].includes(attrs.type ?? "")) ||
    (name === "ol" && ["1", "a", "A", "i", "I"].includes(attrs.type ?? ""))
  )
    result.type = attrs.type ?? "";
  return result;
}
const REMOTE_TAGS = new Set([
  "p",
  "div",
  "span",
  "font",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "img",
  "pre",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
]);
const REMOTE_STYLES = new Map([
  ["color", /^(#[a-f\d]{3,8}|[a-z]+|rgba?\([\d.,% ]+\))$/i],
  ["background-color", /^(#[a-f\d]{3,8}|[a-z]+|rgba?\([\d.,% ]+\))$/i],
  ["font-weight", /^(normal|bold|[1-9]00)$/],
  ["font-style", /^(normal|italic)$/],
  ["text-decoration", /^(none|underline|line-through)$/],
  ["text-align", /^(left|right|center|justify)$/],
  ["font-size", /^\d+(\.\d+)?(px|pt|em|rem|%)$/],
  ["white-space", /^(normal|pre|pre-wrap|pre-line)$/],
  ["width", /^\d+(\.\d+)?(px|pt|em|rem|%)$/],
  ["height", /^\d+(\.\d+)?(px|pt|em|rem|%)$/],
]);
function spanMarks(style: string): string[] {
  const marks: string[] = [];
  for (const declaration of style.toLowerCase().split(";")) {
    const [property, value] = declaration.split(":").map((s) => s.trim());
    if (property === "font-weight" && /^(bold|[7-9]00)$/.test(value ?? "")) marks.push("strong");
    if (property === "font-style" && value === "italic") marks.push("em");
    if (property === "text-decoration") {
      const decoration = composeStyleValue(property, value ?? "");
      if (decoration?.includes("underline")) marks.push("u");
      if (decoration?.includes("line-through")) marks.push("s");
    }
  }
  return marks;
}
function remoteAttrs(name: string, attrs: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  const style = (attrs.style ?? "").split(";").flatMap((declaration) => {
    const [property, value] = declaration.split(":").map((s) => s.trim().toLowerCase());
    return property && value && REMOTE_STYLES.get(property)?.test(value)
      ? [`${property}:${value}`]
      : [];
  });
  if (style.length) result.style = style.join(";");
  if (name === "img") {
    const source = attrs.src ?? "";
    const safe = composeLink(source);
    if (safe && /^https?:/i.test(safe)) result.src = safe;
    else if (/^cid:[\w.@+-]+$/i.test(source)) result.src = source;
    if (attrs.alt) result.alt = attrs.alt;
  }
  for (const key of [
    "width",
    "height",
    "colspan",
    "rowspan",
    "border",
    "cellpadding",
    "cellspacing",
  ]) {
    if (/^\d{1,5}%?$/.test(attrs[key] ?? "")) result[key] = attrs[key] ?? "";
  }
  if (name === "font" && /^(#[a-f\d]{3,8}|[a-z]+)$/i.test(attrs.color ?? ""))
    result.color = attrs.color ?? "";
  return result;
}

// Transport-only defaults are recognized as an exact prefix, never as general editor CSS.
const QUOTE_TRANSPORT_STYLE = "border-left:2px solid #ccc;padding-left:12px;margin-left:0";
const DASH_TRANSPORT_STYLE = "list-style-type:none";
const DASH_TRANSPORT_PREFIX = "– ";
function stripTransportStyle(style: string, prefix: string): string | undefined {
  const declarations = style.split(";").filter((declaration) => declaration.trim());
  const expected = prefix.split(";");
  if (
    !expected.every((declaration, index) => {
      const raw = declarations[index] ?? "";
      const colon = raw.indexOf(":");
      return (
        colon >= 0 &&
        `${raw.slice(0, colon).trim().toLowerCase()}:${raw
          .slice(colon + 1)
          .trim()
          .toLowerCase()}` === declaration
      );
    })
  )
    return undefined;
  return declarations.slice(expected.length).join(";");
}
/** Restore the semantic editor representation before sanitizing or checking remote editability. */
function parseComposeNodes(input: string): HtmlNode[] {
  const nodes = parseDocument(input).children;
  const normalize = (children: HtmlNode[], depth = 0) => {
    if (depth > 128) return;
    for (const node of children) {
      if (node.type !== ElementType.Tag) continue;
      const { name, attribs } = node;
      let style: string | undefined;
      if (name === "blockquote")
        style = stripTransportStyle(attribs.style ?? "", QUOTE_TRANSPORT_STYLE);
      if (name === "ul" && attribs.type === "dash") {
        const items = node.children.flatMap((child) =>
          child.type === ElementType.Tag && child.name === "li" ? [child] : [],
        );
        if (
          items.every(
            (item) =>
              item.children[0]?.type === ElementType.Text &&
              item.children[0].data.startsWith(DASH_TRANSPORT_PREFIX),
          )
        ) {
          style = stripTransportStyle(attribs.style ?? "", DASH_TRANSPORT_STYLE);
          if (style !== undefined)
            for (const item of items) {
              const first = item.children[0];
              if (first?.type === ElementType.Text)
                first.data = first.data.slice(DASH_TRANSPORT_PREFIX.length);
            }
        }
      }
      if (style === "") delete attribs.style;
      else if (style !== undefined) attribs.style = style;
      normalize(node.children, depth + 1);
    }
  };
  normalize(nodes);
  return nodes;
}

/** Builds allow-listed nodes only. Whitespace follows normal HTML, including across inline tags. */
function composeNodes(input: string, preserveRemote = false): SafeNode[] {
  const space = { pending: false, lineStart: true };
  const reset = () => {
    space.pending = false;
    space.lineStart = true;
  };
  const text = (value: string, target: SafeNode[], pre: boolean) => {
    if (pre) {
      if (space.pending) target.push({ kind: "text", value: "\u00a0" });
      const lines = value.replace(/\r\n?/g, "\n").replaceAll("\t", "    ").split("\n");
      for (const [index, line] of lines.entries()) {
        if (index) target.push({ kind: "tag", name: "br", attrs: {}, children: [] });
        if (line) target.push({ kind: "text", value: line.replaceAll(" ", "\u00a0") });
      }
      space.lineStart = value.endsWith("\n");
      space.pending = false;
      return;
    }
    for (const part of value.split(/([\t\n\r\f ]+)/)) {
      if (!part) continue;
      if (/^[\t\n\r\f ]+$/.test(part)) {
        space.pending = !space.lineStart;
        continue;
      }
      target.push({ kind: "text", value: `${space.pending ? " " : ""}${part}` });
      space.pending = false;
      space.lineStart = false;
    }
  };
  const visit = (nodes: HtmlNode[], pre = false, depth = 0): SafeNode[] => {
    if (depth > 128) return [];
    const result: SafeNode[] = [];
    for (const node of nodes) {
      if (node.type === ElementType.Text) {
        text(node.data, result, pre);
        continue;
      }
      if (node.type !== ElementType.Tag) continue;
      if (DROP_CONTENT.has(node.name)) continue;
      const { name, attribs } = node;
      if (name === "html" || name === "body") {
        for (const child of visit(node.children, pre, depth + 1)) result.push(child);
        continue;
      }
      const block = BLOCKS.has(name) || LISTS.has(name) || name === "table";
      if (block || name === "br") reset();
      let children = visit(node.children, pre || name === "pre" || name === "code", depth + 1);
      if (name === "span" && !preserveRemote) {
        for (const mark of spanMarks(attribs.style ?? "").toReversed())
          children = [{ kind: "tag", name: mark, attrs: {}, children }];
      }
      if (block || name === "br") reset();
      const inline = INLINE.get(name);
      const tag =
        inline ??
        (RICH_TAGS.has(name)
          ? name
          : preserveRemote && REMOTE_TAGS.has(name)
            ? name
            : block
              ? "div"
              : undefined);
      if (name === "a") {
        const href = composeLink(attribs.href ?? "");
        if (href)
          result.push({
            kind: "tag",
            name: "a",
            attrs: {
              href,
              ...richAttrs(name, attribs),
              ...(/^[a-f0-9-]{36}$/.test(attribs["data-compose-mention"] ?? "")
                ? { "data-compose-mention": attribs["data-compose-mention"] ?? "" }
                : {}),
            },
            children,
          } satisfies SafeNode);
        else for (const child of children) result.push(child);
      } else if (!preserveRemote && name === "img" && /^cid:[\w.@+-]+$/i.test(attribs.src ?? "")) {
        result.push({
          kind: "tag",
          name: "img",
          attrs: {
            src: attribs.src ?? "",
            ...(attribs.alt ? { alt: attribs.alt } : {}),
            ...(/^[1-9]\d{0,3}$/.test(attribs.width ?? "") ? { width: attribs.width ?? "" } : {}),
          },
          children: [],
        });
      } else if (tag) {
        if (name === "span" && !preserveRemote && !Object.keys(richAttrs(name, attribs)).length) {
          for (const child of children) result.push(child);
          continue;
        }
        result.push({
          kind: "tag",
          name: tag,
          attrs: preserveRemote ? transportAttrs(name, attribs) : richAttrs(name, attribs),
          children,
        });
      } else for (const child of children) result.push(child);
    }
    return result;
  };
  return capComposeNodes(closeSiblingListItems(visit(parseComposeNodes(input))));
}

/** Semantic marks can expand a single input span into several tags; cap the emitted tree too. */
function capComposeNodes(nodes: SafeNode[], depth = 0): SafeNode[] {
  if (depth > 128) return [];
  return nodes.map((node) =>
    node.kind === "text" ? node : { ...node, children: capComposeNodes(node.children, depth + 1) },
  );
}
function transportAttrs(name: string, attribs: Record<string, string>): Record<string, string> {
  const remote = remoteAttrs(name, attribs);
  const rich = richAttrs(name, attribs);
  const styles = new Map<string, string>();
  for (const declaration of [remote.style ?? "", rich.style ?? ""].join(";").split(";")) {
    const colon = declaration.indexOf(":");
    if (colon >= 0) styles.set(declaration.slice(0, colon), declaration.slice(colon + 1));
  }
  const ordered = new Map<string, string>();
  for (const declaration of (attribs.style ?? "").split(";")) {
    const property = declaration.slice(0, declaration.indexOf(":")).trim().toLowerCase();
    const value = styles.get(property);
    if (value !== undefined) ordered.set(property, value);
  }
  return {
    ...remote,
    ...rich,
    ...(ordered.size ? { style: [...ordered].map(([p, v]) => `${p}:${v}`).join(";") } : {}),
  };
}
/** Removing table/unknown wrappers can expose a second li inside the first one. */
function closeSiblingListItems(nodes: SafeNode[]): SafeNode[] {
  const result: SafeNode[] = [];
  const stack: Extract<SafeNode, { kind: "tag" }>[] = [];
  const visit = (children: SafeNode[]) => {
    for (const node of children) {
      if (node.kind === "text") {
        (stack.at(-1)?.children ?? result).push(node);
        continue;
      }
      if (node.name === "li") {
        for (let index = stack.length - 1; index >= 0; index--) {
          const ancestor = stack[index];
          if (ancestor?.name === "ul" || ancestor?.name === "ol") break;
          if (ancestor?.name === "li") {
            stack.length = index;
            break;
          }
        }
      }
      const repaired = { ...node, children: [] } satisfies Extract<SafeNode, { kind: "tag" }>;
      (stack.at(-1)?.children ?? result).push(repaired);
      stack.push(repaired);
      visit(node.children);
      if (stack.at(-1) === repaired) stack.pop();
    }
  };
  visit(nodes);
  return result;
}
function serializeNodes(nodes: SafeNode[]): string {
  return nodes
    .map((node): string => {
      if (node.kind === "text") return escapeComposeText(node.value);
      const attributes = Object.entries(node.attrs)
        .map(([key, value]) => ` ${key}="${escapeComposeText(value)}"`)
        .join("");
      return `<${node.name}${attributes}>${node.name === "br" || node.name === "img" || node.name === "hr" ? "" : `${serializeNodes(node.children)}</${node.name}>`}`;
    })
    .join("");
}
function plainNodes(nodes: SafeNode[], alternatives = true): string {
  let text = "";
  const lists: { ordered: boolean; number: number }[] = [];
  const boundary = () => {
    if (text && !text.endsWith("\n")) text += "\n";
  };
  const walk = (children: SafeNode[]) => {
    for (const node of children) {
      if (node.kind === "text") {
        text += node.value.replaceAll("\u00a0", " ");
        continue;
      }
      if (node.name === "br") {
        text += "\n";
        continue;
      }
      if (node.name === "blockquote" && alternatives) {
        boundary();
        text += plainNodes(node.children, true)
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n");
        boundary();
        continue;
      }
      const block =
        node.name === "div" || node.name === "p" || LISTS.has(node.name) || BLOCKS.has(node.name);
      if (block) boundary();
      if (node.name === "ul" || node.name === "ol")
        lists.push({ ordered: node.name === "ol", number: 0 });
      if (node.name === "li" && alternatives) {
        const list = lists.at(-1);
        if (list) {
          list.number++;
          text += `${"  ".repeat(Math.max(0, lists.length - 1))}${list.ordered ? `${list.number}. ` : "- "}`;
        }
      }
      walk(node.children);
      if (node.name === "a" && alternatives) {
        const label = plainNodes(node.children, false).trim();
        if (label !== node.attrs.href) text += ` <${node.attrs.href}>`;
      }
      if (node.name === "ul" || node.name === "ol") lists.pop();
      if (block) boundary();
    }
  };
  walk(nodes);
  // Remove structural trailing newline, but keep an explicit final BR.
  const last = nodes.at(-1);
  return text.endsWith("\n") &&
    last?.kind === "tag" &&
    last.name !== "br" &&
    !serializeNodes(last.children).endsWith("<br>")
    ? text.slice(0, -1)
    : text;
}

export function richComposeBody(input: string): RichBody {
  const nodes = composeNodes(input);
  return { kind: "rich", html: serializeNodes(nodes), text: plainNodes(nodes) };
}
/** Source is never inserted in the editor. Draft metadata retains it until a real body edit. */
export function remoteComposeBody(input: string): RichBody {
  const wrapper = composeFontWrapper(
    parseDocument(input, { withStartIndices: true, withEndIndices: true }).children,
  );
  if (wrapper && wrapper.node.startIndex !== null && wrapper.node.endIndex !== null) {
    const openingEnd = input.indexOf(">", wrapper.node.startIndex) + 1;
    const closingStart = input.lastIndexOf("</", wrapper.node.endIndex);
    if (openingEnd > 0 && closingStart >= openingEnd) {
      const html = `${input.slice(0, wrapper.node.startIndex)}${input.slice(openingEnd, closingStart)}${input.slice(wrapper.node.endIndex + 1)}`;
      return { ...richComposeBody(html), originalHtml: html, font: wrapper.font };
    }
  }
  return { ...richComposeBody(input), originalHtml: input };
}
export function editedComposeBody(previous: RichBody, html: string): RichBody {
  const next = richComposeBody(html);
  return next.html === previous.html
    ? previous
    : { ...next, ...(previous.font ? { font: previous.font } : {}) };
}
export function composeEditorText(body: ComposeBody): string {
  return body.kind === "rich" ? plainNodes(composeNodes(body.html), false) : body.text;
}
/** A separate transport allow-list preserves remote tables, safe colours and images; never used as editor DOM. */
export function preservedComposeHtml(input: string): string {
  return serializeNodes(composeNodes(input, true));
}
/** Recognize only the single outer wrapper our transport emits, including MIME document framing. */
function composeFontWrapper(
  nodes: HtmlNode[],
  depth = 0,
): { node: HtmlNode; font: ComposeFont } | undefined {
  if (depth > 2) return undefined;
  const visible = nodes.filter(
    (node) =>
      !(
        node.type === ElementType.Comment ||
        node.type === ElementType.Directive ||
        (node.type === ElementType.Text && !node.data.trim()) ||
        (node.type === ElementType.Tag && node.name === "head")
      ),
  );
  const node = visible.length === 1 ? visible[0] : undefined;
  if (!node || node.type !== ElementType.Tag) return undefined;
  if (node.name === "html" || node.name === "body")
    return composeFontWrapper(node.children, depth + 1);
  if (node.name !== "div" || Object.keys(node.attribs).length !== 1) return undefined;
  const match = /^font-family:([^;]+);font-size:(\d+)px$/.exec(node.attribs.style ?? "");
  const family = COMPOSE_FONT_FAMILIES.find((candidate) => candidate === match?.[1]);
  const size = COMPOSE_FONT_SIZES.find((candidate) => String(candidate) === match?.[2]);
  return family && size ? { node, font: { family, size } } : undefined;
}
function unsupportedNodes(nodes: HtmlNode[], depth = 0, fontWrapper?: HtmlNode): boolean {
  return (
    depth > 128 ||
    nodes.some((node) => {
      if (
        node.type === ElementType.Text ||
        node.type === ElementType.Comment ||
        node.type === ElementType.Directive
      )
        return false;
      if (node.type !== ElementType.Tag) return true;
      const { name, attribs } = node;
      if (name === "head")
        return node.children.some(
          (child) =>
            child.type === ElementType.Style ||
            (child.type === ElementType.Tag && child.name === "link"),
        );
      if (name === "meta") return false;
      if (
        name === "img" &&
        /^cid:[\w.@+-]+$/i.test(attribs.src ?? "") &&
        Object.keys(attribs).every(
          (key) =>
            key === "src" ||
            key === "alt" ||
            (key === "width" && /^[1-9]\d{0,3}$/.test(attribs[key] ?? "")),
        )
      )
        return false;
      if (BLOCKS.has(name) && name !== "div" && name !== "p" && !RICH_TAGS.has(name)) return true;
      if (
        !INLINE.has(name) &&
        !BLOCKS.has(name) &&
        !LISTS.has(name) &&
        !NEUTRAL_TAGS.has(name) &&
        !RICH_TAGS.has(name)
      )
        return true;
      for (const [key, value] of Object.entries(attribs)) {
        if (node === fontWrapper && key === "style") continue;
        if (key === "href" && name === "a" && composeLink(value)) continue;
        if (key === "data-compose-mention" && name === "a" && /^[a-f0-9-]{36}$/.test(value))
          continue;
        if (key === "dir" && (value === "ltr" || value === "rtl" || value === "auto")) continue;
        if (key === "type" && richAttrs(name, { type: value }).type) continue;
        if (
          key === "style" &&
          value
            .split(";")
            .filter((s) => s.trim())
            .every((declaration) => {
              const colon = declaration.indexOf(":");
              const property = declaration.slice(0, colon).trim().toLowerCase();
              const raw = declaration.slice(colon + 1);
              return (
                colon >= 0 &&
                (composeStyleValue(property, raw) !== undefined ||
                  (name === "span" &&
                    /^(font-weight|font-style)$/.test(property) &&
                    spanMarks(declaration).length > 0 &&
                    !/[\\/!*]/.test(raw)))
              );
            })
        )
          continue;
        if (key === "class" || key === "id") continue;
        return true;
      }
      return unsupportedNodes(node.children, depth + 1, fontWrapper);
    })
  );
}
export function composeHtmlHasUnsupported(input: string): boolean {
  const nodes = parseComposeNodes(input);
  return unsupportedNodes(nodes, 0, composeFontWrapper(nodes)?.node);
}
export function textComposeHtml(text: string): string {
  return escapeComposeText(text)
    .replace(/ {2,}/g, (spaces) => "&nbsp;".repeat(spaces.length))
    .replace(/^ |(?<=\n) /g, "&nbsp;")
    .replaceAll("\n", "<br>");
}
function markdownText(text: string): string {
  return text.replaceAll("\u00a0", " ").replace(/[\\`*_[\]<>#!]/g, "\\$&");
}
function markdownMark(text: string, mark: string): string {
  const { leading, contents, trailing } = markdownWhitespace(text);
  return contents ? `${leading}${mark}${contents}${mark}${trailing}` : text;
}
/** Anchored suffix searches still backtrack quadratically on a long middle run. */
function markdownWhitespace(text: string): { leading: string; contents: string; trailing: string } {
  let start = 0;
  let end = text.length;
  while (start < end && /\s/u.test(text.charAt(start))) start++;
  while (end > start && /\s/u.test(text.charAt(end - 1))) end--;
  return {
    leading: text.slice(0, start),
    contents: text.slice(start, end),
    trailing: text.slice(end),
  };
}
function markdownNodes(nodes: SafeNode[], depth = 0): string {
  let result = "";
  const boundary = () => {
    if (result && !result.endsWith("\n")) result += "\n";
  };
  for (const [index, node] of nodes.entries()) {
    if (node.kind === "text") {
      result += markdownText(node.value);
      continue;
    }
    const contents =
      node.name === "ul" || node.name === "ol" ? "" : markdownNodes(node.children, depth);
    switch (node.name) {
      case "blockquote":
        boundary();
        result += contents
          .trimEnd()
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n");
        boundary();
        break;
      case "s":
        result += markdownMark(contents, "~~");
        break;
      case "strong":
        result += markdownMark(contents, "**");
        break;
      case "em": {
        // Underscores cannot open/close intraword emphasis in CommonMark.
        const nextNode = nodes[index + 1];
        const nextText = nextNode?.kind === "text" ? nextNode.value : "";
        const intraword =
          (!/^\s/.test(contents) && /[\p{L}\p{N}]$/u.test(result)) ||
          (!/\s$/.test(contents) && /^[\p{L}\p{N}]/u.test(nextText));
        result += markdownMark(contents, intraword ? "*" : "_");
        break;
      }
      case "a": {
        const whitespace = markdownWhitespace(contents);
        result += `${whitespace.leading}[${whitespace.contents}](${(node.attrs.href ?? "").replace(/[()\\]/g, "\\$&")})${whitespace.trailing}`;
        break;
      }
      case "br":
        result += "\n";
        break;
      case "ul":
      case "ol": {
        boundary();
        let number = 0;
        for (const child of node.children) {
          if (child.kind !== "tag" || child.name !== "li") continue;
          number++;
          const prefix = node.name === "ol" ? `${number}. ` : "- ";
          result += `${" ".repeat(depth)}${prefix}${markdownNodes(child.children, depth + prefix.length).trim()}\n`;
        }
        break;
      }
      case "pre":
        boundary();
        result += `\`\`\`\n${plainNodes(node.children, false)}\n\`\`\``;
        boundary();
        break;
      case "code":
        result += markdownMark(plainNodes(node.children, false), "`");
        break;
      case "div":
        boundary();
        result += contents;
        boundary();
        break;
      default:
        result += contents;
    }
  }
  return result;
}
export function composeConversion(
  body: ComposeBody,
  kind: ComposeBody["kind"],
): { body: ComposeBody; losesFormatting: boolean } {
  if (body.kind === kind) return { body, losesFormatting: false };
  if (body.kind !== "rich")
    return {
      body:
        kind === "rich" ? richComposeBody(textComposeHtml(body.text)) : { kind, text: body.text },
      losesFormatting: false,
    };
  const unsupported =
    body.originalHtml !== undefined && composeHtmlHasUnsupported(body.originalHtml);
  if (kind === "markdown")
    return {
      body: { kind, text: markdownNodes(composeNodes(body.html)).trimEnd() },
      losesFormatting:
        unsupported ||
        /<(u|s|sub|sup)\b|\u00a0/.test(body.html) ||
        /<[^>]*\s(?:style=|dir="(?:ltr|rtl)"|type="(?:dash|[aAiI])")/.test(body.html),
    };
  return {
    body: { kind: "plain", text: body.text },
    losesFormatting:
      unsupported ||
      /<(strong|em|u|s|sub|sup|code|pre|blockquote)\b/.test(body.html) ||
      /<[^>]*\s(?:style=|dir="(?:ltr|rtl)"|type="(?:dash|[aAiI])")/.test(body.html),
  };
}
export function outgoingComposeBody(
  message: Pick<OutgoingMessage, "text" | "html" | "markdown" | "originalHtml" | "composeFont">,
): ComposeBody {
  if (message.markdown) return { kind: "markdown", text: message.text };
  if (message.html === undefined) return { kind: "plain", text: message.text };
  const body = {
    ...richComposeBody(message.html),
    ...(message.composeFont ? { font: message.composeFont } : {}),
  };
  return message.originalHtml !== undefined &&
    richComposeBody(message.originalHtml).html === message.html
    ? { ...body, originalHtml: message.originalHtml }
    : body;
}
export function normalizeComposeMessage(message: OutgoingMessage): OutgoingMessage {
  const body = outgoingComposeBody(message);
  const { html: _html, originalHtml: _originalHtml, composeFont: _font, ...rest } = message;
  const sourced: OutgoingMessage["attachments"] = message.attachments.map((attachment) => {
    if (
      attachment.sourceMessageId === undefined ||
      attachment.contentId === undefined ||
      (body.kind === "rich" &&
        body.html.includes(`src="cid:${escapeComposeText(attachment.contentId)}"`))
    )
      return attachment;
    const { contentId: _cid, ...regular } = attachment;
    return regular;
  });
  const attachments =
    body.kind === "rich" && body.originalHtml !== undefined
      ? sourced
      : sourced.filter(
          (attachment) =>
            attachment.contentId === undefined ||
            (body.kind === "rich" &&
              body.html.includes(`src="cid:${escapeComposeText(attachment.contentId)}"`)),
        );
  return body.kind === "rich"
    ? {
        ...rest,
        attachments,
        text: body.text,
        html: body.html,
        ...(body.font ? { composeFont: body.font } : {}),
        ...(body.originalHtml === undefined ? {} : { originalHtml: body.originalHtml }),
      }
    : { ...rest, attachments };
}

/** Locate the end of a parsed opening tag without treating quoted > as a delimiter. */
function openingTagEnd(input: string, start: number): number {
  let quote = "";
  for (let index = start; index < input.length; index++) {
    const character = input.charAt(index);
    if (quote) {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") quote = character;
    else if (character === ">") return index + 1;
  }
  return input.length;
}
export function composeTransportHtml(
  message: Pick<OutgoingMessage, "html" | "composeFont">,
): string | undefined {
  if (message.html === undefined) return undefined;
  const input = message.html;
  const edits: { start: number; end: number; text: string }[] = [];
  const decorate = (
    children: HtmlNode[],
    dashedParent = false,
    existingMarkers = false,
    depth = 0,
  ) => {
    if (depth > 128) return;
    for (const node of children) {
      if (node.type !== ElementType.Tag) continue;
      const { name, attribs } = node;
      const prefix =
        name === "blockquote"
          ? QUOTE_TRANSPORT_STYLE
          : name === "ul" && attribs.type === "dash"
            ? DASH_TRANSPORT_STYLE
            : undefined;
      const remainder = prefix ? stripTransportStyle(attribs.style ?? "", prefix) : undefined;
      if (node.startIndex !== null && (prefix || (dashedParent && name === "li"))) {
        const end = openingTagEnd(input, node.startIndex);
        if (prefix) {
          const attrs = transportAttrs(name, {
            ...attribs,
            style: remainder ?? attribs.style ?? "",
          });
          attrs.style = [prefix, attrs.style].filter(Boolean).join(";");
          const attributes = Object.entries(attrs)
            .map(([key, value]) => ` ${key}="${escapeComposeText(value)}"`)
            .join("");
          edits.push({ start: node.startIndex, end, text: `<${name}${attributes}>` });
        }
        if (dashedParent && name === "li") {
          const first = node.children[0];
          if (
            !existingMarkers ||
            first?.type !== ElementType.Text ||
            !first.data.startsWith(DASH_TRANSPORT_PREFIX)
          )
            edits.push({ start: end, end, text: DASH_TRANSPORT_PREFIX });
        }
      }
      decorate(
        node.children,
        name === "ul" && attribs.type === "dash",
        remainder !== undefined,
        depth + 1,
      );
    }
  };
  decorate(parseDocument(input, { withStartIndices: true }).children);
  let cursor = 0;
  const parts: string[] = [];
  for (const edit of edits) {
    parts.push(input.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
  }
  parts.push(input.slice(cursor));
  const html = parts.join("").replace(/ data-compose-mention="[a-f0-9-]{36}"/g, "");
  const font = message.composeFont;
  return font
    ? `<div style="font-family:${font.family};font-size:${font.size}px">${html}</div>`
    : html;
}

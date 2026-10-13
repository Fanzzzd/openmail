/** Parses compose HTML into the safe node subset the editor keeps, and serializes it back to HTML or plain text. */

import { ElementType, parseDocument } from "htmlparser2";
import { composeStyle, composeStyleValue } from "./compose-format.js";
import { composeCid, sanitizeComposeCss } from "./compose-source.js";
import { COMPOSE_FONT_FAMILIES, COMPOSE_FONT_SIZES, type ComposeFont } from "../domain/changes.js";

export type HtmlNode = ReturnType<typeof parseDocument>["children"][number];
export type SafeNode =
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
  "hr",
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
const RICH_TAGS = new Set(["span", "div", "pre", "blockquote", "ul", "ol", "li", "br", "hr"]);
function richAttrs(name: string, attrs: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  const style = composeStyle(attrs.style ?? "", name === "hr" ? "hr" : undefined)
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
  if (name === "img") {
    const source = attrs.src ?? "";
    const safe = composeLink(source);
    if (safe && /^https?:/i.test(safe)) result.src = safe;
    else {
      const cid = composeCid(source);
      if (cid) result.src = cid;
    }
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
export const QUOTE_TRANSPORT_STYLE = "border-left:2px solid #ccc;padding-left:12px;margin-left:0";
export const DASH_TRANSPORT_STYLE = "list-style-type:none";
export const DASH_TRANSPORT_PREFIX = "– ";
export function stripTransportStyle(style: string, prefix: string): string | undefined {
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
export function parseComposeNodes(input: string): HtmlNode[] {
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
export function composeNodes(input: string): SafeNode[] {
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
  // `link` is true inside an <a>. HTML has no nested links: a parser closes
  // the outer one, so a nested <a> would not survive a second pass.
  const visit = (nodes: HtmlNode[], pre = false, depth = 0, link = false): SafeNode[] => {
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
      const cid = name === "img" ? composeCid(attribs.src ?? "") : undefined;
      if (name === "html" || name === "body") {
        for (const child of visit(node.children, pre, depth + 1, link)) result.push(child);
        continue;
      }
      const block = BLOCKS.has(name) || LISTS.has(name) || name === "table";
      if (block || name === "br") reset();
      let children = visit(
        node.children,
        pre || name === "pre" || name === "code",
        depth + 1,
        link || name === "a",
      );
      if (name === "span") {
        for (const mark of spanMarks(attribs.style ?? "").toReversed())
          children = [{ kind: "tag", name: mark, attrs: {}, children }];
      }
      if (block || name === "br") reset();
      const inline = INLINE.get(name);
      const tag = inline ?? (RICH_TAGS.has(name) ? name : block ? "div" : undefined);
      if (name === "a") {
        const href = link ? undefined : composeLink(attribs.href ?? "");
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
      } else if (cid !== undefined) {
        result.push({
          kind: "tag",
          name: "img",
          attrs: {
            src: cid,
            ...(attribs.alt ? { alt: attribs.alt } : {}),
            ...(/^[1-9]\d{0,3}$/.test(attribs.width ?? "") ? { width: attribs.width ?? "" } : {}),
            ...(/^[1-9]\d{0,3}$/.test(attribs.height ?? "")
              ? { height: attribs.height ?? "" }
              : {}),
          },
          children: [],
        });
      } else if (tag) {
        if (name === "span" && !Object.keys(richAttrs(name, attribs)).length) {
          for (const child of children) result.push(child);
          continue;
        }
        result.push({
          kind: "tag",
          name: tag,
          attrs: richAttrs(name, attribs),
          children,
        });
      } else for (const child of children) result.push(child);
    }
    return result;
  };
  return hoistComposeSpace(capComposeNodes(closeSiblingListItems(visit(parseComposeNodes(input)))));
}

function hoistComposeSpace(nodes: SafeNode[]): SafeNode[] {
  const result: SafeNode[] = [];
  for (const node of nodes) {
    if (node.kind === "tag") {
      node.children = hoistComposeSpace(node.children);
      const previous = result.at(-1);
      let first = node.children[0];
      let last = previous;
      if (node.name === "a") {
        while (first?.kind === "tag") first = first.children[0];
        while (last?.kind === "tag") last = last.children.at(-1);
      }
      if (
        ["strong", "em", "u", "s", "sub", "sup", "a"].includes(node.name) &&
        last?.kind === "text" &&
        /\S$/.test(last.value) &&
        first?.kind === "text" &&
        first.value.startsWith(" ")
      ) {
        if (previous?.kind === "text") previous.value += " ";
        else result.push({ kind: "text", value: " " });
        first.value = first.value.slice(1);
      }
    }
    result.push(node);
  }
  return result;
}

/** Semantic marks can expand a single input span into several tags; cap the emitted tree too. */
function capComposeNodes(nodes: SafeNode[], depth = 0): SafeNode[] {
  if (depth > 128) return [];
  return nodes.map((node) =>
    node.kind === "text" ? node : { ...node, children: capComposeNodes(node.children, depth + 1) },
  );
}
export function transportAttrs(
  name: string,
  attribs: Record<string, string>,
): Record<string, string> {
  return {
    ...remoteAttrs(name, attribs),
    ...richAttrs(name, attribs),
    ...Object.fromEntries(
      Object.entries(attribs).filter(([key]) => ["class", "id", "title"].includes(key)),
    ),
    ...(attribs.style ? { style: sanitizeComposeCss(attribs.style, true) } : {}),
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
export function serializeNodes(nodes: SafeNode[]): string {
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
export function plainNodes(nodes: SafeNode[], alternatives = true): string {
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
/** Recognize only the single outer wrapper our transport emits, including MIME document framing. */
export function composeFontWrapper(
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
export function unsupportedNodes(nodes: HtmlNode[], depth = 0, fontWrapper?: HtmlNode): boolean {
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
            (child.type === ElementType.Style &&
              child.children.some((text) => text.type === ElementType.Text && text.data.trim())) ||
            (child.type === ElementType.Tag && child.name === "link"),
        );
      if (name === "meta") return false;
      if (
        name === "img" &&
        composeCid(attribs.src ?? "") !== undefined &&
        Object.keys(attribs).every(
          (key) =>
            key === "src" ||
            key === "alt" ||
            ((key === "width" || key === "height") && /^[1-9]\d{0,3}$/.test(attribs[key] ?? "")),
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
                (composeStyleValue(property, raw, name === "hr" ? "hr" : undefined) !== undefined ||
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

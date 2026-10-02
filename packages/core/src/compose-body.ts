import { parseDocument, ElementType } from "htmlparser2";
import type { OutgoingMessage } from "./domain.js";

export type ComposeBody =
  | { kind: "plain"; text: string }
  | { kind: "markdown"; text: string }
  | { kind: "rich"; text: string; html: string; originalHtml?: string };
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
]);
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
    if (property === "text-decoration" && value === "underline") marks.push("u");
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

/** Builds allow-listed nodes only. Whitespace follows normal HTML, including across inline tags. */
function composeNodes(input: string, preserveRemote = false): SafeNode[] {
  const space = { pending: false, lineStart: true };
  const reset = () => {
    space.pending = false;
    space.lineStart = true;
  };
  const text = (value: string, target: SafeNode[], pre: boolean) => {
    if (pre) {
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
        result.push(...visit(node.children, pre, depth + 1));
        continue;
      }
      const block = BLOCKS.has(name) || LISTS.has(name) || name === "table";
      if (block || name === "br") reset();
      const children = visit(node.children, pre || name === "pre", depth + 1);
      if (block || name === "br") reset();
      const inline = INLINE.get(name);
      const tag =
        inline ??
        (LISTS.has(name) || name === "br"
          ? name
          : preserveRemote && REMOTE_TAGS.has(name)
            ? name
            : block
              ? "div"
              : undefined);
      if (name === "a") {
        const href = composeLink(attribs.href ?? "");
        result.push(
          ...(href
            ? [{ kind: "tag", name: "a", attrs: { href }, children } satisfies SafeNode]
            : children),
        );
      } else if (!preserveRemote && name === "img" && /^cid:[\w.@+-]+$/i.test(attribs.src ?? "")) {
        result.push({
          kind: "tag",
          name: "img",
          attrs: { src: attribs.src ?? "", ...(attribs.alt ? { alt: attribs.alt } : {}) },
          children: [],
        });
      } else if (tag) {
        result.push({
          kind: "tag",
          name: tag,
          attrs: preserveRemote ? remoteAttrs(name, attribs) : {},
          children,
        });
      } else if (name === "span" && !preserveRemote) {
        const marks = spanMarks(attribs.style ?? "");
        let marked = children;
        for (const mark of marks.toReversed())
          marked = [{ kind: "tag", name: mark, attrs: {}, children: marked }];
        result.push(...marked);
      } else result.push(...children);
    }
    return result;
  };
  return closeSiblingListItems(visit(parseDocument(input).children));
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
  return { ...richComposeBody(input), originalHtml: input };
}
export function editedComposeBody(previous: RichBody, html: string): RichBody {
  const next = richComposeBody(html);
  return next.html === previous.html ? previous : next;
}
export function composeEditorText(body: ComposeBody): string {
  return body.kind === "rich" ? plainNodes(composeNodes(body.html), false) : body.text;
}
/** A separate transport allow-list preserves remote tables, safe colours and images; never used as editor DOM. */
export function preservedComposeHtml(input: string): string {
  return serializeNodes(composeNodes(input, true));
}
function unsupportedNodes(nodes: HtmlNode[], depth = 0): boolean {
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
        Object.keys(attribs).every((key) => key === "src" || key === "alt")
      )
        return false;
      if (BLOCKS.has(name) && name !== "div" && name !== "p") return true;
      if (!INLINE.has(name) && !BLOCKS.has(name) && !LISTS.has(name) && !NEUTRAL_TAGS.has(name))
        return true;
      for (const [key, value] of Object.entries(attribs)) {
        if (key === "href" && name === "a" && composeLink(value)) continue;
        if (
          key === "style" &&
          name === "span" &&
          value
            .split(";")
            .filter((s) => s.trim())
            .every((s) => spanMarks(s).length > 0)
        )
          continue;
        if (key === "class" || key === "id") continue;
        return true;
      }
      return unsupportedNodes(node.children, depth + 1);
    })
  );
}
export function composeHtmlHasUnsupported(input: string): boolean {
  return unsupportedNodes(parseDocument(input).children);
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
      losesFormatting: unsupported || /<u>|\u00a0/.test(body.html),
    };
  return {
    body: { kind: "plain", text: body.text },
    losesFormatting: unsupported || /<(strong|em|u|ul|ol)>/.test(body.html),
  };
}
export function changeComposeBodyKind(body: ComposeBody, kind: ComposeBody["kind"]): ComposeBody {
  return composeConversion(body, kind).body;
}
export function outgoingComposeBody(
  message: Pick<OutgoingMessage, "text" | "html" | "markdown" | "originalHtml">,
): ComposeBody {
  if (message.markdown) return { kind: "markdown", text: message.text };
  if (message.html === undefined) return { kind: "plain", text: message.text };
  const body = richComposeBody(message.html);
  return message.originalHtml !== undefined &&
    richComposeBody(message.originalHtml).html === message.html
    ? { ...body, originalHtml: message.originalHtml }
    : body;
}
export function normalizeComposeMessage(message: OutgoingMessage): OutgoingMessage {
  const body = outgoingComposeBody(message);
  const { html: _html, originalHtml: _originalHtml, ...rest } = message;
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
        ...(body.originalHtml === undefined ? {} : { originalHtml: body.originalHtml }),
      }
    : { ...rest, attachments };
}

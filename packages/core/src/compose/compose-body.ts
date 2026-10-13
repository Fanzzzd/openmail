import type { ComposeFont, OutgoingMessage } from "../domain/changes.js";
import {
  composeFontWrapper,
  composeNodes,
  escapeComposeText,
  parseComposeNodes,
  plainNodes,
  serializeNodes,
  unsupportedNodes,
} from "./compose-nodes.js";
import { composeSourceHtml, normalizeComposeClientNodes } from "./compose-source.js";
import { parseDocument } from "htmlparser2";
import { markdownNodes } from "./compose-markdown.js";

export { composeCid } from "./compose-source.js";

export type ComposeBody =
  | { kind: "plain"; text: string }
  | { kind: "markdown"; text: string }
  | {
      kind: "rich";
      text: string;
      html: string;
      originalHtml?: string;
      font?: ComposeFont;
      hiddenTextRemoved?: true;
    };
type RichBody = Extract<ComposeBody, { kind: "rich" }>;

export function richComposeBody(input: string): RichBody {
  const nodes = composeNodes(input);
  return { kind: "rich", html: serializeNodes(nodes), text: plainNodes(nodes) };
}
/** Source is never inserted in the editor. Draft metadata retains it until a real body edit. */
export function remoteComposeBody(source: string): RichBody {
  const removal: { hiddenTextRemoved?: true } = {};
  const input = composeSourceHtml(source, () => {
    removal.hiddenTextRemoved = true;
  });
  const wrapper = composeFontWrapper(
    parseDocument(input, { withStartIndices: true, withEndIndices: true }).children,
  );
  if (wrapper && wrapper.node.startIndex !== null && wrapper.node.endIndex !== null) {
    const openingEnd = input.indexOf(">", wrapper.node.startIndex) + 1;
    const closingStart = input.lastIndexOf("</", wrapper.node.endIndex);
    if (openingEnd > 0 && closingStart >= openingEnd) {
      const html = `${input.slice(0, wrapper.node.startIndex)}${input.slice(openingEnd, closingStart)}${input.slice(wrapper.node.endIndex + 1)}`;
      return { ...richComposeBody(html), originalHtml: html, font: wrapper.font, ...removal };
    }
  }
  return { ...richComposeBody(input), originalHtml: input, ...removal };
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
/** Transport-only HTML via the reader sanitizer; never editor DOM. */
export function preservedComposeHtml(input: string): string {
  return composeSourceHtml(input);
}
export function composeHtmlHasUnsupported(input: string): boolean {
  const nodes = parseComposeNodes(input);
  normalizeComposeClientNodes(nodes);
  return unsupportedNodes(nodes, 0, composeFontWrapper(nodes)?.node);
}
export function textComposeHtml(text: string): string {
  return escapeComposeText(text)
    .replace(/ {2,}/g, (spaces) => "&nbsp;".repeat(spaces.length))
    .replace(/^ |(?<=\n) /g, "&nbsp;")
    .replaceAll("\n", "<br>");
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
      /<(strong|em|u|s|sub|sup|code|pre|blockquote|hr)\b/.test(body.html) ||
      /<[^>]*\s(?:style=|dir="(?:ltr|rtl)"|type="(?:dash|[aAiI])")/.test(body.html),
  };
}
export function outgoingComposeBody(
  message: Pick<
    OutgoingMessage,
    "text" | "html" | "markdown" | "originalHtml" | "composeFont" | "hiddenTextRemoved"
  >,
): ComposeBody {
  if (message.markdown) return { kind: "markdown", text: message.text };
  if (message.html === undefined) return { kind: "plain", text: message.text };
  if (message.originalHtml !== undefined) {
    const original = remoteComposeBody(message.originalHtml);
    if (
      original.html === message.html ||
      richComposeBody(message.originalHtml).html === message.html
    )
      return {
        ...original,
        ...(message.composeFont ? { font: message.composeFont } : {}),
        ...(message.hiddenTextRemoved ? { hiddenTextRemoved: true } : {}),
      };
  }
  return {
    ...richComposeBody(message.html),
    ...(message.composeFont ? { font: message.composeFont } : {}),
    ...(message.hiddenTextRemoved ? { hiddenTextRemoved: true } : {}),
  };
}
export function normalizeComposeMessage(message: OutgoingMessage): OutgoingMessage {
  const body = outgoingComposeBody(message);
  const {
    html: _html,
    originalHtml: _originalHtml,
    composeFont: _font,
    hiddenTextRemoved: _hidden,
    ...rest
  } = message;
  const attachmentHtml = body.kind === "rich" ? (body.originalHtml ?? body.html) : "";
  const rawAttachmentHtml =
    message.originalHtml === undefined ? "" : richComposeBody(message.originalHtml).html;
  const sourced: OutgoingMessage["attachments"] = message.attachments.map((attachment) => {
    if (attachment.contentId === undefined) return attachment;
    const reference = `src="cid:${escapeComposeText(attachment.contentId)}"`;
    if (attachmentHtml.includes(reference)) return attachment;
    if (
      attachment.sourceMessageId !== undefined ||
      (body.kind === "rich" &&
        body.originalHtml !== undefined &&
        !rawAttachmentHtml.includes(reference))
    ) {
      const { contentId: _cid, ...regular } = attachment;
      return regular;
    }
    return attachment;
  });
  const attachments = sourced.filter(
    (attachment) =>
      attachment.contentId === undefined ||
      attachmentHtml.includes(`src="cid:${escapeComposeText(attachment.contentId)}"`),
  );
  return body.kind === "rich"
    ? {
        ...rest,
        attachments,
        text: body.text,
        html: body.html,
        ...(body.font ? { composeFont: body.font } : {}),
        ...(body.originalHtml === undefined ? {} : { originalHtml: body.originalHtml }),
        ...(body.hiddenTextRemoved ? { hiddenTextRemoved: true } : {}),
      }
    : { ...rest, attachments };
}

/** The HTML a message is sent with: editor-only markup made portable, and signatures placed. */

import type { OutgoingMessage } from "../domain/changes.js";
import {
  DASH_TRANSPORT_PREFIX,
  DASH_TRANSPORT_STYLE,
  QUOTE_TRANSPORT_STYLE,
  escapeComposeText,
  stripTransportStyle,
  transportAttrs,
  type HtmlNode,
} from "./compose-nodes.js";
import { ElementType, parseDocument } from "htmlparser2";
import { richComposeBody, textComposeHtml, type ComposeBody } from "./compose-body.js";
import type { NamedSignatureInput } from "./signatures.js";
import {
  DEFAULT_SIGNATURE_OPTIONS,
  applySignature,
  quoteOffset,
  type SignatureOptions,
} from "./compose-text.js";

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
          // Mail clients recognise a cited blockquote as quoted text; the editor drops it again.
          if (name === "blockquote") attrs.type = "cite";
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

/**
 * Uses the editor sanitizer for every insertion. Authored formatting outside the signature survives.
 * It lives here, not in signatures.ts, so importing the signature schemas does not load the HTML cleaner.
 */
export function applyComposeSignature(
  body: ComposeBody,
  previous: Pick<NamedSignatureInput, "text" | "html"> | undefined,
  next: Pick<NamedSignatureInput, "text" | "html"> | undefined,
  options: SignatureOptions = DEFAULT_SIGNATURE_OPTIONS,
): ComposeBody {
  if (body.kind !== "rich")
    return { ...body, text: applySignature(body.text, previous?.text, next?.text, options) };
  const rich = (html: string) => ({
    ...richComposeBody(html),
    ...(body.font ? { font: body.font } : {}),
  });
  const block = (
    signature: Pick<NamedSignatureInput, "text" | "html">,
    separator = options.signatureSeparator,
  ) =>
    richComposeBody(
      `<div>${separator ? "-- <br>" : ""}${richComposeBody(signature.html ?? textComposeHtml(signature.text)).html}</div>`,
    ).html;
  const quote = body.text.slice(quoteOffset(body.text)).split("\n")[0] ?? "";
  const quoteIndex = quote ? body.html.indexOf(textComposeHtml(quote)) : -1;
  const blockquoteIndex = body.html.indexOf("<blockquote>");
  const quotedAt =
    [quoteIndex, blockquoteIndex].filter((index) => index >= 0).toSorted((a, b) => a - b)[0] ?? -1;
  const ownEnd = quotedAt < 0 ? body.html.length : quotedAt;
  const candidates = previous?.text.trim()
    ? [
        block(previous, true),
        block(previous, false),
        richComposeBody(textComposeHtml(`-- \n${previous.text.trim()}`)).html,
      ]
    : [];
  const candidateAt = (candidate: string) => {
    for (
      let index = body.html.indexOf(candidate);
      index >= 0;
      index = body.html.indexOf(candidate, index + 1)
    ) {
      const end = index + candidate.length;
      // A prior below-quote signature is replaceable only at the end, never inside a quote.
      const prefix = body.html.slice(0, index);
      const belowQuote =
        prefix.endsWith("</blockquote><br><br>") ||
        (options.signaturePosition === "below" && prefix.endsWith("<br><br>"));
      if (end <= ownEnd || (belowQuote && /^(?:<br>|<\/div>|\s)*$/.test(body.html.slice(end))))
        return index;
    }
    return -1;
  };
  const old = candidates.find((candidate) => candidateAt(candidate) >= 0) ?? "";
  const replacement = next?.text.trim() ? block(next) : "";
  const at = old ? candidateAt(old) : -1;
  if (at >= 0) {
    if (next && quotedAt >= 0 && at < quotedAt !== (options.signaturePosition === "above")) {
      const removed = applyComposeSignature(body, previous, undefined, options);
      return removed === body ? body : applyComposeSignature(removed, undefined, next, options);
    }
    const updated = rich(body.html.slice(0, at) + replacement + body.html.slice(at + old.length));
    if (body.originalHtml === undefined) return updated;
    // A signature outside the retained remote source can change without editing that source.
    if (body.originalHtml.startsWith(old))
      return { ...updated, originalHtml: replacement + body.originalHtml.slice(old.length) };
    if (body.originalHtml.endsWith(old))
      return { ...updated, originalHtml: body.originalHtml.slice(0, -old.length) + replacement };
    return body;
  }
  if (!replacement || /(?:^|\n)-- ?(?:\n|$)/.test(body.text.slice(0, quoteOffset(body.text))))
    return body;
  // Remote source stays transport-only. Its editor projection has already dropped remote images.
  if (body.originalHtml !== undefined) {
    if (options.signaturePosition === "below") {
      const suffix = rich(`${body.html}<br><br>${replacement}`);
      return { ...suffix, originalHtml: `${body.originalHtml}<br><br>${replacement}` };
    }
    const prefix = rich(`${replacement}<br><br>${body.html}`);
    return { ...prefix, originalHtml: `${replacement}<br><br>${body.originalHtml}` };
  }
  return rich(
    quotedAt >= 0 && options.signaturePosition === "above"
      ? `${body.html.slice(0, quotedAt)}${replacement}<br><br>${body.html.slice(quotedAt)}`
      : `${body.html}<br><br>${replacement}`,
  );
}

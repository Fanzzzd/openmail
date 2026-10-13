import { sha256Hex } from "../platform/crypto.js";
import { Schema } from "effect";
import { ElementType, parseDocument } from "htmlparser2";

import { composeTransportHtml } from "./compose-body.js";
import { renderMarkdown } from "./markdown.js";

export const MarkdownDraftSource = Schema.Struct({
  version: Schema.Literal(1),
  text: Schema.String,
  bodyFingerprint: Schema.String,
});
export type MarkdownDraftSource = typeof MarkdownDraftSource.Type;

/** Fingerprinting is not rendering: retain all body markup so external formatting edits invalidate the source. */
export function draftBodyFingerprint(html: string): string {
  type HtmlNode = ReturnType<typeof parseDocument>["children"][number];
  const depthFingerprint = draftTextFingerprint(html);
  const canonical = (nodes: HtmlNode[], depth = 0): unknown[] => {
    if (depth > 128) return ["depth-limit", depthFingerprint];
    return nodes.flatMap((node): unknown[] => {
      if (node.type === ElementType.Text) return [["text", node.data.replace(/\r\n?/g, "\n")]];
      if (
        node.type !== ElementType.Tag &&
        node.type !== ElementType.Style &&
        node.type !== ElementType.Script
      )
        return [];
      if (node.name === "head")
        return canonical(
          node.children.filter(
            (child) =>
              child.type === ElementType.Style ||
              (child.type === ElementType.Tag && child.name === "link"),
          ),
          depth + 1,
        );
      const attrs = Object.entries(node.attribs).toSorted(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      const children = canonical(node.children, depth + 1);
      // MIME/Graph can add an empty html/body wrapper to the same rendered fragment.
      if ((node.name === "html" || node.name === "body") && !attrs.length) return children;
      return [[node.name, attrs, children]];
    });
  };
  return sha256Hex(JSON.stringify(canonical(parseDocument(html.trim()).children)));
}

export function draftTextFingerprint(text: string): string {
  return sha256Hex(text.replace(/\r\n?/g, "\n"));
}

export function markdownDraftSource(text: string): MarkdownDraftSource {
  return {
    version: 1,
    text,
    bodyFingerprint: draftBodyFingerprint(
      composeTransportHtml({ html: renderMarkdown(text) }) ?? "",
    ),
  };
}

/** Prior drafts used the unadorned renderer hash; that exact hash still detects remote edits. */
export function matchesMarkdownDraft(
  source: MarkdownDraftSource,
  currentFingerprint: string | undefined,
): boolean {
  return (
    currentFingerprint !== undefined &&
    source.bodyFingerprint === currentFingerprint &&
    (source.bodyFingerprint === markdownDraftSource(source.text).bodyFingerprint ||
      source.bodyFingerprint === draftBodyFingerprint(renderMarkdown(source.text)))
  );
}

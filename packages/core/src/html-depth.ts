import type { parseDocument } from "htmlparser2";

export const MAX_HTML_DEPTH = 512;
type HtmlNode = ReturnType<typeof parseDocument>["children"][number];

/** Move deep content into its last permitted ancestor, without recursive walks. */
export function flattenHtmlChildren(
  nodes: HtmlNode[],
  omit: (node: HtmlNode) => boolean,
): HtmlNode[] {
  const parent = nodes[0]?.parent ?? null;
  const pending = nodes.toReversed();
  const flat: HtmlNode[] = [];
  while (pending.length) {
    const node = pending.pop();
    if (!node || omit(node)) continue;
    if ("children" in node && !("name" in node && node.name === "style")) {
      for (const child of node.children.toReversed()) pending.push(child);
      node.children = [];
    }
    node.parent = parent;
    node.prev = flat.at(-1) ?? null;
    node.next = null;
    const previous = flat.at(-1);
    if (previous) previous.next = node;
    flat.push(node);
  }
  return flat;
}

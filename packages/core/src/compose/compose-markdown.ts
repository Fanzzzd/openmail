/** Compose nodes as Markdown, for drafts written in Markdown mode. */

import { plainNodes, type SafeNode } from "./compose-nodes.js";

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
export function markdownNodes(nodes: SafeNode[], depth = 0): string {
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
      case "hr":
        boundary();
        result += "---\n";
        break;
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

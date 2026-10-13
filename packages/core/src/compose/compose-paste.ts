import { escapeComposeText, richComposeBody } from "./compose-body.js";
export function composePaste(text: string, mode: "matchStyle" | "quotation") {
  const normalized = text.replace(/\r\n?/g, "\n");
  const html = escapeComposeText(normalized).replaceAll("\n", "<br>");
  return mode === "quotation"
    ? {
        text: normalized
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n"),
        html: richComposeBody(`<blockquote>${html}</blockquote>`).html,
      }
    : { text: normalized, html };
}

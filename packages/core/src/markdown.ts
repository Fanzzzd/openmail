import MarkdownIt from "markdown-it";

/**
 * Markdown for outgoing mail. `html: false` makes markdown-it escape every
 * tag the person typed, and its link check refuses javascript:, vbscript:,
 * file: and data: URLs (except images), so the output holds only the tags
 * markdown-it writes itself. That is the sanitizing; no second pass is needed.
 */
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
// markdown-it 15 turned fuzzy links off. People type www.example.com in mail
// and expect a link, as they got before. Credentials in URLs stay unlinked.
md.linkify.set({ fuzzyLink: true });

// Mail clients drop <style> blocks, so the few styles that matter are inline.
const STYLES: [string, string][] = [
  [
    "<pre>",
    '<pre style="background:#f6f8fa;border-radius:6px;padding:10px 12px;overflow:auto;font-size:13px;line-height:1.45">',
  ],
  ["<code", '<code style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace"'],
  [
    "<blockquote>",
    '<blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex;color:#555">',
  ],
];

/** The HTML part for a Markdown body. */
export function renderMarkdown(text: string): string {
  let html = md.render(text);
  for (const [tag, styled] of STYLES) html = html.replaceAll(tag, styled);
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;line-height:1.5">${html}</div>`;
}

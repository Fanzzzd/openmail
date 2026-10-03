/**
 * A thread as one print-friendly HTML document, for printing and saving as
 * PDF. Mail HTML is untrusted: scripts, frames, plugins and event handlers
 * are removed, tracker URLs are stripped, and the document's CSP loads
 * nothing remote. The window that renders it also runs with JavaScript off.
 */
import type { Address, Message } from "./domain.js";
import { prepareMessageHtml } from "./reader-html.js";
import { sanitizeReaderHtml } from "./reader-sanitize.js";

export interface PrintHeadings {
  from: string;
  to: string;
  cc: string;
  date: string;
}

export interface PrintInput {
  subject: string;
  messages: readonly Message[];
  headings: PrintHeadings;
  formatDate: (ms: number) => string;
  /** Inline images by message id, then Content-ID, as data: URLs. */
  inline?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";

const CSS = `
  @page { margin: 16mm; }
  html, body { margin: 0; padding: 0; background: #fff; color: #111; }
  body { font: 12px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", system-ui, sans-serif; }
  h1 { font-size: 18px; margin: 0 0 12px; }
  .message { border-top: 1px solid #ccc; padding: 10px 0 14px; }
  .message + .message { break-before: auto; }
  .head { margin-bottom: 10px; color: #333; }
  .head b { display: inline-block; min-width: 4em; color: #666; font-weight: 500; }
  .body { overflow-wrap: anywhere; }
  .body img { max-width: 100%; height: auto; }
  .body table { max-width: 100%; }
  pre { white-space: pre-wrap; font: inherit; margin: 0; }
`;

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const person = (a: Address) => (a.name ? `${a.name} <${a.address}>` : a.address);

/** Removes active content. Rendering has JavaScript off too; this keeps the document inert anyway. */
export function stripActiveContent(html: string): string {
  return sanitizeReaderHtml(html);
}

export function printableThread(input: PrintInput): string {
  const { headings } = input;
  const messages = input.messages.map((m) => {
    const rows = [
      [headings.from, person(m.from)],
      [headings.to, m.to.map(person).join(", ")],
      ...(m.cc.length ? [[headings.cc, m.cc.map(person).join(", ")]] : []),
      [headings.date, input.formatDate(m.date)],
    ]
      .map(
        ([label, value]) =>
          `<div><b>${escapeHtml(label ?? "")}</b> ${escapeHtml(value ?? "")}</div>`,
      )
      .join("");
    const inline = input.inline?.[m.id];
    const body = m.bodyHtml
      ? stripActiveContent(prepareMessageHtml(m.bodyHtml, inline ? { inline } : {}).html)
      : `<pre>${escapeHtml(m.bodyText)}</pre>`;
    return `<section class="message"><div class="head">${rows}</div><div class="body">${body}</div></section>`;
  });
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<title>${escapeHtml(input.subject)}</title><style>${CSS}</style></head>
<body><h1>${escapeHtml(input.subject)}</h1>${messages.join("\n")}</body></html>`;
}

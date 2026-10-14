/**
 * A thread as one print-friendly HTML document, for printing and saving as
 * PDF. Mail HTML is untrusted: scripts, frames, plugins and event handlers
 * are removed, tracker URLs are stripped, and the document's CSP loads
 * nothing remote. The window that renders it also runs with JavaScript off.
 *
 * Every message shares the document, so each body sits in its own box: its CSS reaches only
 * descendants of that box (see print-css.ts), and the box contains its layout and paint, so
 * nothing in it can cover or restyle another message or any sender header.
 */
import type { Address, Message } from "../domain/message.js";
import { prepareMessageHtml } from "./reader-html.js";
import { sanitizeReaderHtml } from "./reader-sanitize.js";
import { PRINT_CSP } from "./reader-csp.js";
import { PRINT_SCOPE_ATTRIBUTE, printScope, scopePrintHtml } from "./print-css.js";

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

const CSS = `
  @page { margin: 16mm; }
  html, body { margin: 0; padding: 0; background: #fff; color: #111; }
  body { font: 12px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", system-ui, sans-serif; }
  h1 { font-size: 18px; margin: 0 0 12px; }
  .om-print-message { border-top: 1px solid #ccc; padding: 10px 0 14px; }
  .om-print-message + .om-print-message { break-before: auto; }
  .om-print-head { margin-bottom: 10px; color: #333; }
  .om-print-head b { display: inline-block; min-width: 4em; color: #666; font-weight: 500; }
  .om-print-body { overflow-wrap: anywhere; contain: layout paint; overflow: hidden; isolation: isolate; }
  .om-print-body img { max-width: 100%; height: auto; }
  .om-print-body table { max-width: 100%; }
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
  const messages = input.messages.map((m, index) => {
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
      ? scopePrintHtml(
          stripActiveContent(prepareMessageHtml(m.bodyHtml, inline ? { inline } : {}).html),
          printScope(index),
        )
      : `<pre>${escapeHtml(m.bodyText)}</pre>`;
    // The header is a sibling of the scope box, never inside it.
    return `<section class="om-print-message"><div class="om-print-head">${rows}</div><div class="om-print-body" id="m-${index}" ${PRINT_SCOPE_ATTRIBUTE}>${body}</div></section>`;
  });
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${PRINT_CSP}">
<title>${escapeHtml(input.subject)}</title><style>${CSS}</style></head>
<body><h1>${escapeHtml(input.subject)}</h1>${messages.join("\n")}</body></html>`;
}

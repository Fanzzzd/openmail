import { prepareMessageHtml, stripMobileForms } from "@openmail/core/portable";

// Desktop resource policy plus explicit form/base restrictions for Android WebView.
export const READER_CSP =
  "default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'";
export function readerDocument(html: string): string {
  const prepared = prepareMessageHtml(stripMobileForms(html));
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${READER_CSP}"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font:16px -apple-system,sans-serif;color:#16181d;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style></head><body>${prepared.html}</body></html>`;
}
/** Validate links at the WebView boundary. Never hand credential-bearing URLs to another app. */
export function externalReaderLink(raw: string): string | null {
  if (
    Array.from(raw).some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    )
  )
    return null;
  try {
    const url = new URL(raw);
    if (url.username || url.password) return null;
    if (url.protocol === "http:" || url.protocol === "https:") return url.href;
    if (url.protocol === "mailto:" && !url.pathname.startsWith("//") && url.pathname)
      return url.href;
  } catch {
    return null;
  }
  return null;
}

/** The WebView never navigates; validated links open in the system handler. */
export function handleReaderNavigation(
  raw: string,
  open: (url: string) => Promise<unknown>,
): false {
  const url = externalReaderLink(raw);
  try {
    if (url) void open(url).catch(() => null);
  } catch {
    return false;
  }
  return false;
}

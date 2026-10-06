import { toUnicode } from "punycode/";
import { prepareMessageHtml, stripMobileForms, sanitizeReaderHtml } from "@openmail/core/portable";

// Desktop resource policy plus explicit form/base restrictions for Android WebView.
export const READER_CSP =
  "default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'";
export function readerDocument(
  html: string,
  remoteImages = false,
  inline: Readonly<Record<string, string>> = {},
): string {
  const prepared = prepareMessageHtml(stripMobileForms(html), { inline });
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${remoteImages ? READER_CSP.replace("img-src data: cid:", "img-src data: cid: https:") : READER_CSP}"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font:16px -apple-system,sans-serif;color:#16181d;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style></head><body>${sanitizeReaderHtml(prepared.html, remoteImages)}</body></html>`;
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

export interface ReaderLink {
  url: string;
  destination: string;
}
function readerLink(raw: string): ReaderLink | null {
  const valid = externalReaderLink(raw);
  if (!valid) return null;
  const url = new URL(valid);
  if (url.protocol === "mailto:") {
    let destination = url.pathname;
    try {
      destination = decodeURIComponent(destination);
    } catch {
      /* Keep encoded text. */
    }
    return { url: valid, destination };
  }
  const ascii = url.hostname;
  let unicode = ascii;
  try {
    unicode = toUnicode(ascii);
  } catch {
    /* Display the validated ASCII host. */
  }
  return { url: valid, destination: unicode === ascii ? url.host : `${url.host} (${unicode})` };
}

/** iOS reports user clicks. Android lacks a reliable navigation type, so every link needs confirmation. */
export function handleReaderNavigation(
  request: { url: string; isTopFrame?: boolean; navigationType?: string },
  platform: "ios" | "android" | "other",
  open: (url: string) => Promise<unknown>,
  confirm: (link: ReaderLink) => void,
): false {
  if (request.isTopFrame === false) return false;
  const link = readerLink(request.url);
  if (!link) return false;
  if (platform === "android") {
    confirm(link);
    return false;
  }
  if (platform !== "ios" || request.navigationType !== "click") return false;
  try {
    void open(link.url).catch(() => null);
  } catch {
    return false;
  }
  return false;
}

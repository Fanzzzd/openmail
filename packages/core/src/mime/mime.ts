import { visibleHtmlText } from "../visible-text/visible-text.js";
import { Buffer } from "../platform/bytes.js";
import { Result } from "effect";
import { TextDecoder } from "../platform/text-decoder.js";

import type { Address } from "../domain/message.js";
import { isEmailAddress, splitAddresses } from "../compose/recipients.js";

/** Decodes RFC 2047 encoded-words (`=?GBK?B?...?=`) that providers leave in headers. */
export function decodeHeader(value: string): string {
  const word = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;
  const matches = [...value.matchAll(word)];
  let out = "";
  let end = 0;
  for (let i = 0; i < matches.length; i++) {
    const first = matches[i]!;
    const gap = value.slice(end, first.index);
    out += i && /^\s*$/.test(gap) ? "" : gap;
    const charset = first[1]!;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const match = matches[i]!;
      const text = match[3]!;
      chunks.push(
        match[2]!.toUpperCase() === "B"
          ? Buffer.from(text, "base64")
          : Buffer.from(
              text
                .replaceAll("_", " ")
                .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) =>
                  String.fromCharCode(parseInt(hex, 16)),
                ),
              "latin1",
            ),
      );
      end = match.index + match[0].length;
      const next = matches[i + 1];
      if (
        !next ||
        next[1]!.toLowerCase() !== charset.toLowerCase() ||
        !/^\s*$/.test(value.slice(end, next.index))
      )
        break;
      i++;
    }
    out += decodeBytes(Buffer.concat(chunks), charset);
  }
  return out + value.slice(end);
}

/**
 * UTF-8 if the bytes are valid UTF-8, else the declared charset. For sources
 * that may already have converted the text to UTF-8 (Gmail's API).
 */
export function decodeUtf8First(bytes: Uint8Array, charset?: string): string {
  const utf8 = Result.try(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  return Result.getOrElse(utf8, () => decodeBytes(bytes, charset));
}

/** Decodes with the declared charset; falls back to UTF-8 when ICU does not know it. */
export function decodeBytes(bytes: Uint8Array, charset = "utf-8"): string {
  // TextDecoder throws a RangeError for a label it does not know.
  const decoder = Result.try(() => new TextDecoder(charset.trim().toLowerCase()));
  return Result.getOrElse(decoder, () => new TextDecoder("utf-8")).decode(bytes);
}

/** Splits an address-list header on commas outside quotes and angle brackets. */
export function parseAddressList(value: string | undefined): Address[] {
  if (!value) return [];
  return splitAddresses(value.replace(/\r?\n[ \t]+/g, " "))
    .map((p) => p.trim())
    .filter(Boolean)
    .map((part) => parseAddress(decodeHeader(part)))
    .filter((address) => isEmailAddress(address.address));
}

function parseAddress(raw: string): Address {
  const match = /^(.*?)\s*<([^>]+)>$/.exec(raw);
  if (!match) return { name: "", address: raw.replace(/^"|"$/g, "") };
  return {
    name: match[1]!
      .trim()
      .replace(/^"|"$/g, "")
      .replace(/\\(["\\])/g, "$1")
      .replace(/\p{Cf}/gu, ""),
    address: match[2]!.trim(),
  };
}

export function charsetOf(contentType: string | undefined): string | undefined {
  return /charset="?([^";\s]+)"?/i.exec(contentType ?? "")?.[1];
}

/** Last-resort plain text for HTML-only mail, so search and the CLI still see the words. */
export function htmlToText(html: string): string {
  return visibleHtmlText(html, { budgetFallback: "index-full-text" }).text;
}

const META_CHARSET = '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">';

/**
 * Outgoing HTML as a whole document that declares UTF-8 itself. Exchange
 * takes the charset of an HTML body from the HTML: a Markdown fragment sent
 * through Graph arrived in Gmail as UTF-8 bytes labeled GBK. Raw MIME parts
 * declare utf-8 in their header too; the <meta> costs nothing there. A
 * document that already declares a charset is left alone.
 */
export function htmlDocument(html: string): string {
  if (/<meta[^>]+charset/i.test(html)) return html;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (head) => head + META_CHARSET);
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html[^>]*>/i, (tag) => `${tag}<head>${META_CHARSET}</head>`);
  }
  return `<!DOCTYPE html><html><head>${META_CHARSET}</head><body>${html}</body></html>`;
}

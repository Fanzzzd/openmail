import { Result } from "effect";

import type { Address } from "./domain.js";

/** Decodes RFC 2047 encoded-words (`=?GBK?B?...?=`) that providers leave in headers. */
export function decodeHeader(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(
      /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
      (_whole, charset: string, enc: string, text: string) => {
        const bytes =
          enc.toUpperCase() === "B"
            ? Buffer.from(text, "base64")
            : Buffer.from(
                text
                  .replaceAll("_", " ")
                  .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) =>
                    String.fromCharCode(parseInt(hex, 16)),
                  ),
                "latin1",
              );
        return decodeBytes(bytes, charset);
      },
    );
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
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let angled = false;
  for (const ch of decodeHeader(value)) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "<" && !quoted) angled = true;
    else if (ch === ">" && !quoted) angled = false;
    if (ch === "," && !quoted && !angled) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .map(parseAddress);
}

function parseAddress(raw: string): Address {
  const match = /^(.*?)\s*<([^>]+)>$/.exec(raw);
  if (!match) return { name: "", address: raw.replace(/^"|"$/g, "") };
  return { name: match[1]!.trim().replace(/^"|"$/g, ""), address: match[2]!.trim() };
}

export function charsetOf(contentType: string | undefined): string | undefined {
  return /charset="?([^";\s]+)"?/i.exec(contentType ?? "")?.[1];
}

/** Last-resort plain text for HTML-only mail, so search and the CLI still see the words. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

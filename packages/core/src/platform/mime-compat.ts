import { TextDecoder as PortableDecoder } from "./text-decoder.js";
import { Buffer } from "./bytes.js";
import { charsetOf, decodeBytes, decodeHeader, htmlToText } from "../mime.js";
import type { IncomingMessage } from "../domain.js";
import type { MimeMessage, MimePart } from "./mail-codec.js";

/** Normalize text before parsers that use the host's incomplete TextDecoder. */
export function normalizeMimeCharsets(raw: Uint8Array, depth = 0): Uint8Array {
  if (depth > 32) throw new Error("MIME nesting exceeds 32");
  const source = Buffer.from(raw).toString("latin1");
  const split = /\r?\n\r?\n/.exec(source);
  if (!split) return raw;
  // A MIME entity starts with headers or an immediate blank line. Body text may contain colons.
  const headerLines = source.slice(0, split.index).split(/\r?\n/);
  if (
    !headerLines[0] ||
    !headerLines.every(
      (line, index) => /^[!-9;-~]+:/.test(line) || (index > 0 && /^[ \t]/.test(line)),
    )
  )
    return raw;
  const originalHeaders = source.slice(0, split.index).replace(/\r?\n[ \t]+/g, " ");
  if (
    /^content-disposition:\s*attachment\b/im.test(originalHeaders) ||
    /(?:^content-disposition:[^\r\n]*\bfilename(?:\*\d+\*?|\*)?\s*=|^content-type:[^\r\n]*\bname(?:\*\d+\*?|\*)?\s*=)/im.test(
      originalHeaders,
    )
  )
    return raw;
  const headers = source
    .slice(0, split.index)
    .replace(/\r?\n[ \t]+/g, " ")
    .replace(
      /=\?[^?]+\?[BbQq]\?[^?]*\?=(?:[ \t]*=\?[^?]+\?[BbQq]\?[^?]*\?=)*/g,
      (words) => `=?UTF-8?B?${Buffer.from(decodeHeader(words.trim())).toString("base64")}?=`,
    );
  const body = source.slice(split.index + split[0].length);
  const type = /^content-type:\s*(.*)$/im.exec(headers)?.[1] ?? "text/plain";
  const boundary = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(type);
  if (/^multipart\//i.test(type) && boundary) {
    const marker = `--${boundary[1] ?? boundary[2]}`;
    const pieces = body.split(marker);
    return Buffer.from(
      `${headers}\r\n\r\n${pieces
        .map((part, i) => {
          if (!i || part.startsWith("--")) return part;
          const leading = /^\r?\n/.exec(part)?.[0] ?? "";
          return (
            leading +
            Buffer.from(
              normalizeMimeCharsets(Buffer.from(part.slice(leading.length), "latin1"), depth + 1),
            ).toString("latin1")
          );
        })
        .join(marker)}`,
      "latin1",
    );
  }
  if (!/^text\/(?:plain|html)(?:;|$)/i.test(type))
    return Buffer.from(`${headers}\r\n\r\n${body}`, "latin1");
  const charset = charsetOf(type);
  if (!charset) return Buffer.from(`${headers}\r\n\r\n${body}`, "latin1");
  try {
    const native = new TextDecoder(charset);
    if (native.encoding === new PortableDecoder(charset).encoding)
      return Buffer.from(`${headers}\r\n\r\n${body}`, "latin1");
  } catch {
    /* The portable decoder handles labels missing from this host. */
  }
  const encoding = /^content-transfer-encoding:\s*(.*)$/im.exec(headers)?.[1]?.trim().toLowerCase();
  const bytes =
    encoding === "base64"
      ? Buffer.from(body, "base64")
      : Buffer.from(
          encoding === "quoted-printable"
            ? body
                .replace(/=\r?\n/g, "")
                .replace(/=([a-f\d]{2})/gi, (_, hex: string) =>
                  String.fromCharCode(parseInt(hex, 16)),
                )
            : body,
          "latin1",
        );
  const utf8 = Buffer.from(decodeBytes(bytes, charsetOf(type))).toString("base64");
  const normalized = headers
    .split(/\r?\n/)
    .filter((line) => !/^content-(?:type|transfer-encoding):/i.test(line) && line.trim())
    .join("\r\n");
  return Buffer.from(
    `${normalized ? `${normalized}\r\n` : ""}Content-Type: ${type.replace(/;\s*charset\s*=\s*(?:"[^"]*"|[^;\s]+)/gi, "")}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${utf8}\r\n`,
    "latin1",
  );
}

type Der = { tag: number; start: number; end: number; next: number };
function der(bytes: Uint8Array, offset: number): Der | undefined {
  const tag = bytes[offset];
  const first = bytes[offset + 1];
  if (tag === undefined || first === undefined) return undefined;
  let start = offset + 2;
  let length = first;
  if (first & 128) {
    const count = first & 127;
    if (!count || count > 4 || start + count > bytes.length) return undefined;
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + bytes[start++]!;
  }
  return start + length <= bytes.length
    ? { tag, start, end: start + length, next: start + length }
    : undefined;
}
function children(bytes: Uint8Array, node: Der): Der[] {
  const out: Der[] = [];
  for (let offset = node.start; offset < node.end;) {
    const child = der(bytes, offset);
    if (!child || child.end > node.end) return [];
    out.push(child);
    offset = child.next;
  }
  return out;
}
/** CMS SignedData encapsulates plaintext; this unwraps it without verifying a signature. */
export function signedMime(bytes: Uint8Array): Uint8Array | undefined {
  const root = der(bytes, 0);
  if (root?.tag !== 48) return undefined;
  const [oid, wrapped] = children(bytes, root);
  if (
    oid?.tag !== 6 ||
    Buffer.from(bytes.subarray(oid.start, oid.end)).toString("hex") !== "2a864886f70d010702" ||
    wrapped?.tag !== 160
  )
    return undefined;
  const signed = children(bytes, wrapped)[0];
  if (signed?.tag !== 48) return undefined;
  const contentInfo = children(bytes, signed)[2];
  if (contentInfo?.tag !== 48) return undefined;
  const content = children(bytes, contentInfo)[1];
  if (content?.tag !== 160) return undefined;
  const octets = children(bytes, content)[0];
  if (octets?.tag !== 4) return undefined;
  return bytes.subarray(octets.start, octets.end);
}

export const MAX_MIME_BYTES = 25 * 1024 * 1024;
export const MAX_UU_BODY = 2 * 1024 * 1024;
export function uuAttachments(text: string): { text: string; attachments: MimePart[] } {
  if (text.length > MAX_UU_BODY) return { text, attachments: [] };
  const lines = text.match(/[^\n]*(?:\n|$)/g) ?? [];
  const attachments: MimePart[] = [];
  const removed = new Set<number>();
  let block: { start: number; filename: string; bytes: number[]; valid: boolean } | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.replace(/\r?\n$/, "");
    const begin = /^begin [0-7]{3} ([^\r\n]+)$/.exec(line);
    if (begin) {
      block = { start: index, filename: begin[1]!, bytes: [], valid: true };
      continue;
    }
    if (!block) continue;
    if (line === "end") {
      if (block.valid) {
        const content = new Uint8Array(block.bytes);
        attachments.push({
          filename: block.filename,
          content,
          size: content.length,
          contentType: "application/octet-stream",
          related: false,
          headers: new Map(),
        });
        for (let i = block.start; i <= index; i++) removed.add(i);
      }
      block = undefined;
      continue;
    }
    if (!block.valid) continue;
    const length = line.length ? (line.charCodeAt(0) - 32) & 63 : -1;
    if (
      length < 0 ||
      length > 45 ||
      line.length !== 1 + Math.ceil(length / 3) * 4 ||
      /[^\x20-\x60]/.test(line)
    ) {
      block.valid = false;
      continue;
    }
    const row: number[] = [];
    for (let i = 1; i + 3 < line.length; i += 4) {
      const a = (line.charCodeAt(i) - 32) & 63,
        b = (line.charCodeAt(i + 1) - 32) & 63,
        c = (line.charCodeAt(i + 2) - 32) & 63,
        d = (line.charCodeAt(i + 3) - 32) & 63;
      row.push((a << 2) | (b >> 4), ((b & 15) << 4) | (c >> 2), ((c & 3) << 6) | d);
    }
    block.bytes.push(...row.slice(0, length));
  }
  return {
    text: attachments.length ? lines.filter((_, index) => !removed.has(index)).join("") : text,
    attachments,
  };
}

/** Only an opaque signed root body may replace the displayed body. */
export function signedRoot(raw: Uint8Array): boolean {
  const source =
    Buffer.from(raw.subarray(0, 256 * 1024))
      .toString("latin1")
      .split(/\r?\n\r?\n/, 1)[0] ?? "";
  if (/^content-disposition:\s*attachment\b/im.test(source)) return false;
  const type =
    /^content-type:\s*(.*(?:\r?\n[ \t].*)*)/im.exec(source)?.[1]?.replace(/\r?\n[ \t]+/g, " ") ??
    "";
  return (
    /^application\/(?:x-)?pkcs7-mime\b/i.test(type) &&
    !/smime-type\s*=\s*"?(?!signed-data)[^;\s"]+/i.test(type)
  );
}

function mimeEntity(raw: Uint8Array): boolean {
  const source = Buffer.from(raw.subarray(0, 256 * 1024)).toString("latin1");
  const end = source.search(/\r?\n\r?\n/);
  if (end < 0) return false;
  const lines = source.slice(0, end).split(/\r?\n/);
  return (
    lines.some((line) => /^(?:content-type|mime-version|from|to|subject):/i.test(line)) &&
    lines.every((line) => /^[A-Za-z][A-Za-z0-9-]*:|^[ \t]/.test(line))
  );
}

export async function compatibleMime(
  mail: MimeMessage,
  parse: (raw: Uint8Array) => Promise<MimeMessage>,
  raw?: Uint8Array,
  depth = 0,
): Promise<MimeMessage> {
  if (raw && raw.byteLength <= MAX_MIME_BYTES && signedRoot(raw) && depth < 4)
    for (const part of mail.attachments) {
      if (!/^application\/(?:x-)?pkcs7-mime$/i.test(part.contentType)) continue;
      const inner = signedMime(part.content);
      if (!inner || !mimeEntity(inner)) continue;
      let parsed: MimeMessage;
      try {
        parsed = await compatibleMime(await parse(inner), parse, inner, depth + 1);
      } catch {
        return mail;
      }
      return {
        ...mail,
        ...(parsed.text === undefined ? {} : { text: parsed.text }),
        html: parsed.html || mail.html,
        headers: mail.headers,
        headerLines: mail.headerLines,
        attachments: [...mail.attachments, ...parsed.attachments],
      };
    }
  const uu = uuAttachments(mail.text ?? "");
  return uu.attachments.length
    ? { ...mail, text: uu.text, attachments: [...mail.attachments, ...uu.attachments] }
    : mail;
}

export const hasSignedContainer = (message: IncomingMessage, rootType = "") => {
  const type =
    message.headers?.find((header) => header.name.toLowerCase() === "content-type")?.value ||
    rootType;
  const disposition =
    message.headers?.find((header) => header.name.toLowerCase() === "content-disposition")?.value ??
    "";
  return (
    /^application\/(?:x-)?pkcs7-mime\b/i.test(type) &&
    !/^attachment\b/i.test(disposition) &&
    !/smime-type\s*=\s*"?(?!signed-data)[^;\s"]+/i.test(type)
  );
};

export function withDecodedBody(message: IncomingMessage, parsed: MimeMessage): IncomingMessage {
  if (parsed.text === undefined && !parsed.html) return message;
  const html = parsed.html || "";
  const text = parsed.text ?? htmlToText(html);
  return {
    ...message,
    bodyText: text,
    bodyHtml: html,
    snippet: text.replace(/\s+/g, " ").trim().slice(0, 200),
    attachments: parsed.attachments
      .filter((part) => !part.related)
      .map((part) => ({
        filename: part.filename ?? "attachment",
        mimeType: part.contentType,
        size: part.size,
      })),
  };
}

export function withUuAttachments(message: IncomingMessage): IncomingMessage {
  const decoded = uuAttachments(message.bodyText);
  return decoded.attachments.length
    ? {
        ...message,
        bodyText: decoded.text,
        snippet: decoded.text.replace(/\s+/g, " ").trim().slice(0, 200),
        attachments: [
          ...message.attachments,
          ...decoded.attachments.map((part) => ({
            filename: part.filename ?? "attachment",
            mimeType: part.contentType,
            size: part.size,
          })),
        ],
      }
    : message;
}

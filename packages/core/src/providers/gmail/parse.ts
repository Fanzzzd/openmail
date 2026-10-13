import { firstHeaders } from "../../sync/header-backfill.js";
import { messageSecurity } from "../../reader/message-security.js";
import { Buffer } from "../../platform/bytes.js";
import { withUuAttachments } from "../../platform/mime-compat.js";

import type { Attachment, IncomingMessage } from "../../domain/message.js";
import { charsetOf, decodeHeader, decodeUtf8First, parseAddressList } from "../../mime/mime.js";

import { finishInline, type HtmlBody } from "../../platform/html-text.js";
import type { GmailPart, GmailMessage } from "./api.js";

/** Parts with a filename, in the order `parseGmailMessage` lists them as attachments. */
export function attachmentParts(payload: GmailPart): GmailPart[] {
  const out: GmailPart[] = [];
  const walk = (part: GmailPart) => {
    if (part.filename) out.push(part);
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  return out;
}

export const parseGmailMessage = (raw: GmailMessage): IncomingMessage =>
  finishInline(gmailBody(raw));

export function gmailBody(raw: GmailMessage): HtmlBody<IncomingMessage> {
  const headers = firstHeaders({ headers: raw.payload.headers ?? [] }, "last");
  let text = "";
  let html = "";
  const attachments: Attachment[] = [];
  const calendarParts: GmailPart[] = [];
  const walk = (part: GmailPart) => {
    if (part.mimeType === "text/calendar" || /\.ics$/i.test(part.filename ?? ""))
      calendarParts.push(part);
    if (part.filename) {
      attachments.push({ filename: part.filename, mimeType: part.mimeType, size: part.body.size });
    } else if (part.body.data) {
      const partHeaders = firstHeaders({ headers: part.headers ?? [] }, "last");
      // Gmail's API hands text parts over already converted to UTF-8, while
      // the part header keeps the sender's charset (gb2312 from Outlook,
      // for example). Decoding by the header would garble them.
      const decoded = decodeUtf8First(
        Buffer.from(part.body.data, "base64"),
        charsetOf(partHeaders.get("content-type")),
      );
      if (part.mimeType === "text/plain" && !text) text = decoded;
      else if (part.mimeType === "text/html" && !html) html = decoded;
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(raw.payload);

  const labels = raw.labelIds ?? [];
  const from = parseAddressList(headers.get("from"))[0] ?? { name: "", address: "" };
  const message = (bodyText: string) =>
    withUuAttachments({
      providerId: raw.id,
      threadId: raw.threadId,
      subject: decodeHeader(headers.get("subject") ?? ""),
      from,
      to: parseAddressList(headers.get("to")),
      cc: parseAddressList(headers.get("cc")),
      bcc: parseAddressList(headers.get("bcc")),
      headers: (raw.payload.headers ?? []).map((h) => ({
        name: h.name.toLowerCase(),
        value: h.value,
      })),
      ...(headers.get("message-id") ? { rfcMessageId: headers.get("message-id") } : {}),
      ...(raw.sizeEstimate !== undefined ? { size: raw.sizeEstimate } : {}),
      replyTo: parseAddressList(headers.get("reply-to")),
      date: Number(raw.internalDate),
      snippet: decodeEntities(raw.snippet ?? ""),
      bodyText,
      bodyHtml: html,
      security: messageSecurity(raw.payload.headers ?? [], "gmail"),
      ...(calendarParts.length ? { hasCalendar: true } : {}),
      labels,
      attachments,
      isUnread: labels.includes("UNREAD"),
      isStarred: labels.includes("STARRED"),
    });
  return text ? { finish: () => message(text) } : { html, finish: message };
}

// Gmail's snippet is HTML-escaped.
function decodeEntities(s: string): string {
  return s
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

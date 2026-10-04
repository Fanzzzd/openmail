import { Predicate } from "effect";
import { type ListResponse, type MessageStructureObject } from "imapflow";
import type { Attachment, IncomingMessage } from "../../../domain.js";
import { cachedHeaders, firstHeaders } from "../../../header-backfill.js";
import { flagsOf, IMAP_SPECIAL_LABELS as SPECIAL_LABEL } from "../../../imap-helpers.js";

import { messageSecurity } from "../../../message-security.js";
import { htmlToText } from "../../../mime.js";
import { mimeAddresses, type MimeMessage } from "../../mail-codec.js";

// Virtual folders that hold copies of mail from other folders.
const VIRTUAL = new Set(["\\All", "\\Flagged"]);

export interface ImapSyncFolder {
  path: string;
  /** Label every message of this folder gets. */
  label: string;
  /** Sidebar name for user folders; undefined for special-use ones. */
  userName?: string;
}

/**
 * Special-use folders map to system labels; other selectable folders become
 * user labels keyed by path. Virtual folders (\All, \Flagged) are skipped
 * because their messages already sit in a real folder.
 */
export function mapFolders(
  list: readonly Pick<ListResponse, "path" | "delimiter" | "flags" | "specialUse">[],
): ImapSyncFolder[] {
  const out: ImapSyncFolder[] = [];
  for (const f of list) {
    if (f.flags.has("\\Noselect") || f.flags.has("\\NonExistent")) continue;
    const special = f.specialUse ?? (f.path.toUpperCase() === "INBOX" ? "\\Inbox" : undefined);
    if (special && VIRTUAL.has(special)) continue;
    const label = special ? SPECIAL_LABEL[special] : undefined;
    if (label) {
      out.push({ path: f.path, label });
    } else {
      const name = f.delimiter ? f.path.split(f.delimiter).join("/") : f.path;
      out.push({ path: f.path, label: f.path, userName: name });
    }
  }
  return out;
}

// Threads and parsing

const ANGLE_ID = /<([^<>\s]+)>/g;

function messageIds(value: string | readonly string[] | undefined): string[] {
  if (!value) return [];
  const joined = Predicate.isString(value) ? value : value.join(" ");
  const ids = [...joined.matchAll(ANGLE_ID)].map((m) => m[1]!);
  if (ids.length) return ids;
  // Some senders drop the angle brackets.
  return joined.split(/\s+/).filter((s) => s.includes("@"));
}

/**
 * Thread key: the root of the reply chain. References lists ancestors oldest
 * first, so its first id is the root; a reply without References falls back
 * to In-Reply-To, and a message that starts a thread uses its own Message-ID.
 */
export function threadIdOf(h: {
  messageId?: string | undefined;
  inReplyTo?: string | undefined;
  references?: string | readonly string[] | undefined;
}): string | undefined {
  return messageIds(h.references)[0] ?? messageIds(h.inReplyTo)[0] ?? messageIds(h.messageId)[0];
}

/** Leaf parts that are attachments, with their BODY[part] numbers. */
export function attachmentNodes(
  node: MessageStructureObject | undefined,
): { part: string; attachment: Attachment }[] {
  if (!node) return [];
  const out: { part: string; attachment: Attachment }[] = [];
  const walk = (n: MessageStructureObject) => {
    const filename = n.dispositionParameters?.filename ?? n.parameters?.name;
    if (!n.childNodes?.length && (n.disposition === "attachment" || filename)) {
      out.push({
        // A single-part message has no part number; its body is part 1.
        part: n.part ?? "1",
        attachment: { filename: filename ?? "attachment", mimeType: n.type, size: n.size ?? 0 },
      });
    }
    for (const c of n.childNodes ?? []) walk(c);
  };
  walk(node);
  return out;
}

export function structureAttachments(node: MessageStructureObject | undefined): Attachment[] {
  return attachmentNodes(node).map((n) => n.attachment);
}

function folderLabels(label: string, flags: Set<string> | undefined): string[] {
  const { unread, starred } = flagsOf(flags);
  const labels = [label];
  if (unread) labels.push("UNREAD");
  if (starred) labels.push("STARRED");
  return labels;
}

export function toIncoming(
  parsed: MimeMessage,
  meta: {
    providerId: string;
    authservId?: string | null;
    label: string;
    flags: Set<string> | undefined;
    internalDate?: Date | string | undefined;
    /** Overrides parsed attachments when the source was truncated. */
    attachments?: Attachment[];
    size?: number;
  },
): IncomingMessage {
  const html = parsed.html || "";
  const text = parsed.text || htmlToText(html);
  const labels = folderLabels(meta.label, meta.flags);
  if (meta.flags?.has("$Important") || parsed.priority === "high") labels.push("IMPORTANT");
  const received = meta.internalDate ? new Date(meta.internalDate).getTime() : NaN;
  return {
    providerId: meta.providerId,
    threadId: threadIdOf(parsed) ?? meta.providerId,
    ...(!messageIds(parsed.references).length && parsed.inReplyTo
      ? { parentRfcMessageId: messageIds(parsed.inReplyTo)[0] }
      : {}),
    subject: parsed.subject ?? "",
    from: mimeAddresses(parsed.from)[0] ?? { name: "", address: "" },
    to: mimeAddresses(parsed.to),
    cc: mimeAddresses(parsed.cc),
    bcc: mimeAddresses(parsed.bcc),
    headers: (parsed.headerLines ?? []).map((h) => ({
      name: h.key.toLowerCase(),
      value: h.line
        .slice(h.line.indexOf(":") + 1)
        .replace(/\r?\n[ \t]+/g, " ")
        .trim(),
    })),
    ...(parsed.messageId ? { rfcMessageId: parsed.messageId } : {}),
    ...(meta.size !== undefined ? { size: meta.size } : {}),
    replyTo: mimeAddresses(parsed.replyTo),
    date: Number.isFinite(received) ? received : (parsed.date?.getTime() ?? 0),
    snippet: text.replace(/\s+/g, " ").trim().slice(0, 200),
    bodyText: text,
    bodyHtml: html,
    security: messageSecurity(
      (parsed.headerLines ?? []).map((h) => ({
        name: h.key,
        value: h.line.slice(h.line.indexOf(":") + 1).trim(),
      })),
      "imap",
      meta.authservId,
    ),
    ...(parsed.attachments.some(
      (a) => a.contentType === "text/calendar" || /\.ics$/i.test(a.filename ?? ""),
    )
      ? { hasCalendar: true }
      : {}),
    labels,
    attachments:
      meta.attachments ??
      parsed.attachments
        .filter((a) => !a.related)
        .map((a) => ({
          filename: a.filename ?? "attachment",
          mimeType: a.contentType,
          size: a.size,
        })),
    isUnread: labels.includes("UNREAD"),
    isStarred: labels.includes("STARRED"),
  };
}

// Send

/** Header block of a raw message, unfolded, as lower-case name to value. */
export function parseHeaders(raw: Buffer | string): Map<string, string> {
  const text = Predicate.isString(raw) ? raw : raw.toString("latin1");
  const end = text.search(/\r?\n\r?\n/);
  return firstHeaders(cachedHeaders("", end === -1 ? text : text.slice(0, end)));
}

/** Removes Bcc headers so SMTP recipients never see them. The envelope still carries the addresses. */
export function stripBcc(raw: Buffer): Buffer {
  const text = raw.toString("latin1");
  const match = /\r?\n(?=\r?\n)/.exec(text);
  // Header lines up to and including the newline of the last one; latin1 keeps byte offsets.
  const end = match ? match.index + match[0].length : text.length;
  const kept: string[] = [];
  let dropping = false;
  for (const line of text.slice(0, end).split(/(?<=\n)/)) {
    // Folded continuation lines belong to the header before them.
    if (!/^[ \t]/.test(line)) dropping = /^bcc:/i.test(line);
    if (!dropping) kept.push(line);
  }
  return Buffer.concat([Buffer.from(kept.join(""), "latin1"), raw.subarray(end)]);
}

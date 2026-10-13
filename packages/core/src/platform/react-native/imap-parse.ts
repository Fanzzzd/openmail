/** Folder listing and FETCH parsing for the portable IMAP client, and IncomingMessage from a parsed message. */

import {
  AuthError,
  PermanentError,
  ProviderError,
  type ProviderFailure,
} from "../../domain/errors.js";
import { decodeProviderId, encodeProviderId } from "../../providers/imap/imap-cursor.js";
import { Effect, Option } from "effect";
import { decodeFolder, type ImapResponse, type ImapValue, type ImapWire } from "../mail-socket.js";
import { Buffer } from "../bytes.js";
import { IMAP_SPECIAL_LABELS as SPECIAL, flagsOf } from "../../providers/imap/imap-helpers.js";
import { mimeAddresses, type MimeMessage } from "../mail-codec.js";
import type { IncomingMessage } from "../../domain/message.js";
import { htmlToText } from "../../mime/mime.js";
import { cachedHeaders } from "../../sync/header-backfill.js";

const FOLDER_ALIASES: Record<string, readonly string[]> = {
  SENT: ["sent", "sent items", "sent messages"],
  DRAFT: ["draft", "drafts"],
  SPAM: ["junk", "junk email", "spam"],
  TRASH: ["trash", "deleted items", "deleted messages", "bin"],
  ARCHIVE: ["archive", "archives"],
};
const folderLabel = (path: string) => {
  const leaf = /^INBOX[./]/i.test(path) ? (path.split(/[./]/).at(-1) ?? path) : path;
  return (
    Object.entries(FOLDER_ALIASES).find(([, aliases]) =>
      aliases.includes(leaf.toLowerCase()),
    )?.[0] ?? path
  );
};
export const address = (value: string) => {
  if (!/^[^\s<>\r\n\0]+@[^\s<>\r\n\0]+$/.test(value))
    throw new PermanentError({ message: "Invalid SMTP envelope address" });
  return `<${value}>`;
};
export const refOf = (id: string) => {
  const ref = decodeProviderId(id);
  if (Option.isNone(ref) || !Number.isSafeInteger(ref.value.uid) || ref.value.uid < 1)
    throw new PermanentError({ message: "Invalid IMAP message id" });
  return ref.value;
};
export const unsupported = () =>
  Effect.fail(new PermanentError({ message: "This operation is unavailable for mobile IMAP" }));
export interface Folder {
  path: string;
  name: string;
  label: string;
}
export const text = (value: ImapValue | undefined) =>
  typeof value === "string"
    ? value
    : value instanceof Uint8Array
      ? Buffer.from(value).toString("utf8")
      : "";
export const array = (value: ImapValue | undefined): ImapValue[] =>
  Array.isArray(value) ? value : [];
export const failure = (error: unknown): ProviderFailure =>
  error instanceof AuthError || error instanceof PermanentError || error instanceof ProviderError
    ? error
    : new ProviderError({ message: "Mail server connection or command failed" });
export const folders = async (client: ImapWire): Promise<Folder[]> => {
  const rows = await client.command('LIST "" "*"');
  return rows.flatMap((row) => {
    if (text(row.values[1]).toUpperCase() !== "LIST") return [];
    const flags = array(row.values[2]).map(text);
    if (flags.some((flag) => /\\(?:Noselect|NonExistent|All|Flagged)$/i.test(flag))) return [];
    const path = decodeFolder(text(row.values[4]));
    const delimiter = text(row.values[3]);
    const special = flags
      .map((flag) => Object.keys(SPECIAL).find((key) => key.toLowerCase() === flag.toLowerCase()))
      .find(Boolean);
    return [
      {
        path,
        name: delimiter && delimiter !== "NIL" ? path.split(delimiter).join("/") : path,
        label:
          path.toUpperCase() === "INBOX"
            ? "INBOX"
            : special
              ? (SPECIAL[special] ?? path)
              : folderLabel(path),
      },
    ];
  });
};
const parseFetch = (row: ImapResponse) => {
  const values = array(row.values[3]);
  const field = (name: string) => {
    const matches = values.flatMap((value, index) =>
      typeof value === "string" && value.toUpperCase() === name ? [index] : [],
    );
    if (matches.length > 1) throw new ProviderError({ message: "Duplicate IMAP FETCH field" });
    const index = matches[0];
    return index === undefined ? undefined : values[index + 1];
  };
  return {
    uid: Number(text(field("UID"))),
    size: Number(text(field("RFC822.SIZE"))),
    flags: array(field("FLAGS")).map(text),
    raw: values.find((v) => v instanceof Uint8Array),
  };
};
/** A FETCH command may return one row per UID. Reject ambiguous duplicates. */
export const fetchFields = (rows: readonly ImapResponse[]) => {
  const seen = new Set<number>();
  return rows
    .filter((row) => text(row.values[2]).toUpperCase() === "FETCH")
    .map((row) => {
      const fields = parseFetch(row);
      if (!Number.isSafeInteger(fields.uid) || fields.uid < 1 || seen.has(fields.uid))
        throw new ProviderError({ message: "Invalid or duplicate IMAP FETCH UID" });
      seen.add(fields.uid);
      return fields;
    });
};
export const fetchRawIn = async (client: ImapWire, id: string, maxBytes = 25 * 1024 * 1024) => {
  const ref = refOf(id);
  await client.select(ref.path, ref.uidValidity);
  const metadata = fetchFields(await client.command(`UID FETCH ${ref.uid} (UID RFC822.SIZE)`))[0];
  if (!metadata || metadata.uid !== ref.uid)
    throw new PermanentError({ message: "Message is gone" });
  if (
    !Number.isSafeInteger(metadata.size) ||
    metadata.size < 0 ||
    metadata.size > Math.min(maxBytes, 25 * 1024 * 1024)
  )
    throw new PermanentError({ message: "Message exceeds mobile download limit" });
  const rows = await client.command(`UID FETCH ${ref.uid} (UID FLAGS RFC822.SIZE BODY.PEEK[])`);
  const fetched = fetchFields(rows).find((r) => r.uid === ref.uid);
  if (!(fetched?.raw instanceof Uint8Array))
    throw new PermanentError({ message: "Message is gone" });
  if (fetched.raw.byteLength > maxBytes)
    throw new PermanentError({ message: "Message exceeds download limit" });
  return fetched;
};

export function mobileIncoming(
  parsed: MimeMessage,
  path: Folder,
  validity: string,
  uid: number,
  flags: readonly string[],
  size: number,
): IncomingMessage {
  const state = flagsOf(flags);
  const labels = [
    path.label,
    ...(state.unread ? ["UNREAD"] : []),
    ...(state.starred ? ["STARRED"] : []),
  ];
  const stringHeader = (name: string) => {
    const value = parsed.headers.get(name);
    return typeof value === "string" ? value : "";
  };
  const messageId = stringHeader("message-id");
  const root = (stringHeader("references") || parsed.inReplyTo || messageId).match(
    /<([^<>]+)>/,
  )?.[1];
  const bodyHtml = parsed.html || "";
  const bodyText = parsed.text ?? htmlToText(bodyHtml);
  const providerId = encodeProviderId(path.path, validity, uid);
  const date = parsed.date?.getTime() ?? 0;
  return {
    providerId,
    threadId: root ?? providerId,
    ...(!stringHeader("references") && parsed.inReplyTo
      ? {
          parentRfcMessageId:
            parsed.inReplyTo.match(/<([^<>\s]+)>/)?.[1] ?? parsed.inReplyTo.split(/\s+/)[0],
        }
      : {}),
    subject: parsed.subject ?? "",
    from: mimeAddresses(parsed.from)[0] ?? { name: "", address: "" },
    to: mimeAddresses(parsed.to),
    cc: mimeAddresses(parsed.cc),
    bcc: mimeAddresses(parsed.bcc),
    headers: cachedHeaders(
      providerId,
      (parsed.headerLines ?? []).map((header) => header.line).join("\r\n"),
    ).headers,
    replyTo: mimeAddresses(parsed.replyTo),
    ...(messageId ? { rfcMessageId: messageId } : {}),
    size,
    date: Number.isFinite(date) ? date : 0,
    snippet: bodyText.replace(/\s+/g, " ").slice(0, 200),
    bodyHtml,
    bodyText,
    labels,
    attachments: parsed.attachments
      .filter((p) => !p.related)
      .map((p) => ({
        filename: p.filename ?? "attachment",
        mimeType: p.contentType,
        size: p.size,
      })),
    isUnread: state.unread,
    isStarred: state.starred,
  };
}

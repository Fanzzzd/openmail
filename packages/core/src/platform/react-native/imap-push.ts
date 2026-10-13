/** Applies one MailOp to messages on the IMAP server. */

import {
  ImapCommandError,
  encodeFolder,
  mailQuote,
  type ImapResponse,
  type ImapWire,
} from "../mail-socket.js";
import {
  encodeProviderId,
  folderRegressed,
  parseUidSet,
  uidSet,
  type FolderCursor,
} from "../../providers/imap/imap-cursor.js";
import type {
  ProviderIdMapping,
  ProviderPushContext,
  ProviderPushResult,
} from "../../providers/adapter.js";
import { fetchFields, folders, refOf } from "./imap-parse.js";
import { PermanentError, ProviderError } from "../../domain/errors.js";
import { copyProgressKey } from "../../providers/imap/imap-helpers.js";
import { Buffer } from "../bytes.js";
import { messageIdKey } from "../../mime/message-id.js";
import { Effect } from "effect";

export const applyPush = async (
  client: ImapWire,
  ids: readonly string[],
  op: import("../../domain/changes.js").MailOp,
  messageIds: Map<string, string>,
  copiedDestinations: Set<string>,
  expected?: FolderCursor,
  context?: ProviderPushContext,
  signal?: AbortSignal,
): Promise<ProviderPushResult> => {
  const first = ids[0];
  if (!first) return [];
  const ref = refOf(first);
  const uids = ids.map((id) => refOf(id).uid);
  const range = uidSet(uids);
  const validity = await client.select(ref.path, undefined, false);
  const regressed =
    validity === ref.uidValidity && folderRegressed(expected, ref.uidValidity, client.uidNext);
  if (
    validity !== ref.uidValidity ||
    (expected && expected.uidValidity !== ref.uidValidity) ||
    regressed
  )
    throw new PermanentError({
      message: "Folder was rebuilt; sync before changing this message",
      ...(regressed ? { imapReset: { path: ref.path, uidValidity: ref.uidValidity } } : {}),
    });
  const moving = !["read", "star", "important", "categories", "copy"].includes(op.kind);
  const present = await client.search(`${moving ? "" : "UNDELETED "}UID ${range}`);
  if (
    ["read", "star", "important", "categories"].includes(op.kind) &&
    uids.some((uid) => !present.includes(uid))
  )
    throw new PermanentError({ message: "Message is gone" });
  if (op.kind === "read" || op.kind === "star" || op.kind === "important") {
    const flag = op.kind === "read" ? "\\Seen" : op.kind === "star" ? "\\Flagged" : "$Important";
    await client.command(`UID STORE ${range} ${op.value ? "+" : "-"}FLAGS.SILENT (${flag})`);
    return [];
  }
  if (op.kind === "categories" || op.kind === "classification")
    throw new PermanentError({ message: "Categories require Outlook" });
  const list = await folders(client);
  const label =
    op.kind === "archive"
      ? "ARCHIVE"
      : op.kind === "trash"
        ? "TRASH"
        : op.kind === "spam"
          ? "SPAM"
          : "INBOX";
  let target =
    op.kind === "move"
      ? op.labelId
      : op.kind === "label"
        ? op.value
          ? op.labelId
          : ref.path === op.labelId
            ? "INBOX"
            : ref.path
        : list.find((f) => f.label === label)?.path;
  if (!target && ["archive", "trash", "spam"].includes(op.kind)) {
    target = label === "ARCHIVE" ? "Archive" : label === "TRASH" ? "Trash" : "Junk";
    try {
      await client.command(`CREATE ${mailQuote(encodeFolder(target))}`);
    } catch (error) {
      if (
        !(
          error instanceof ImapCommandError &&
          error.status === "NO" &&
          error.responseCode === "ALREADYEXISTS"
        )
      )
        throw error;
    }
    list.push({ path: target, label, name: target });
  }
  const targets = op.kind === "copy" ? [...new Set(op.labelIds)] : target ? [target] : [];
  if (!targets.length && op.kind === "copy") return [];
  if (!targets.length) throw new PermanentError({ message: "Destination folder is unavailable" });
  const mappings: ProviderIdMapping[] = [];
  let reconcile = false;
  for (const destination of targets) {
    if (destination === ref.path) continue;
    if (!list.some((f) => f.path === destination))
      throw new PermanentError({ message: "Destination folder is gone" });
    for (const uid of uids) {
      const id = encodeProviderId(ref.path, ref.uidValidity, uid);
      const progressKey = copyProgressKey(id, destination);
      const acceptedKey = copyProgressKey(id, destination, true);
      const progress = context?.progress ?? copiedDestinations;
      const issued = progress.has(progressKey);
      const accepted = progress.has(acceptedKey);
      if (!present.includes(uid) && !issued)
        throw new PermanentError({ message: "Message is gone" });
      let messageId = messageIds.get(id);
      if (present.includes(uid)) {
        await client.select(ref.path, ref.uidValidity, false);
        const rows = fetchFields(
          await client.command(`UID FETCH ${uid} (UID BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])`),
        );
        const raw = rows.find((row) => row.uid === uid)?.raw;
        if (!(raw instanceof Uint8Array))
          throw new ProviderError({
            message: "Message headers are unavailable; sync before copying this message",
          });
        const actualMessageId = /^Message-ID:[ \t]*([^\r\n]+)$/im
          .exec(
            Buffer.from(raw)
              .toString("utf8")
              .replace(/\r?\n[ \t]+/g, " "),
          )?.[1]
          ?.trim();
        if (messageId && messageIdKey(messageId) !== messageIdKey(actualMessageId ?? ""))
          throw new PermanentError({
            message: "Message identity changed; sync before changing this message",
          });
        messageId = actualMessageId;
        if (messageId) messageIds.set(id, messageId);
      }
      let destinationRef: { uidValidity: string; uid: number } | undefined;
      if (issued) {
        if (messageId) {
          const uidValidity = await client.select(destination);
          const found = (
            await client.search(
              `UNDELETED HEADER Message-ID ${mailQuote(`<${messageIdKey(messageId)}>`)}`,
            )
          )[0];
          if (found !== undefined) destinationRef = { uidValidity, uid: found };
        }
        if (!destinationRef && (messageId || !accepted))
          throw new ProviderError({
            message: "Copied message is not yet visible; sync before retrying this change",
          });
      } else {
        await client.select(ref.path, ref.uidValidity, false);
        if (context?.beforeCopy)
          await Effect.runPromise(context.beforeCopy(destination, [id]), { signal });
        copiedDestinations.add(progressKey);
        let copied: ImapResponse[];
        try {
          copied = await client.command(`UID COPY ${uid} ${mailQuote(encodeFolder(destination))}`);
        } catch (error) {
          if (error instanceof ImapCommandError) {
            if (context?.clearCopy)
              await Effect.runPromise(context.clearCopy(destination, [id]), { signal });
            copiedDestinations.delete(progressKey);
            copiedDestinations.delete(acceptedKey);
          }
          throw error;
        }
        copiedDestinations.add(acceptedKey);
        if (context?.afterCopy)
          await Effect.runPromise(context.afterCopy(destination, [id]), { signal });
        const response = copied
          .map((row) => /\[COPYUID (\d+) ([\d:,]+) ([\d:,]+)\]/i.exec(row.text))
          .find(Boolean);
        const copiedValidity = response?.[1];
        const sources = response?.[2] ? parseUidSet(response[2], 1) : [];
        const destinations = response?.[3] ? parseUidSet(response[3], 1) : [];
        if (
          copiedValidity &&
          sources.length === 1 &&
          sources[0] === uid &&
          destinations.length === 1 &&
          destinations[0]
        )
          destinationRef = { uidValidity: copiedValidity, uid: destinations[0] };
        else if (messageId) {
          const uidValidity = await client.select(destination);
          const found = (
            await client.search(
              `UNDELETED HEADER Message-ID ${mailQuote(`<${messageIdKey(messageId)}>`)}`,
            )
          )[0];
          if (found !== undefined) destinationRef = { uidValidity, uid: found };
        }
      }
      if (moving) {
        if (!destinationRef && messageId)
          throw new ProviderError({
            message: "Moved message UID is unavailable; sync before retrying this change",
          });
        if (present.includes(uid)) {
          await client.select(ref.path, ref.uidValidity, false);
          await client.command(`UID STORE ${uid} +FLAGS.SILENT (\\Deleted)`);
          if (client.capabilities.has("UIDPLUS")) await client.command(`UID EXPUNGE ${uid}`);
        }
        if (destinationRef)
          mappings.push({
            from: id,
            to: encodeProviderId(destination, destinationRef.uidValidity, destinationRef.uid),
          });
        else reconcile = true;
      }
    }
  }
  if (op.kind === "copy")
    for (const destination of targets)
      for (const id of ids) {
        copiedDestinations.delete(copyProgressKey(id, destination));
        copiedDestinations.delete(copyProgressKey(id, destination, true));
      }
  return reconcile ? { reconcile: true } : mappings;
};

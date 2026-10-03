import { FolderStatus } from "../../sync-health.js";
import type { ResetVerification } from "../../sync-reset.js";
import { Clock, Effect, Option, Queue, Schema, Scope, Semaphore, Stream } from "effect";
import { Buffer } from "../bytes.js";
import { MailCodec, mimeAddresses, type MimeMessage } from "../mail-codec.js";
import {
  MailTransport,
  MailWire,
  writeMailChunks,
  ImapWire,
  ImapCommandError,
  mailQuote,
  encodeFolder,
  decodeFolder,
  type ImapResponse,
  type ImapValue,
} from "../mail-socket.js";
import {
  Secrets,
  type ProviderAdapter,
  type Change,
  type ProviderPushContext,
  type ProviderPushResult,
  type ProviderIdMapping,
} from "../../services.js";
import {
  AuthError,
  InvalidInput,
  PermanentError,
  ProviderError,
  SendUncertain,
  type ProviderFailure,
} from "../../errors.js";
import { serverSavesSent, resolveImapSettings, imapSettingsKey } from "../../imap-settings.js";
import {
  encodeProviderId,
  decodeProviderId,
  FolderState,
  readCursor,
  uidSet,
  parseUidSet,
  type FolderCursor,
  type ImapCursor,
} from "../../imap-cursor.js";
import type { Account, ImapSettings, IncomingMessage } from "../../domain.js";
import { confirmDelivery } from "../../provider-send.js";
import { htmlToText } from "../../mime.js";
import { matchesSearch, searchMailboxLabel } from "../../search.js";

const SPECIAL: Record<string, string> = {
  "\\Inbox": "INBOX",
  "\\Sent": "SENT",
  "\\Drafts": "DRAFT",
  "\\Junk": "SPAM",
  "\\Trash": "TRASH",
  "\\Archive": "ARCHIVE",
};
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
const normalizedMessageId = (value: string) => value.replace(/[<>\s]/g, "");
const address = (value: string) => {
  if (!/^[^\s<>\r\n\0]+@[^\s<>\r\n\0]+$/.test(value))
    throw new PermanentError({ message: "Invalid SMTP envelope address" });
  return `<${value}>`;
};
const refOf = (id: string) => {
  const ref = decodeProviderId(id);
  if (Option.isNone(ref) || !Number.isSafeInteger(ref.value.uid) || ref.value.uid < 1)
    throw new PermanentError({ message: "Invalid IMAP message id" });
  return ref.value;
};
const unsupported = () =>
  Effect.fail(new PermanentError({ message: "This operation is unavailable for mobile IMAP" }));
interface Folder {
  path: string;
  name: string;
  label: string;
}
const text = (value: ImapValue | undefined) =>
  typeof value === "string"
    ? value
    : value instanceof Uint8Array
      ? Buffer.from(value).toString("utf8")
      : "";
const array = (value: ImapValue | undefined): ImapValue[] => (Array.isArray(value) ? value : []);
const failure = (error: unknown): ProviderFailure =>
  error instanceof AuthError || error instanceof PermanentError || error instanceof ProviderError
    ? error
    : new ProviderError({ message: "Mail server connection or command failed" });
const folders = async (client: ImapWire): Promise<Folder[]> => {
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
const flagsOf = (flags: readonly string[]) => ({
  unread: !flags.includes("\\Seen"),
  starred: flags.includes("\\Flagged"),
});
const fetchRawIn = async (client: ImapWire, id: string, maxBytes = 25 * 1024 * 1024) => {
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

const uncertain = () =>
  new SendUncertain({
    message: "This message may have been sent. Check Sent before sending it again.",
  });

/** SMTP STARTTLS is mandatory on submission ports; no credentials precede TLS. */
export async function smtpSession(
  transport: MailTransport["Service"],
  settings: ImapSettings,
  pass: string,
  accountId: string,
  signal: AbortSignal,
  deliver?: { from: string; to: readonly string[]; raw: Uint8Array },
) {
  const socket = await transport.connect({
    host: settings.smtpHost,
    port: settings.smtpPort,
    tls: settings.smtpSecure,
    signal,
  });
  const wire = new MailWire(socket);
  const reply = async (expected: number[], final = false) => {
    const { code, lines } = await wire.smtpReply().catch((error: unknown) => {
      if (final) throw uncertain();
      throw error;
    });
    if (code === 535 || code === 534)
      throw new AuthError({ accountId, message: "SMTP login rejected" });
    if (!expected.includes(code)) {
      if (code >= 500) throw new PermanentError({ message: `SMTP rejected the message (${code})` });
      throw new ProviderError({ message: `SMTP command rejected (${code})` });
    }
    return lines;
  };
  const command = async (value: string, expected: number[]) => {
    await wire.write(value);
    return reply(expected);
  };
  try {
    await reply([220]);
    let ehlo = await command("EHLO openmail.local", [250]);
    if (!settings.smtpSecure) {
      if (!ehlo.some((line) => /^250[- ]STARTTLS\b/i.test(line)))
        throw new ProviderError({ message: "SMTP requires STARTTLS" });
      await command("STARTTLS", [220]);
      await wire.upgrade();
      ehlo = await command("EHLO openmail.local", [250]);
    }
    if (ehlo.some((line) => /^250[- ]AUTH.*\bPLAIN\b/i.test(line))) {
      await command(
        `AUTH PLAIN ${Buffer.from(`\0${settings.username}\0${pass}`).toString("base64")}`,
        [235],
      );
    } else if (ehlo.some((line) => /^250[- ]AUTH.*\bLOGIN\b/i.test(line))) {
      await command("AUTH LOGIN", [334]);
      await command(Buffer.from(settings.username).toString("base64"), [334]);
      await command(Buffer.from(pass).toString("base64"), [235]);
    } else throw new ProviderError({ message: "SMTP password authentication unavailable" });
    if (deliver) {
      await command(`MAIL FROM:${address(deliver.from)}`, [250]);
      for (const recipient of new Set(deliver.to))
        await command(`RCPT TO:${address(recipient)}`, [250, 251]);
      await command("DATA", [354]);
      // Preserve MIME bytes with latin1; remove folded Bcc and dot-stuff every line.
      const raw = Buffer.from(deliver.raw).toString("latin1");
      const end = raw.indexOf("\r\n\r\n");
      if (end < 0) throw new PermanentError({ message: "Invalid outgoing MIME" });
      let dropping = false;
      const headers = raw
        .slice(0, end)
        .split("\r\n")
        .filter((line) => {
          if (!/^[ \t]/.test(line)) dropping = /^bcc:/i.test(line);
          return !dropping;
        })
        .join("\r\n");
      const data = `${headers}\r\n\r\n${raw.slice(end + 4)}`.replace(/(^|\r\n)\./g, "$1..");
      try {
        await writeMailChunks(
          socket,
          Buffer.from(`${data.replace(/\r\n$/, "")}\r\n.\r\n`, "latin1"),
        );
      } catch {
        throw uncertain();
      }
      // An explicit rejection is definite; only a missing final reply is ambiguous.
      await reply([250], true);
    }
    // Delivery was acknowledged. A failed QUIT must not turn it into a failed send.
    await command("QUIT", [221]).catch(() => null);
  } finally {
    socket.close();
  }
}

const applyPush = async (
  client: ImapWire,
  ids: readonly string[],
  op: import("../../domain.js").MailOp,
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
    expected?.uidValidity === ref.uidValidity &&
    validity === ref.uidValidity &&
    client.uidNext !== undefined &&
    client.uidNext < expected.lastUid + 1;
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
  if (op.kind === "categories") throw new PermanentError({ message: "Categories require Outlook" });
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
      const progressKey = JSON.stringify([id, destination]);
      const acceptedKey = JSON.stringify([id, destination, "accepted"]);
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
        if (
          messageId &&
          normalizedMessageId(messageId) !== normalizedMessageId(actualMessageId ?? "")
        )
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
              `UNDELETED HEADER Message-ID ${mailQuote(`<${normalizedMessageId(messageId)}>`)}`,
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
              `UNDELETED HEADER Message-ID ${mailQuote(`<${normalizedMessageId(messageId)}>`)}`,
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
        copiedDestinations.delete(JSON.stringify([id, destination]));
        copiedDestinations.delete(JSON.stringify([id, destination, "accepted"]));
      }
  return reconcile ? { reconcile: true } : mappings;
};

export const makeMobileImap = Effect.gen(function* () {
  const transport = yield* MailTransport;
  const secrets = yield* Secrets;
  const codec = yield* MailCodec;
  const observedSent = new Set<string>();
  const namespaces = new Map<string, ImapCursor>();
  const pushMessageIds = new Map<string, Map<string, string>>();
  const copiedDestinations = new Map<string, Set<string>>();
  const copiedFor = (accountId: string) => {
    let copies = copiedDestinations.get(accountId);
    if (!copies) {
      copies = new Set();
      copiedDestinations.set(accountId, copies);
    }
    return copies;
  };
  const messageIdsFor = (accountId: string, queued?: ReadonlyMap<string, string>) => {
    let ids = pushMessageIds.get(accountId);
    if (!ids) {
      ids = new Map();
      pushMessageIds.set(accountId, ids);
    }
    for (const [id, messageId] of queued ?? []) ids.set(id, messageId);
    return ids;
  };
  const pushState = (account: Account, path: string, cursor?: string) =>
    readCursor(Option.fromNullishOr(cursor)).folders[path] ??
    namespaces.get(account.id)?.folders[path];
  const credentials = (account: Account) =>
    Effect.gen(function* () {
      if (!account.imap) return yield* new PermanentError({ message: "Missing IMAP settings" });
      const stored = yield* secrets.get(account.id);
      if (Option.isNone(stored))
        return yield* new AuthError({ accountId: account.id, message: "No stored app password" });
      return { settings: account.imap, pass: stored.value };
    });
  const open = async (
    settings: ImapSettings,
    pass: string,
    accountId: string,
    signal: AbortSignal,
  ) => {
    const socket = await transport.connect({
      host: settings.imapHost,
      port: settings.imapPort,
      tls: settings.imapPort === 993,
      signal,
    });
    const client = new ImapWire(new MailWire(socket));
    return client.run(signal, async () => {
      try {
        const greeting = await client.response();
        if (!/^\* (OK|PREAUTH)\b/i.test(greeting.text))
          throw new ProviderError({ message: "Invalid IMAP greeting" });
        await client.capability();
        if (settings.imapPort !== 993) {
          if (!client.capabilities.has("STARTTLS"))
            throw new ProviderError({ message: "IMAP requires STARTTLS" });
          await client.command("STARTTLS");
          await client.wire.upgrade();
          await client.capability();
        }
        if (!/^\* PREAUTH\b/i.test(greeting.text)) {
          try {
            if (Array.from(pass).some((character) => character.charCodeAt(0) > 127)) {
              const literal = Buffer.from(pass, "utf8");
              await client.command(
                `LOGIN ${mailQuote(settings.username)} {${literal.length}}`,
                literal,
              );
            } else await client.command(`LOGIN ${mailQuote(settings.username)} ${mailQuote(pass)}`);
          } catch (error) {
            if (error instanceof ImapCommandError && error.status === "NO")
              throw new AuthError({ accountId, message: "IMAP login rejected" });
            throw error;
          }
        }
        await client.capability();
        if (client.capabilities.has("ID"))
          await client.command('ID ("name" "openmail" "version" "0.1.0" "vendor" "openmail")');
        return client;
      } catch (error) {
        socket.close();
        throw error;
      }
    });
  };
  const session = <A>(
    account: Account,
    work: (
      client: ImapWire,
      settings: ImapSettings,
      pass: string,
      signal: AbortSignal,
    ) => Promise<A>,
  ) =>
    credentials(account).pipe(
      Effect.flatMap(({ settings, pass }) =>
        Effect.tryPromise({
          try: async (signal) => {
            const client = await open(settings, pass, account.id, signal);
            try {
              return await client.run(signal, () => work(client, settings, pass, signal));
            } finally {
              client.wire.socket.close();
            }
          },
          catch: failure,
        }),
      ),
    );
  const incoming = async (client: ImapWire, path: Folder, validity: string, uid: number) => {
    const row = await fetchRawIn(client, encodeProviderId(path.path, validity, uid));
    if (row.flags.includes("\\Deleted")) throw new PermanentError({ message: "Message is gone" });
    if (!(row.raw instanceof Uint8Array))
      throw new PermanentError({ message: "Missing mail source" });
    return mobileIncoming(await codec.parse(row.raw), path, validity, uid, row.flags, row.size);
  };
  const fetchRaw: ProviderAdapter["fetchRaw"] = (account, id, maxBytes) =>
    session(account, async (client) => {
      const row = await fetchRawIn(client, id, maxBytes);
      if (!(row.raw instanceof Uint8Array))
        throw new PermanentError({ message: "Missing mail source" });
      return row.raw;
    });
  const verifyResetCandidates: NonNullable<ProviderAdapter["verifyResetCandidates"]> = (
    account,
    candidates,
  ) =>
    session(account, async (client) => {
      const list = await folders(client);
      if (!list.length) return [];
      const results: ResetVerification[] = [];
      const groups = new Map<string, typeof candidates>();
      for (const candidate of candidates) {
        const ref = decodeProviderId(candidate.resetProviderId ?? candidate.providerId);
        if (Option.isSome(ref))
          groups.set(ref.value.path, [...(groups.get(ref.value.path) ?? []), candidate]);
      }
      for (const [path, group] of groups) {
        const original = list.find((folder) => folder.path === path);
        const validity = original ? await client.select(path) : undefined;
        const uids = group.flatMap((candidate) => {
          const ref = decodeProviderId(candidate.resetProviderId ?? candidate.providerId);
          return !candidate.resetProviderId &&
            Option.isSome(ref) &&
            ref.value.uidValidity === validity
            ? [ref.value.uid]
            : [];
        });
        const present = new Set(
          uids.length ? await client.search(`UNDELETED UID ${uidSet(uids)}`) : [],
        );
        for (const candidate of group) {
          const ref = decodeProviderId(candidate.resetProviderId ?? candidate.providerId);
          if (Option.isNone(ref)) continue;
          const retained = candidate.labels.filter((label) =>
            ["UNREAD", "STARRED", "IMPORTANT"].includes(label),
          );
          if (
            !candidate.resetProviderId &&
            validity === ref.value.uidValidity &&
            present.has(ref.value.uid)
          ) {
            results.push({
              kind: "present",
              id: candidate.providerId,
              providerId: candidate.providerId,
              labels: [original?.label ?? path, ...retained],
            });
            continue;
          }
          if (!candidate.rfcMessageId) {
            if (!candidate.resetProviderId && validity === ref.value.uidValidity)
              results.push({ kind: "gone", id: candidate.providerId });
            continue;
          }
          const matches: ResetVerification[] = [];
          for (const folder of list) {
            const current = await client.select(folder.path);
            for (const uid of await client.search(
              `UNDELETED HEADER Message-ID ${mailQuote(candidate.rfcMessageId)}`,
            ))
              matches.push({
                kind: "present",
                id: candidate.providerId,
                providerId: encodeProviderId(folder.path, current, uid),
                labels: [folder.label, ...retained],
              });
          }
          if (!matches.length) results.push({ kind: "gone", id: candidate.providerId });
          else if (matches.length === 1 && matches[0]) results.push(matches[0]);
        }
      }
      return results;
    });

  const fetchMessage: ProviderAdapter["fetchMessage"] = (account, id) =>
    session(account, async (client) => {
      const ref = refOf(id);
      const path = (await folders(client)).find((f) => f.path === ref.path);
      if (!path) throw new PermanentError({ message: "Folder is gone" });
      return incoming(client, path, ref.uidValidity, ref.uid);
    });
  const owner = yield* Effect.serviceOption(Scope.Scope);
  const pushClients = new Map<string, { client: ImapWire; key: string }>();
  const pushLocks = new Map<string, Semaphore.Semaphore>();
  if (Option.isSome(owner))
    yield* Scope.addFinalizer(
      owner.value,
      Effect.sync(() => {
        for (const pool of pushClients.values()) pool.client.wire.socket.close();
      }),
    );
  const pushSession = <A>(
    account: Account,
    work: (client: ImapWire, signal: AbortSignal) => Promise<A>,
  ) => {
    let lock = pushLocks.get(account.id);
    if (!lock) {
      lock = Semaphore.makeUnsafe(1);
      pushLocks.set(account.id, lock);
    }
    return credentials(account).pipe(
      Effect.flatMap(({ settings, pass }) =>
        Effect.tryPromise({
          try: async (signal) => {
            const key = imapSettingsKey(settings);
            let pool = pushClients.get(account.id);
            if (pool && pool.key !== key) {
              pool.client.wire.socket.close();
              pushClients.delete(account.id);
              pool = undefined;
            }
            if (pool) {
              try {
                await Effect.runPromise(
                  Effect.tryPromise((noopSignal) =>
                    pool!.client.run(noopSignal, () => pool!.client.command("NOOP")),
                  ).pipe(Effect.timeout("5 seconds")),
                  { signal },
                );
              } catch {
                pool.client.wire.socket.close();
                pushClients.delete(account.id);
                pool = undefined;
                signal.throwIfAborted();
              }
            }
            const client = pool?.client ?? (await open(settings, pass, account.id, signal));
            if (Option.isSome(owner)) pushClients.set(account.id, { client, key });
            const abort = () => {
              client.wire.socket.close();
              if (pushClients.get(account.id)?.client === client) pushClients.delete(account.id);
            };
            signal.addEventListener("abort", abort, { once: true });
            try {
              return await client.run(signal, () => work(client, signal));
            } catch (error) {
              client.wire.socket.close();
              pushClients.delete(account.id);
              throw error;
            } finally {
              signal.removeEventListener("abort", abort);
              if (Option.isNone(owner)) client.wire.socket.close();
            }
          },
          catch: failure,
        }),
      ),
      lock.withPermits(1),
    );
  };
  const closeSessions: NonNullable<ProviderAdapter["closeSessions"]> = (id) =>
    Effect.forEach(
      id ? [id] : [...pushClients.keys()],
      (accountId) =>
        Effect.sync(() => {
          const pool = pushClients.get(accountId);
          pool?.client.wire.socket.close();
          pushClients.delete(accountId);
        }).pipe(pushLocks.get(accountId)?.withPermits(1) ?? ((effect) => effect)),
      { discard: true },
    );
  const pushBatch: NonNullable<ProviderAdapter["pushBatch"]> = (
    account,
    ids,
    op,
    cursor,
    context,
  ) =>
    pushSession(account, async (client, signal) => {
      const groups = new Map<string, [string, ...string[]]>();
      for (const id of ids) {
        const ref = refOf(id);
        const key = `${ref.uidValidity}:${ref.path}`;
        const group = groups.get(key);
        if (group) group.push(id);
        else groups.set(key, [id]);
      }
      const mappings: ProviderIdMapping[] = [];
      let reconcile = false;
      for (const group of groups.values()) {
        const moved = await applyPush(
          client,
          group,
          op,
          messageIdsFor(account.id, context?.messageIds),
          copiedFor(account.id),
          pushState(account, refOf(group[0]).path, cursor),
          context,
          signal,
        );
        if (moved && "reconcile" in moved) reconcile = true;
        else if (moved) mappings.push(...moved);
      }
      return reconcile ? { reconcile: true } : mappings;
    });
  const push: ProviderAdapter["push"] = (account, id, op, cursor, context) =>
    pushSession(account, (client, signal) =>
      applyPush(
        client,
        [id],
        op,
        messageIdsFor(account.id, context?.messageIds),
        copiedFor(account.id),
        pushState(account, refOf(id).path, cursor),
        context,
        signal,
      ),
    );
  const PageCursor = Schema.fromJsonString(
    Schema.Struct({ path: Schema.String, validity: Schema.String, upper: Schema.Int }),
  );
  const pageCursor = Schema.decodeUnknownSync(PageCursor);

  const adapter: ProviderAdapter = {
    folderStatus: (account, path) =>
      session(account, async (client) => {
        const rows = await client.command(
          `STATUS ${mailQuote(encodeFolder(path))} (MESSAGES UNSEEN UIDNEXT UIDVALIDITY)`,
        );
        const row = rows.find((response) => text(response.values[1]).toUpperCase() === "STATUS");
        const values = array(row?.values[3]);
        const read = (key: string) => {
          const index = values.findIndex((value) => text(value).toUpperCase() === key);
          const value = index < 0 ? undefined : values[index + 1];
          if (typeof value !== "string" || !/^\d+$/.test(value))
            throw new ProviderError({ message: "Incomplete IMAP STATUS" });
          return value;
        };
        return Schema.decodeUnknownSync(FolderStatus)({
          total: Number(read("MESSAGES")),
          unread: Number(read("UNSEEN")),
          threads: null,
          uidNext: Number(read("UIDNEXT")),
          uidValidity: read("UIDVALIDITY"),
        });
      }),
    connect: (input) => {
      if (input.provider !== "imap")
        return Effect.fail(new InvalidInput({ message: "Expected IMAP sign-in" }));
      return resolveImapSettings(input.input).pipe(
        Effect.flatMap((settings) =>
          Effect.tryPromise({
            try: async (signal) => {
              const email = input.input.email.trim();
              const pass = input.input.password;
              const id = `imap:${email.toLowerCase()}`;
              const client = await open(settings, pass, id, signal);
              try {
                await client.command("NOOP");
                await smtpSession(transport, settings, pass, id, signal);
              } finally {
                client.wire.socket.close();
              }
              return { email, secret: pass, imap: settings };
            },
            catch: (error) =>
              error instanceof AuthError
                ? error
                : new ProviderError({ message: "Could not connect to mail servers" }),
          }),
        ),
      );
    },
    pull: (account, cursor, scope, incrementalOnly = false) =>
      Stream.callback<Change, ProviderFailure>(
        (queue) =>
          session(account, async (client, _settings, _pass, signal) => {
            const emit = (change: Change) => {
              if (change._tag === "Cursor")
                namespaces.set(account.id, readCursor(Option.some(change.cursor)));
              return Effect.runPromise(Queue.offer(queue, change), { signal });
            };
            const now = await Effect.runPromise(Clock.currentTimeMillis);
            const previous = readCursor(cursor);
            namespaces.set(account.id, previous);
            const next = readCursor(cursor);
            const list = await folders(client);
            await emit({
              _tag: "Labels",
              labels: list.map((f) => ({ id: f.label, name: f.name, color: null })),
            });
            const selected = scope ? list.filter((f) => f.label === "INBOX") : list;
            for (const path of selected) {
              const validity = await client.select(path.path);
              const old = previous.folders[path.path];
              const regressed =
                !!old &&
                old.uidValidity === validity &&
                client.uidNext !== undefined &&
                client.uidNext < old.lastUid + 1;
              const rebuilt = old && old.uidValidity !== validity ? old : undefined;
              if (incrementalOnly && (!old || old.uidValidity !== validity || regressed))
                throw new ProviderError({
                  message: "Foreground sync required to renew the cursor",
                });
              if (!old || old.uidValidity !== validity || regressed) {
                await emit({ _tag: "BackfillReset" });
              }
              const previousFolder = { path: path.path, uidValidity: old?.uidValidity ?? validity };
              if (regressed) await emit({ _tag: "InvalidateFolder", previous: previousFolder });
              const state =
                old?.uidValidity === validity && !regressed
                  ? FolderState.from(old)
                  : new FolderState(validity, 0, undefined);
              const known = [...state.flags.keys()];
              const present = new Set<number>();
              const current = new Map<number, ReturnType<typeof flagsOf>>();
              const scan =
                client.capabilities.has("CONDSTORE") ||
                regressed ||
                state.flagScanAt === undefined ||
                now - state.flagScanAt >= 10 * 60 * 1000 ||
                (old?.modseq !== undefined &&
                  client.highestModseq !== undefined &&
                  BigInt(client.highestModseq) < BigInt(old.modseq));
              for (let i = 0; i < (scan ? known.length : 0); i += 500) {
                const rows = await client.command(
                  `UID FETCH ${uidSet(known.slice(i, i + 500))} (UID FLAGS)`,
                );
                for (const row of fetchFields(rows)) {
                  if (row.flags.includes("\\Deleted")) continue;
                  present.add(row.uid);
                  current.set(row.uid, flagsOf(row.flags));
                }
              }
              if (!scan) for (const uid of known) present.add(uid);
              if (scan) state.flagScanAt = now;
              state.modseq = client.highestModseq;
              const changes = state.reconcile(path.path, present, current);
              const candidates = changes.flatMap((change) =>
                change._tag === "Delete" ? [change.providerId] : [],
              );
              if (candidates.length)
                await emit({
                  _tag: "RebuildFolder",
                  previous: previousFolder,
                  keep: [],
                  candidates,
                });
              for (const change of changes) if (change._tag !== "Delete") await emit(change);
              const since = new Date(now - 90 * 86400000);
              const date = `${since.getUTCDate()}-${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][since.getUTCMonth()]}-${since.getUTCFullYear()}`;
              const criteria =
                rebuilt || regressed
                  ? `SINCE ${date}`
                  : state.lastUid || incrementalOnly
                    ? `UID ${state.lastUid + 1}:*`
                    : `SINCE ${date}`;
              const found = await client.search(`UNDELETED ${criteria}`);
              if (regressed) state.lastUid = 0;
              const pending = found.filter((uid) => uid > state.lastUid).toSorted((a, b) => a - b);
              const newest = old && !rebuilt && !regressed ? pending : pending.slice(-1000);
              for (const [index, uid] of newest.entries()) {
                const row = await fetchRawIn(client, encodeProviderId(path.path, validity, uid));
                if (row.flags.includes("\\Deleted")) continue;
                if (!(row.raw instanceof Uint8Array))
                  throw new PermanentError({ message: "Missing mail source" });
                const message = mobileIncoming(
                  await codec.parse(row.raw),
                  path,
                  validity,
                  uid,
                  row.flags,
                  row.size,
                );
                await emit(
                  rebuilt
                    ? { _tag: "Remap", message, previous: previousFolder }
                    : { _tag: "Upsert", message },
                );
                state.flags.set(uid, { unread: message.isUnread, starred: message.isStarred });
                state.lastUid = Math.max(state.lastUid, uid);
                if (!rebuilt && !regressed && (index + 1) % 25 === 0) {
                  next.folders[path.path] = state.toCursor();
                  await emit({ _tag: "Cursor", cursor: JSON.stringify(next) });
                }
                await emit({ _tag: "Progress", fetched: index + 1, total: newest.length });
              }
              if (rebuilt)
                await emit({
                  _tag: "RebuildFolder",
                  previous: previousFolder,
                  keep: newest.map((uid) => encodeProviderId(path.path, validity, uid)),
                  since: new Date(since).setUTCHours(0, 0, 0, 0),
                  partial: true,
                });
              state.lastUid = Math.max(state.lastUid, ...newest);
              next.folders[path.path] = state.toCursor();
              await emit({ _tag: "Cursor", cursor: JSON.stringify(next) });
            }
            if (!scope)
              for (const [path, old] of Object.entries(previous.folders)) {
                if (list.some((f) => f.path === path)) continue;
                await emit({
                  _tag: "RebuildFolder",
                  previous: { path, uidValidity: old.uidValidity },
                  keep: [],
                });
                await emit({ _tag: "DeleteLabel", label: path });
                delete next.folders[path];
              }
            await emit({ _tag: "Cursor", cursor: JSON.stringify(next) });
          }).pipe(
            Effect.flatMap(() => Queue.end(queue)),
            Effect.catchCause((cause) => Queue.failCause(queue, cause)),
          ),
        { bufferSize: 64, strategy: "suspend" },
      ),
    push,
    pushBatch,
    closeSessions,
    fetchRaw,
    fetchMessage,
    verifyResetCandidates,
    fetchAttachment: (account, id, ref) =>
      fetchRaw(account, id).pipe(
        Effect.flatMap((raw) =>
          Effect.tryPromise({
            try: async () => {
              const parsed = await codec.parse(raw);
              const part = parsed.attachments.filter(
                (p) => !p.related && (p.filename ?? "attachment") === ref.filename,
              )[ref.occurrence];
              if (!part) throw new PermanentError({ message: "Attachment is gone" });
              return part.content;
            },
            catch: failure,
          }),
        ),
      ),
    send: (account, message, original) =>
      Effect.gen(function* () {
        const { settings, pass } = yield* credentials(account);
        const threading = Option.isSome(original)
          ? yield* fetchRaw(account, original.value.providerId).pipe(
              Effect.map((raw) => {
                const headers = (
                  Buffer.from(raw)
                    .toString("latin1")
                    .split(/\r?\n\r?\n/)[0] ?? ""
                ).replace(/\r?\n[ \t]+/g, " ");
                const messageId = /^Message-ID:\s*(.+)$/im.exec(headers)?.[1]?.trim();
                const refs = /^References:\s*(.+)$/im.exec(headers)?.[1]?.trim();
                return {
                  ...(messageId ? { messageId } : {}),
                  ...(refs ? { references: refs } : {}),
                };
              }),
            )
          : {};
        const raw = yield* codec.build({ name: "", address: account.email }, message, threading);
        const recipients = [...message.to, ...message.cc, ...message.bcc].map((a) => a.address);
        if (!recipients.length) return yield* new PermanentError({ message: "No recipients" });
        yield* Effect.tryPromise({
          try: (signal) =>
            smtpSession(transport, settings, pass, account.id, signal, {
              from: account.email,
              to: recipients,
              raw,
            }),
          catch: (error) => (error instanceof SendUncertain ? error : failure(error)),
        }).pipe(
          Effect.catchIf(
            (error) => error._tag === "SendUncertain",
            () =>
              confirmDelivery(
                session(account, async (client) => {
                  const sent = (await folders(client)).find((folder) => folder.label === "SENT");
                  const parsed = await codec.parse(raw);
                  const messageId = parsed.headers.get("message-id");
                  if (!sent || typeof messageId !== "string") return false;
                  await client.select(sent.path);
                  const found =
                    (await client.search(`UNDELETED HEADER Message-ID ${mailQuote(messageId)}`))
                      .length > 0;
                  if (found) observedSent.add(account.id);
                  return found;
                }),
              ),
          ),
        );
        // Once SMTP accepts, filing errors cannot safely cause another delivery.
        const saveSent = (retry: boolean) =>
          session(account, async (client) => {
            const sent = (await folders(client)).find((f) => f.label === "SENT");
            if (!sent) throw new ProviderError({ message: "Sent folder unavailable" });
            if (retry || serverSavesSent(settings) || observedSent.has(account.id)) {
              const parsed = await codec.parse(raw);
              const id = parsed.headers.get("message-id");
              if (typeof id === "string") {
                await client.select(sent.path);
                for (let attempt = 0; attempt < (retry ? 1 : 4); attempt++) {
                  if (attempt) await Effect.runPromise(Effect.sleep("4 seconds"));
                  if ((await client.search(`HEADER Message-ID ${mailQuote(id)}`)).length) {
                    observedSent.add(account.id);
                    return;
                  }
                }
              }
            }
            await client.command(
              `APPEND ${mailQuote(encodeFolder(sent.path))} (\\Seen) {${raw.byteLength}}`,
              raw,
            );
          });
        const filed = yield* saveSent(false).pipe(
          Effect.catch(() => saveSent(true)),
          Effect.as(true),
          Effect.catch(() =>
            Effect.logWarning("SMTP delivery accepted, but the message was not saved to Sent").pipe(
              Effect.as(false),
            ),
          ),
        );
        return filed ? undefined : { sentCopyMissing: true };
      }),
    // Mobile deliberately keeps drafts local until explicit send.
    saveDraft: unsupported,
    deleteDraft: unsupported,
    contacts: () => Effect.succeed([]),
    sendAs: () => Effect.succeed([]),
    respondInvite: unsupported,
    filters: unsupported,
    createFilter: unsupported,
    updateFilter: unsupported,
    deleteFilter: unsupported,
    vacation: unsupported,
    setVacation: unsupported,
    checkPermanentDelete: unsupported,
    permanentlyDelete: unsupported,
    markReadBatch: (account, ids) =>
      Effect.forEach(ids, (id) => push(account, id, { kind: "read", value: true })).pipe(
        Effect.asVoid,
      ),
    changeLabel: unsupported,
    listFolderMessages: (account, scope, cursor, options) =>
      session(account, async (client) => {
        const saved = cursor === null ? null : pageCursor(cursor);
        const labels: Record<string, string> = {
          inbox: "INBOX",
          sent: "SENT",
          drafts: "DRAFT",
          spam: "SPAM",
          trash: "TRASH",
        };
        const label = scope.label ?? labels[scope.mailbox];
        const list = (await folders(client))
          .filter((f) => (label ? f.label === label : !["SPAM", "TRASH"].includes(f.label)))
          .toSorted((a, b) => a.path.localeCompare(b.path));
        if (saved && !list.some((f) => f.path === saved.path))
          throw new PermanentError({ message: "Folder disappeared during pagination" });
        const ids: string[] = [];
        for (const path of list) {
          if (saved && path.path.localeCompare(saved.path) < 0) continue;
          const validity = await client.select(
            path.path,
            saved?.path === path.path ? saved.validity : undefined,
          );
          const after =
            saved?.path === path.path ? saved.upper : options?.newestFirst ? 0x100000000 : 0;
          const criteria = [
            "UNDELETED",
            options?.unreadOnly ? "UNSEEN" : "ALL",
            scope.mailbox === "starred" ? "FLAGGED" : "",
            `UID ${options?.newestFirst ? `1:${Math.max(1, after - 1)}` : `${after + 1}:*`}`,
          ]
            .filter(Boolean)
            .join(" ");
          const uids = (await client.search(criteria))
            .filter((uid) => (options?.newestFirst ? uid < after : uid > after))
            .toSorted((a, b) => (options?.newestFirst ? b - a : a - b));
          const take = uids.slice(0, 100 - ids.length);
          ids.push(...take.map((uid) => encodeProviderId(path.path, validity, uid)));
          const last = take.at(-1);
          if (ids.length === 100 && last !== undefined)
            return { ids, next: JSON.stringify({ path: path.path, validity, upper: last }) };
        }
        return { ids, next: null };
      }),
    backfill: (account, state, select) =>
      Effect.gen(function* () {
        const page = yield* session(account, async (client) => {
          const saved = state.cursor === null ? null : pageCursor(state.cursor);
          const list = (await folders(client)).toSorted((a, b) => a.path.localeCompare(b.path));
          for (const path of list) {
            if (saved && path.path.localeCompare(saved.path) < 0) continue;
            const validity = await client.select(path.path);
            const upper =
              saved?.path === path.path && saved.validity === validity ? saved.upper : 0xffffffff;
            if (upper < 1) continue;
            const before = new Date(state.before);
            const date = `${before.getUTCDate()}-${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][before.getUTCMonth()]}-${before.getUTCFullYear()}`;
            const uids = (await client.search(`UNDELETED UID 1:${upper} BEFORE ${date}`))
              .filter((uid) => uid <= upper)
              .toSorted((a, b) => b - a)
              .slice(0, 50);
            if (!uids.length) continue;
            return {
              ids: uids.map((uid) => encodeProviderId(path.path, validity, uid)),
              cursor: JSON.stringify({ path: path.path, validity, upper: (uids.at(-1) ?? 1) - 1 }),
            };
          }
          return { ids: [], cursor: null };
        });
        const selected = select ? yield* select(page.ids) : page.ids;
        const messages = yield* Effect.forEach(selected, (id) => fetchMessage(account, id));
        return { messages, scanned: page.ids.length, cursor: page.cursor };
      }),
    search: (account, query) =>
      session(account, async (client) => {
        const list = await folders(client);
        const scope = searchMailboxLabel(query);
        const results: IncomingMessage[] = [];
        let scanned = 0;
        let truncated = false;
        for (const path of list.filter((f) => !scope || f.label === scope)) {
          const validity = await client.select(path.path);
          const uids = (await client.search("UNDELETED")).toSorted((a, b) => b - a);
          for (const uid of uids) {
            if (scanned++ >= 1000 || results.length >= (query.limit ?? 200)) {
              truncated = true;
              break;
            }
            const message = await incoming(client, path, validity, uid);
            if (
              matchesSearch(
                message,
                query,
                list.map((f) => ({ id: f.label, name: f.name })),
              )
            )
              results.push(message);
          }
          if (truncated) break;
        }
        return { messages: results, truncated };
      }),
  };
  return adapter;
});

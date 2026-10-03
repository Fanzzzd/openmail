import type { ResetVerification } from "../../sync-reset.js";
import { messageSecurity } from "../../message-security.js";
import { MailCodec, mimeAddresses, type MimeMessage } from "../mail-codec.js";
import { nodeMailCodec } from "./mail-codec.js";
import { serverSavesSent, resolveImapSettings, imapSettingsKey } from "../../imap-settings.js";
import {
  encodeProviderId,
  decodeProviderId,
  uidSet,
  readCursor,
  FolderState,
  type ImapCursor,
  type FolderCursor,
} from "../../imap-cursor.js";
export {
  encodeProviderId,
  decodeProviderId,
  uidSet,
  parseUidSet,
  readCursor,
  FolderState,
  trackImapBackfill,
} from "../../imap-cursor.js";
import { watchImapInbox, IDLE_RENEW_MS } from "./imap-idle.js";
import { FOLDER_BATCH_LIMIT, type PermanentDeleteBatch } from "../../folder-actions.js";
import {
  Clock,
  Effect,
  Exit,
  Option,
  Predicate,
  Queue,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import { ImapFlow, type ListResponse, type MessageStructureObject } from "imapflow";
import { type AddressObject } from "mailparser";
import { createTransport } from "nodemailer";

import { attachmentFromRaw, MEDIA_RAW_TOO_LARGE } from "../../attachments.js";
import { buildMime } from "./compose.js";
import type {
  Account,
  Address,
  Attachment,
  DraftRemote,
  ImapSettings,
  IncomingMessage,
  MailOp,
  OutgoingMessage,
} from "../../domain.js";
import {
  AuthError,
  InvalidInput,
  PermanentError,
  ProviderError,
  type ProviderFailure,
} from "../../errors.js";
import { htmlToText } from "../../mime.js";
import {
  type Change,
  type ConnectInput,
  type DraftPush,
  type ProviderAdapter,
  Secrets,
} from "../../services.js";

import { imapSearch } from "./imap-search.js";
import { matchesSearch, parseSearchQuery, searchMailboxLabel } from "../../search.js";

/** First sync pulls this window per folder; older mail is left on the server. */
const INITIAL_DAYS = 90;
/** Newest messages taken per folder on the first sync. */
const FOLDER_LIMIT = 1000;
const FETCH_BATCH = 25;
const FLAG_BATCH = 500;
/** Bigger messages are parsed from their first bytes only; attachments come from BODYSTRUCTURE. */
const MAX_SOURCE = 10 * 1024 * 1024;
const TRUNCATED_SOURCE = 512 * 1024;

// NetEase (163, 126, yeah.net) rejects SELECT with "Unsafe Login" unless the
// client identifies itself with the IMAP ID command. imapflow sends ID with
// these fields when the server advertises it, and again after LOGIN when the
// first answer was empty.
const CLIENT_INFO = { name: "openmail", version: "0.1.0", vendor: "openmail" };

// Special-use folders and the Gmail-style label their messages get.
const SPECIAL_LABEL: Record<string, string> = {
  "\\Inbox": "INBOX",
  "\\Sent": "SENT",
  "\\Drafts": "DRAFT",
  "\\Junk": "SPAM",
  "\\Trash": "TRASH",
  "\\Archive": "ARCHIVE",
};
// Virtual folders that hold copies of mail from other folders.
const VIRTUAL = new Set(["\\All", "\\Flagged"]);

// Settings

export { resolveImapSettings } from "../../imap-settings.js";

// Errors

// imapflow marks failed logins with `authenticationFailed`; nodemailer uses EAUTH / 535.
function isAuthFailure(error: unknown): boolean {
  if (!Predicate.isObject(error)) return false;
  return (
    ("authenticationFailed" in error && error.authenticationFailed === true) ||
    ("code" in error && error.code === "EAUTH") ||
    ("responseCode" in error && error.responseCode === 535)
  );
}

/** The server said NO to a command: the folder or message is not there, or the op is refused. */
function isRefusal(error: unknown): boolean {
  return Predicate.isObject(error) && "responseStatus" in error && error.responseStatus === "NO";
}

/** The server's own words when there are any, else the error message. */
function describe(error: unknown): string {
  if (Predicate.isObject(error) && "responseText" in error) {
    const text = error.responseText;
    if (Predicate.isString(text) && text) return text;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Maps a thrown IMAP or SMTP error onto the provider failure types. */
function failure(accountId: string, host: string, error: unknown): AuthError | ProviderError {
  if (/STARTTLS|TLS|certificate/i.test(describe(error)))
    return new ProviderError({
      message: `${host}: TLS is required before authentication. ${describe(error)}`,
    });
  if (isAuthFailure(error)) {
    return new AuthError({ accountId, message: `${host} rejected the login: ${describe(error)}` });
  }
  if (/unsafe login/i.test(describe(error))) {
    return new ProviderError({
      message: `${host} blocked the session as an unsafe login. Turn on IMAP in the web settings and use the client authorization code.`,
    });
  }
  return new ProviderError({ message: `${host}: ${describe(error)}` });
}

// Connections

interface Session {
  accountId: string;
  settings: ImapSettings;
  client: ImapFlow;
}

function ignore(): void {
  // Nothing to do: the command waiting on the socket rejects with the same error.
}

/** Logs out politely; a session that cannot is closed. */
const logout = ({ client }: Session) =>
  Effect.tryPromise(() => client.logout()).pipe(
    Effect.catch(() => Effect.sync(() => client.close())),
  );

/** One IMAP session, logged out when the scope closes. */
export function openImap(accountId: string, settings: ImapSettings, password: string) {
  const connect = Effect.gen(function* () {
    const client = yield* Effect.sync(() => {
      const c = new ImapFlow({
        host: settings.imapHost,
        port: settings.imapPort,
        secure: settings.imapPort === 993,
        doSTARTTLS: settings.imapPort !== 993 ? true : undefined,
        auth: { user: settings.username, pass: password },
        clientInfo: CLIENT_INFO,
        logger: false,
        disableAutoIdle: true,
        maxIdleTime: IDLE_RENEW_MS,
      });
      // Socket errors after connect arrive as events; the pending command rejects too.
      c.on("error", ignore);
      return c;
    });
    yield* Effect.tryPromise({
      try: () => client.connect(),
      catch: (error) => failure(accountId, settings.imapHost, error),
    }).pipe(Effect.onError(() => Effect.sync(() => client.close())));
    return { accountId, settings, client } satisfies Session;
  });
  return Effect.acquireRelease(connect, logout);
}

/** Runs one imapflow call, mapping its rejection onto provider failures. */
function call<A>(s: Session, f: (client: ImapFlow, signal: AbortSignal) => Promise<A>) {
  const abort = () => s.client.close();
  return Effect.tryPromise({
    try: async (signal) => {
      signal.addEventListener("abort", abort, { once: true });
      try {
        signal.throwIfAborted();
        return await f(s.client, signal);
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
    catch: (error) => failure(s.accountId, s.settings.imapHost, error),
  });
}

export function smtpTransport(settings: ImapSettings, password: string) {
  return Effect.acquireRelease(
    Effect.sync(() =>
      createTransport({
        host: settings.smtpHost,
        port: settings.smtpPort,
        secure: settings.smtpSecure,
        requireTLS: !settings.smtpSecure,
        auth: { user: settings.username, pass: password },
        connectionTimeout: 20_000,
      }),
    ),
    (transport) => Effect.sync(() => transport.close()),
  );
}

// Ids

/**
 * Provider id of a message: UIDVALIDITY, UID and folder path. The path goes
 * last because it can contain any character. The id stays valid while the
 * message sits in that folder; a move shows up as a delete plus a new message.
 */
// Folders

export interface SyncFolder {
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
): SyncFolder[] {
  const out: SyncFolder[] = [];
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

/** Addresses of a mailparser header value, groups flattened. */
export function addresses(value: AddressObject | AddressObject[] | undefined): Address[] {
  const objects = Array.isArray(value) ? value : value ? [value] : [];
  const out: Address[] = [];
  for (const o of objects) {
    for (const a of o.value) {
      if (a.address) out.push({ name: a.name, address: a.address });
      for (const g of a.group ?? []) {
        if (g.address) out.push({ name: g.name, address: g.address });
      }
    }
  }
  return out;
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

function structureAttachments(node: MessageStructureObject | undefined): Attachment[] {
  return attachmentNodes(node).map((n) => n.attachment);
}

export interface Flags {
  unread: boolean;
  starred: boolean;
}

function flagsOf(flags: Set<string> | undefined): Flags {
  return { unread: !flags?.has("\\Seen"), starred: flags?.has("\\Flagged") ?? false };
}

export function folderLabels(label: string, flags: Set<string> | undefined): string[] {
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

// Pull

interface FetchedHead {
  uid: number;
  size: number;
}

/** Fetches, parses and returns messages by UID from the selected folder. */
/** Adds historical UIDs to normal flag/deletion tracking without advancing new-mail or MODSEQ checkpoints. */
export const fetchMessages = Effect.fnUntraced(function* (
  s: Session,
  folder: SyncFolder,
  uidValidity: string,
  uids: readonly number[],
) {
  const heads: FetchedHead[] = (yield* call(s, (c) =>
    c.fetchAll(uidSet(uids), { uid: true, size: true }, { uid: true }),
  )).map((m) => ({ uid: m.uid, size: m.size ?? 0 }));
  const small = heads.filter((m) => m.size <= MAX_SOURCE).map((m) => m.uid);
  const large = heads.filter((m) => m.size > MAX_SOURCE).map((m) => m.uid);
  const out: { uid: number; flags: Flags; message: IncomingMessage }[] = [];
  for (const [ids, truncated] of [
    [small, false],
    [large, true],
  ] as const) {
    if (!ids.length) continue;
    // ImapFlow applies backpressure between iterator yields. Parse and release
    // each raw source before asking for the next; no IMAP commands in this loop.
    yield* Stream.fromAsyncIterable(
      s.client.fetch(
        uidSet(ids),
        {
          uid: true,
          flags: true,
          internalDate: true,
          ...(truncated
            ? { bodyStructure: true, source: { maxLength: TRUNCATED_SOURCE } }
            : { source: true }),
        },
        { uid: true },
      ),
      (error) => failure(s.accountId, s.settings.imapHost, error),
    ).pipe(
      Stream.runForEach((m) =>
        Effect.gen(function* () {
          const source = m.source;
          if (!source || m.flags?.has("\\Deleted")) return;
          const parsed = yield* Effect.tryPromise({
            try: () => nodeMailCodec.parse(new Uint8Array(source), { skipImageLinks: true }),
            catch: (error) =>
              new ProviderError({ message: `Cannot parse message ${m.uid}: ${describe(error)}` }),
          });
          out.push({
            uid: m.uid,
            flags: flagsOf(m.flags),
            message: toIncoming(parsed, {
              authservId: s.settings.authservId,
              providerId: encodeProviderId(folder.path, uidValidity, m.uid),
              label: folder.label,
              flags: m.flags,
              internalDate: m.internalDate,
              size: heads.find((head) => head.uid === m.uid)?.size,
              ...(truncated ? { attachments: structureAttachments(m.bodyStructure) } : {}),
            }),
          });
        }),
      ),
    );
  }
  return out;
});

const password = (secrets: Secrets["Service"], account: Account) =>
  secrets.get(account.id).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new AuthError({
              accountId: account.id,
              message: "No stored password. Add the account again.",
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );

const settingsOf = (account: Account) =>
  account.imap
    ? Effect.succeed(account.imap)
    : Effect.fail(
        new AuthError({
          accountId: account.id,
          message: "The account has no IMAP settings. Add it again.",
        }),
      );

/**
 * The sync, written as a loop that offers changes to the stream's queue. The
 * queue suspends when full, so a slow store slows the IMAP side down.
 */
const runPull = Effect.fnUntraced(function* (
  s: Session,
  prev: ImapCursor,
  emit: (change: Change) => Effect.Effect<unknown>,
  scope?: "inbox",
) {
  const folders = scope
    ? [{ path: "INBOX", label: "INBOX" }]
    : mapFolders(yield* call(s, (c) => c.list()));
  if (!scope)
    yield* emit({
      _tag: "Labels",
      labels: folders.flatMap((f) =>
        f.userName ? [{ id: f.label, name: f.userName, color: null }] : [],
      ),
    });
  const condstore = s.client.enabled.has("CONDSTORE");
  const now = yield* Clock.currentTimeMillis;

  const next: ImapCursor = { folders: {} };
  // Folders not synced yet this run keep their old state in checkpoints.
  const checkpoint = () =>
    emit({
      _tag: "Cursor",
      cursor: JSON.stringify({ folders: { ...prev.folders, ...next.folders } }),
    });

  // Pass 1: new UIDs per folder, so progress has a total.
  const plans: {
    folder: SyncFolder;
    newUids: number[];
    uidNext: number;
    validity: string;
    regressed: boolean;
  }[] = [];
  for (const folder of folders) {
    const opened = yield* call(s, (c) => c.mailboxOpen(folder.path, { readOnly: true })).pipe(
      Effect.map(Option.some),
      // A folder listed but not selectable (shared, broken) is skipped, not fatal.
      Effect.catchTag("ProviderError", () => Effect.succeed(Option.none())),
    );
    if (Option.isNone(opened)) continue;
    const mailbox = opened.value;
    const old = prev.folders[folder.path];
    const regressed =
      !!old && old.uidValidity === String(mailbox.uidValidity) && mailbox.uidNext < old.lastUid + 1;
    let newUids: number[];
    if (!old || regressed || old.uidValidity !== String(mailbox.uidValidity)) {
      const since = new Date(now - INITIAL_DAYS * 86_400_000);
      const found = mailbox.exists
        ? yield* call(s, (c) => c.search({ since, deleted: false }, { uid: true }))
        : [];
      newUids = (found || []).toSorted((a, b) => b - a).slice(0, FOLDER_LIMIT);
    } else {
      const { lastUid } = old;
      const found =
        mailbox.exists && mailbox.uidNext > lastUid + 1
          ? yield* call(s, (c) =>
              c.search({ uid: `${lastUid + 1}:*`, deleted: false }, { uid: true }),
            )
          : [];
      newUids = (found || []).filter((u) => u > lastUid);
    }
    plans.push({
      folder,
      newUids: newUids.toSorted((a, b) => a - b),
      uidNext: mailbox.uidNext,
      validity: String(mailbox.uidValidity),
      regressed,
    });
  }
  const total = plans.reduce((n, p) => n + p.newUids.length, 0);
  let fetched = 0;

  // Pass 2: per folder, deletions and flag changes, then new mail, then a checkpoint.
  for (const plan of plans) {
    const { folder } = plan;
    let { regressed } = plan;
    let { newUids, uidNext } = plan;
    const mailbox = yield* call(s, (c) => c.mailboxOpen(folder.path, { readOnly: true }));
    const uidValidity = String(mailbox.uidValidity);
    const highest = mailbox.highestModseq;
    let old = prev.folders[folder.path];
    if (!old || old.uidValidity !== uidValidity) yield* emit({ _tag: "BackfillReset" });
    const rebuilt = old && old.uidValidity !== uidValidity ? old : undefined;
    if (rebuilt) regressed = false;
    if (old?.uidValidity === uidValidity && mailbox.uidNext < old.lastUid + 1 && !regressed) {
      regressed = true;
      const found = yield* call(s, (c) =>
        c.search({ since: new Date(now - INITIAL_DAYS * 86400000), deleted: false }, { uid: true }),
      );
      newUids = (found || [])
        .toSorted((a, b) => b - a)
        .slice(0, FOLDER_LIMIT)
        .toSorted((a, b) => a - b);
      uidNext = mailbox.uidNext;
    }
    if (uidValidity !== plan.validity) {
      const found = yield* call(s, (c) =>
        c.search({ since: new Date(now - INITIAL_DAYS * 86400000), deleted: false }, { uid: true }),
      );
      newUids = (found || [])
        .toSorted((a, b) => b - a)
        .slice(0, FOLDER_LIMIT)
        .toSorted((a, b) => a - b);
      uidNext = mailbox.uidNext;
    }
    if (rebuilt || regressed) old = undefined;
    const previousFolder = { path: folder.path, uidValidity: rebuilt?.uidValidity ?? uidValidity };
    if (regressed) {
      yield* emit({ _tag: "BackfillReset" });
      yield* emit({ _tag: "InvalidateFolder", previous: previousFolder });
    }
    const state = old ? FolderState.from(old) : new FolderState(uidValidity, 0, undefined);

    if (old) {
      const known = [...state.flags.keys()];
      const present = new Set<number>();
      const current = new Map<number, Flags>();
      const since =
        condstore &&
        old.modseq &&
        highest !== undefined &&
        highest >= BigInt(old.modseq) &&
        !regressed
          ? BigInt(old.modseq)
          : undefined;
      const scan =
        condstore ||
        regressed ||
        state.flagScanAt === undefined ||
        now - state.flagScanAt >= 10 * 60 * 1000;
      for (let i = 0; i < known.length; i += FLAG_BATCH) {
        const range = uidSet(known.slice(i, i + FLAG_BATCH));
        if (since !== undefined) {
          // CONDSTORE: only messages whose flags changed; existence via SEARCH.
          const exists = yield* call(s, (c) =>
            c.search({ uid: range, deleted: false }, { uid: true }),
          );
          for (const u of exists || []) present.add(u);
          if (highest !== undefined && highest > since) {
            const changed = yield* call(s, (c) =>
              c.fetchAll(range, { uid: true, flags: true }, { uid: true, changedSince: since }),
            );
            for (const m of changed) {
              if (m.flags?.has("\\Deleted")) present.delete(m.uid);
              else current.set(m.uid, flagsOf(m.flags));
            }
          }
        } else if (scan) {
          const all = yield* call(s, (c) =>
            c.fetchAll(range, { uid: true, flags: true }, { uid: true }),
          );
          for (const m of all) {
            if (m.flags?.has("\\Deleted")) continue;
            present.add(m.uid);
            current.set(m.uid, flagsOf(m.flags));
          }
        }
      }
      if (!scan) {
        for (const uid of known) present.add(uid);
      } else state.flagScanAt = now;
      const changes = state.reconcile(folder.path, present, current);
      const candidates = changes.flatMap((change) =>
        change._tag === "Delete" ? [change.providerId] : [],
      );
      if (candidates.length)
        yield* emit({ _tag: "RebuildFolder", previous: previousFolder, keep: [], candidates });
      for (const change of changes) if (change._tag !== "Delete") yield* emit(change);
    }

    for (let i = 0; i < newUids.length; i += FETCH_BATCH) {
      const batch = newUids.slice(i, i + FETCH_BATCH);
      for (const m of yield* fetchMessages(s, folder, uidValidity, batch)) {
        yield* emit(
          rebuilt
            ? { _tag: "Remap", message: m.message, previous: previousFolder }
            : { _tag: "Upsert", message: m.message },
        );
        state.flags.set(m.uid, m.flags);
      }
      fetched += batch.length;
      yield* emit({ _tag: "Progress", fetched, total });
    }

    if (rebuilt)
      yield* emit({
        _tag: "RebuildFolder",
        previous: previousFolder,
        keep: newUids.map((uid) => encodeProviderId(folder.path, uidValidity, uid)),
        since: new Date(now - INITIAL_DAYS * 86400000).setUTCHours(0, 0, 0, 0),
        partial: true,
      });
    state.lastUid = Math.max(regressed ? 0 : state.lastUid, uidNext - 1, ...newUids);
    state.modseq = highest !== undefined ? String(highest) : undefined;
    next.folders[folder.path] = state.toCursor();
    yield* checkpoint();
  }

  // Folders gone from the server since the last sync. A listed folder that
  // failed to open keeps its mail and its state.
  for (const [path, state] of Object.entries(prev.folders)) {
    if (scope || path in next.folders) continue;
    if (folders.some((f) => f.path === path)) {
      next.folders[path] = state;
      continue;
    }

    yield* emit({
      _tag: "RebuildFolder",
      previous: { path, uidValidity: state.uidValidity },
      keep: [],
    });
    // A user folder's label is its path; this also clears copies the cursor never tracked.
    yield* emit({ _tag: "DeleteLabel", label: path });
  }
  yield* emit({ _tag: "Cursor", cursor: JSON.stringify(next) });
});

// Push

const ensureFolder = Effect.fnUntraced(function* (
  s: Session,
  list: readonly ListResponse[],
  use: string,
  name: string,
) {
  const found =
    list.find((f) => f.specialUse === use && !f.flags.has("\\Noselect"))?.path ??
    list.find((f) => f.path === name)?.path;
  if (found) return found;
  return (yield* call(s, (c) => c.mailboxCreate(name))).path;
});

const moveTo = Effect.fnUntraced(function* (
  s: Session,
  uids: readonly number[],
  from: string,
  validity: string,
  to: string,
) {
  if (from === to) return [];
  const range = uidSet(uids);
  const moved = yield* call(s, async (c, signal) => {
    if (c.capabilities.has("MOVE") || c.capabilities.has("UIDPLUS"))
      return c.messageMove(range, to, { uid: true });
    const copied = await c.messageCopy(range, to, { uid: true });
    signal.throwIfAborted();
    if (copied) await c.messageFlagsAdd(range, ["\\Deleted"], { uid: true });
    return copied;
  });
  if (!moved) return yield* new ProviderError({ message: `Moving the message to ${to} failed` });
  return moved.uidValidity !== undefined && moved.uidMap
    ? [...moved.uidMap].map(([oldUid, newUid]) => ({
        from: encodeProviderId(from, validity, oldUid),
        to: encodeProviderId(to, moved.uidValidity!, newUid),
      }))
    : [];
});

const applyOp = Effect.fnUntraced(function* (
  s: Session,
  ref: { path: string; uidValidity: string; uid: number },
  op: MailOp,
  uids: readonly number[] = [ref.uid],
  expected?: FolderCursor,
) {
  const list = yield* call(s, (c) => c.list());
  const mailbox = yield* Effect.tryPromise({
    try: () => s.client.mailboxOpen(ref.path),
    catch: (error): ProviderFailure =>
      isRefusal(error)
        ? new PermanentError({ message: `Folder ${ref.path} is gone: ${describe(error)}` })
        : failure(s.accountId, s.settings.imapHost, error),
  });
  const regressed =
    expected?.uidValidity === ref.uidValidity &&
    String(mailbox.uidValidity) === ref.uidValidity &&
    mailbox.uidNext < expected.lastUid + 1;
  if (
    String(mailbox.uidValidity) !== ref.uidValidity ||
    (expected && expected.uidValidity !== ref.uidValidity) ||
    regressed
  ) {
    yield* new PermanentError({
      message: `Folder ${ref.path} was rebuilt; the message id is stale`,
      ...(regressed ? { imapReset: { path: ref.path, uidValidity: ref.uidValidity } } : {}),
    });
  }
  const found = yield* call(s, (c) =>
    c.search({ uid: uidSet(uids), deleted: false }, { uid: true }),
  );
  if (!found || uids.some((uid) => !found.includes(uid))) {
    yield* new PermanentError({ message: `Message ${ref.uid} is no longer in ${ref.path}` });
  }
  const uid = uidSet(uids);
  const flag = (name: string, on: boolean) =>
    call(s, (c) =>
      on
        ? c.messageFlagsAdd(uid, [name], { uid: true })
        : c.messageFlagsRemove(uid, [name], { uid: true }),
    );
  if (op.kind === "categories") {
    yield* new PermanentError({ message: "Categories are available for Outlook accounts." });
    return [];
  }
  if (op.kind === "copy") {
    for (const destination of new Set(op.labelIds)) {
      if (!list.some((folder) => folder.path === destination))
        yield* new PermanentError({ message: `Folder ${destination} does not exist` });
    }
    for (const destination of new Set(op.labelIds)) {
      if (destination === ref.path) continue;
      const copied = yield* call(s, (client) =>
        client.messageCopy(uid, destination, { uid: true }),
      );
      if (!copied) yield* new ProviderError({ message: `Copying to ${destination} failed` });
    }
    return [];
  }
  if (op.kind === "important") return [];
  if (op.kind === "read" || op.kind === "star") {
    yield* flag(op.kind === "read" ? "\\Seen" : "\\Flagged", op.value);
    return [];
  }
  if (
    (op.kind === "move" || (op.kind === "label" && op.value)) &&
    !list.some((f) => f.path === op.labelId)
  ) {
    yield* new PermanentError({ message: `Folder ${op.labelId} does not exist` });
  }
  const target =
    op.kind === "archive"
      ? yield* ensureFolder(s, list, "\\Archive", "Archive")
      : op.kind === "trash"
        ? yield* ensureFolder(s, list, "\\Trash", "Trash")
        : op.kind === "spam"
          ? yield* ensureFolder(s, list, "\\Junk", "Junk")
          : op.kind === "inbox"
            ? "INBOX"
            : op.kind === "move"
              ? op.labelId
              : op.value
                ? op.labelId
                : // Removing a folder label only means something for the folder the message is in.
                  ref.path === op.labelId
                  ? "INBOX"
                  : ref.path;
  return yield* moveTo(s, uids, ref.path, ref.uidValidity, target);
});

// Send

/** Header block of a raw message, unfolded, as lower-case name to value. */
export function parseHeaders(raw: Buffer | string): Map<string, string> {
  const text = Predicate.isString(raw) ? raw : raw.toString("latin1");
  const end = text.search(/\r?\n\r?\n/);
  const block = (end === -1 ? text : text.slice(0, end)).replace(/\r?\n[ \t]+/g, " ");
  const out = new Map<string, string>();
  for (const line of block.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!out.has(name)) out.set(name, line.slice(colon + 1).trim());
  }
  return out;
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

/** Message-ID and References of the original, read from IMAP. Empty when it moved or is gone. */
const threadingOf = (s: Session, providerId: string) =>
  Option.match(decodeProviderId(providerId), {
    onNone: () => Effect.succeed({}),
    onSome: (ref) =>
      Effect.gen(function* () {
        const mailbox = yield* call(s, (c) => c.mailboxOpen(ref.path, { readOnly: true }));
        if (String(mailbox.uidValidity) !== ref.uidValidity) return {};
        const m = yield* call(s, (c) =>
          c.fetchOne(
            String(ref.uid),
            { uid: true, headers: ["message-id", "references"] },
            { uid: true },
          ),
        );
        if (!m || !m.headers) return {};
        const headers = parseHeaders(m.headers);
        const messageId = headers.get("message-id");
        const references = headers.get("references");
        return { ...(messageId ? { messageId } : {}), ...(references ? { references } : {}) };
      }).pipe(Effect.catchTag("ProviderError", () => Effect.succeed({}))),
  });

/**
 * Files the sent message in Sent. Servers that save SMTP mail themselves get
 * a few seconds to do it first, so Sent never holds two copies.
 */
const saveSent = Effect.fnUntraced(function* (
  s: Session,
  raw: Buffer,
  serverSaves: boolean,
  observed: Set<string>,
) {
  const list = yield* call(s, (c) => c.list());
  const sent = yield* ensureFolder(s, list, "\\Sent", "Sent");
  const messageId = parseHeaders(raw).get("message-id");
  if (messageId) {
    for (let attempt = 0; attempt < (serverSaves ? 4 : 1); attempt++) {
      if (attempt) yield* Effect.sleep("4 seconds");
      yield* call(s, (c) => c.mailboxOpen(sent, { readOnly: true }));
      const found = yield* call(s, (c) =>
        c.search({ header: { "message-id": messageId } }, { uid: true }),
      );
      if (found && found.length) {
        observed.add(s.accountId);
        return;
      }
    }
  }
  yield* call(s, (c) => c.append(sent, raw, ["\\Seen"]));
});

// Drafts

/** Opens the message's folder if it still has the same UIDVALIDITY. False when it was rebuilt. */
const openFolderOf = (s: Session, ref: { path: string; uidValidity: string }, readOnly: boolean) =>
  Effect.tryPromise({
    try: () => s.client.mailboxOpen(ref.path, { readOnly }),
    catch: (error): ProviderFailure =>
      isRefusal(error)
        ? new PermanentError({ message: `Folder ${ref.path} is gone: ${describe(error)}` })
        : failure(s.accountId, s.settings.imapHost, error),
  }).pipe(Effect.map((mailbox) => String(mailbox.uidValidity) === ref.uidValidity));

/** Deletes one message by provider id. One that is already gone counts as deleted. */
const deleteMessage = Effect.fnUntraced(function* (s: Session, providerId: string) {
  const ref = decodeProviderId(providerId);
  if (Option.isNone(ref)) return;
  const same = yield* openFolderOf(s, ref.value, false).pipe(
    Effect.catchTag("PermanentError", () => Effect.succeed(false)),
  );
  if (!same) return;
  yield* call(s, (c) =>
    c.capabilities.has("UIDPLUS")
      ? c.messageDelete(String(ref.value.uid), { uid: true })
      : c.messageFlagsAdd(String(ref.value.uid), ["\\Deleted"], { uid: true }),
  );
});

/**
 * Files the draft in Drafts with the \Draft flag and removes the copy it
 * replaces; IMAP messages cannot be edited in place. The new UID comes from
 * UIDPLUS, or from a search by Message-ID on servers without it.
 */
const appendDraft = Effect.fnUntraced(function* (
  s: Session,
  raw: Buffer,
  previous: string | null,
  organization: OutgoingMessage["draftOrganization"],
) {
  let preservedFlags: string[] = [];
  if (previous && organization === undefined) {
    const ref = decodeProviderId(previous);
    if (Option.isSome(ref) && (yield* openFolderOf(s, ref.value, true))) {
      const current = yield* call(s, (client) =>
        client.fetchOne(String(ref.value.uid), { flags: true }, { uid: true }),
      );
      if (current)
        preservedFlags = [...(current.flags ?? [])].filter(
          (flag) =>
            flag !== "\\Deleted" && flag !== "\\Recent" && flag !== "\\Draft" && flag !== "\\Seen",
        );
    }
  }
  const list = yield* call(s, (c) => c.list());
  const drafts = yield* ensureFolder(s, list, "\\Drafts", "Drafts");
  const appended = yield* call(s, (c) =>
    c.append(drafts, raw, [
      "\\Draft",
      "\\Seen",
      ...(organization?.starred ? ["\\Flagged"] : []),
      ...(organization?.labels ?? []),
      ...preservedFlags,
    ]),
  );
  let uid = appended ? appended.uid : undefined;
  let uidValidity = appended ? appended.uidValidity : undefined;
  if (uid === undefined || uidValidity === undefined) {
    const mailbox = yield* call(s, (c) => c.mailboxOpen(drafts, { readOnly: true }));
    uidValidity = mailbox.uidValidity;
    const messageId = parseHeaders(raw).get("message-id");
    const found = messageId
      ? yield* call(s, (c) => c.search({ header: { "message-id": messageId } }, { uid: true }))
      : false;
    uid = found && found.length ? Math.max(...found) : undefined;
  }
  if (previous) yield* deleteMessage(s, previous);
  const id = uid === undefined ? null : encodeProviderId(drafts, uidValidity, uid);
  return { draftId: id, messageId: id } satisfies DraftRemote;
});

const connect = Effect.fnUntraced(function* (input: ConnectInput) {
  if (input.provider !== "imap") {
    return yield* new InvalidInput({ message: `Not an IMAP sign-in: ${input.provider}` });
  }
  const settings = yield* resolveImapSettings(input.input);
  const email = input.input.email.trim();
  const accountId = `imap:${email.toLowerCase()}`;
  const { password: pass } = input.input;
  const s = yield* openImap(accountId, settings, pass);
  yield* call(s, (c) => c.noop());
  const transport = yield* smtpTransport(settings, pass);
  yield* Effect.tryPromise({
    try: () => transport.verify(),
    catch: (error) => failure(accountId, settings.smtpHost, error),
  });
  return { email, secret: pass, imap: settings };
}, Effect.scoped);

// Adapter

const requireTargetedExpunge = (client: ImapFlow) =>
  client.capabilities.has("UIDPLUS") ||
  client.enabled.has("IMAP4REV2") ||
  (client.capabilities.has("IMAP4rev2") && !client.capabilities.has("IMAP4rev1"))
    ? Effect.void
    : Effect.fail(
        new PermanentError({
          message: "This IMAP server cannot safely expunge selected messages (UIDPLUS required).",
        }),
      );

export const makeImapWith = (
  open: typeof openImap,
  smtp: typeof smtpTransport = smtpTransport,
): Effect.Effect<ProviderAdapter, never, Secrets | MailCodec> =>
  Effect.gen(function* () {
    const codec = yield* MailCodec;
    const secrets = yield* Secrets;
    const observedSent = new Set<string>();
    const namespaces = new Map<string, ImapCursor>();
    const pushState = (account: Account, path: string, cursor?: string) =>
      readCursor(Option.fromNullishOr(cursor)).folders[path] ??
      namespaces.get(account.id)?.folders[path];

    const session = (account: Account) =>
      Effect.gen(function* () {
        const settings = yield* settingsOf(account);
        const pass = yield* password(secrets, account);
        const s = yield* open(account.id, settings, pass);
        return { s, settings, pass };
      });

    const pull: ProviderAdapter["pull"] = (account, cursor, scope) =>
      Stream.callback<Change, ProviderFailure>(
        (queue) =>
          Effect.gen(function* () {
            const { s } = yield* session(account);
            namespaces.set(account.id, readCursor(cursor));
            yield* runPull(
              s,
              readCursor(cursor),
              (change) => {
                if (change._tag === "Cursor")
                  namespaces.set(account.id, readCursor(Option.some(change.cursor)));
                return Queue.offer(queue, change);
              },
              scope,
            );
            yield* Queue.end(queue);
          }).pipe(
            // A failure of this effect does not end the stream by itself; hand it to the queue.
            Effect.catchCause((cause) => Queue.failCause(queue, cause)),
          ),
        { bufferSize: 64, strategy: "suspend" },
      );

    const owner = yield* Effect.serviceOption(Scope.Scope);
    const pools = new Map<string, { scope: Scope.Closeable; session: Session; key: string }>();
    const locks = new Map<string, Semaphore.Semaphore>();
    if (Option.isSome(owner))
      yield* Scope.addFinalizer(
        owner.value,
        Effect.suspend(() =>
          Effect.forEach(
            pools.values(),
            (pool) =>
              Effect.sync(() => pool.session.client.close()).pipe(
                Effect.andThen(Scope.close(pool.scope, Exit.void)),
              ),
            {
              discard: true,
            },
          ),
        ),
      );
    const pushSession = <A, E>(account: Account, work: (s: Session) => Effect.Effect<A, E>) => {
      let lock = locks.get(account.id);
      if (!lock) {
        lock = Semaphore.makeUnsafe(1);
        locks.set(account.id, lock);
      }
      let active: ReturnType<typeof pools.get>;
      return Effect.gen(function* () {
        if (Option.isNone(owner))
          return yield* session(account).pipe(
            Effect.flatMap(({ s }) => work(s)),
            Effect.scoped,
          );
        const settings = yield* settingsOf(account);
        const key = imapSettingsKey(settings);
        let pool = pools.get(account.id);
        active = pool;
        if (pool?.key === key && pool.session.client.usable) {
          const alive = yield* call(pool.session, (client) => client.noop()).pipe(
            Effect.timeout("5 seconds"),
            Effect.result,
          );
          if (alive._tag === "Failure") {
            const stale = pool;
            yield* Effect.sync(() => stale.session.client.close());
            yield* Scope.close(stale.scope, Exit.void);
            pools.delete(account.id);
            pool = undefined;
          }
        }
        if (!pool || pool.key !== key || !pool.session.client.usable) {
          if (pool) {
            const stale = pool;
            yield* Effect.sync(() => stale.session.client.close());
            yield* Scope.close(stale.scope, Exit.void);
          }
          const scope = yield* Scope.make();
          const opened = yield* session(account).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.onError(() => Scope.close(scope, Exit.void)),
          );
          pool = { scope, session: opened.s, key };
          pools.set(account.id, pool);
        }
        active = pool;
        return yield* work(pool.session);
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            if (!active) return;
            const interrupted = active;
            if (pools.get(account.id) === interrupted) pools.delete(account.id);
            yield* Effect.sync(() => interrupted.session.client.close());
            yield* Scope.close(interrupted.scope, Exit.void);
          }),
        ),
        lock.withPermits(1),
      );
    };
    const closeSessions: NonNullable<ProviderAdapter["closeSessions"]> = (id) =>
      Effect.forEach(
        id ? [id] : [...pools.keys()],
        (accountId) =>
          Effect.gen(function* () {
            const pool = pools.get(accountId);
            if (pool) {
              pools.delete(accountId);
              yield* Effect.sync(() => pool.session.client.close());
              yield* Scope.close(pool.scope, Exit.void);
            }
          }).pipe(locks.get(accountId)?.withPermits(1) ?? ((effect) => effect)),
        { discard: true },
      );
    const pushBatch: NonNullable<ProviderAdapter["pushBatch"]> = (account, ids, op, cursor) =>
      pushSession(account, (s) =>
        Effect.gen(function* () {
          const groups = new Map<string, { path: string; uidValidity: string; uid: number }[]>();
          for (const id of ids) {
            const decoded = decodeProviderId(id);
            if (Option.isNone(decoded))
              return yield* new PermanentError({ message: `Not an IMAP message id: ${id}` });
            const ref = decoded.value;
            const key = `${ref.uidValidity}:${ref.path}`;
            const refs = groups.get(key) ?? [];
            refs.push(ref);
            groups.set(key, refs);
          }
          const mappings: import("../../services.js").ProviderIdMapping[] = [];
          for (const refs of groups.values()) {
            const first = refs[0];
            if (!first) continue;
            const moved = yield* applyOp(
              s,
              first,
              op,
              refs.map((ref) => ref.uid),
              pushState(account, first.path, cursor),
            );
            mappings.push(...moved);
          }
          return mappings;
        }),
      );
    const push: ProviderAdapter["push"] = (account, providerId, op, cursor) =>
      op.kind === "important"
        ? Effect.void
        : Option.match(decodeProviderId(providerId), {
            onNone: () =>
              Effect.fail(new PermanentError({ message: `Not an IMAP message id: ${providerId}` })),
            onSome: (ref) =>
              pushSession(account, (s) =>
                applyOp(s, ref, op, [ref.uid], pushState(account, ref.path, cursor)),
              ),
          });

    const send: ProviderAdapter["send"] = (account, message: OutgoingMessage, original) =>
      Effect.gen(function* () {
        const recipients = [
          ...new Set([...message.to, ...message.cc, ...message.bcc].map((a) => a.address)),
        ];
        if (!recipients.length) yield* new PermanentError({ message: "No recipients" });
        const { s, settings, pass } = yield* session(account);
        const threading = Option.isSome(original)
          ? yield* threadingOf(s, original.value.providerId)
          : {};
        const raw = yield* buildMime({ name: "", address: account.email }, message, threading).pipe(
          Effect.mapError(
            (error) =>
              new ProviderError({ message: `Cannot build the message: ${describe(error)}` }),
          ),
        );

        const transport = yield* smtp(settings, pass);
        const smtpRaw = stripBcc(raw);
        yield* Effect.tryPromise({
          try: () =>
            transport.sendMail({
              envelope: { from: account.email, to: recipients, size: smtpRaw.length },
              raw: smtpRaw,
            }),
          catch: (error) =>
            Predicate.isObject(error) &&
            "code" in error &&
            error.code === "EMESSAGE" &&
            "command" in error &&
            error.command === "MAIL FROM" &&
            /size larger than allowed/i.test(describe(error))
              ? new PermanentError({
                  message: `SMTP SIZE limit: ${describe(error)}. Remove attachments before sending.`,
                })
              : failure(account.id, settings.smtpHost, error),
        });

        // The mail is out; a failed Sent copy must not make the caller send it again.
        const serverSaves = serverSavesSent(settings) || observedSent.has(account.id);
        yield* saveSent(s, raw, serverSaves, observedSent).pipe(
          Effect.catch((error) =>
            Effect.logWarning(`Could not file the sent message: ${error.message}`),
          ),
        );
      }).pipe(Effect.scoped);

    const saveDraft: ProviderAdapter["saveDraft"] = (account, draft: DraftPush) =>
      Effect.gen(function* () {
        const { s } = yield* session(account);
        const threading = Option.isSome(draft.original)
          ? yield* threadingOf(s, draft.original.value.providerId)
          : {};
        const raw = yield* buildMime(
          { name: "", address: account.email },
          draft.message,
          threading,
          { draft: true },
        ).pipe(
          Effect.mapError(
            (error) => new ProviderError({ message: `Cannot build the draft: ${describe(error)}` }),
          ),
        );
        return yield* appendDraft(
          s,
          raw,
          draft.remote?.messageId ?? null,
          draft.message.draftOrganization,
        );
      }).pipe(Effect.scoped);

    const deleteDraft: ProviderAdapter["deleteDraft"] = (account, remote) =>
      Effect.gen(function* () {
        const id = remote.messageId ?? remote.draftId;
        if (!id) return;
        const { s } = yield* session(account);
        yield* deleteMessage(s, id);
      }).pipe(Effect.scoped);

    const fetchRaw: ProviderAdapter["fetchRaw"] = (account, providerId, maxBytes) =>
      Effect.gen(function* () {
        const ref = decodeProviderId(providerId);
        if (Option.isNone(ref)) {
          return yield* new PermanentError({ message: `Not an IMAP message id: ${providerId}` });
        }
        const { s } = yield* session(account);
        const same = yield* openFolderOf(s, ref.value, true);
        if (same && maxBytes !== undefined) {
          const metadata = yield* call(s, (c) =>
            c.fetchOne(String(ref.value.uid), { uid: true, size: true }, { uid: true }),
          );
          if (!metadata || metadata.size === undefined || metadata.size > maxBytes)
            return yield* new PermanentError({ message: MEDIA_RAW_TOO_LARGE });
        }
        const m = same
          ? yield* call(s, (c) =>
              c.fetchOne(String(ref.value.uid), { uid: true, source: true }, { uid: true }),
            )
          : false;
        if (!m || !m.source) {
          return yield* new PermanentError({ message: `Message ${providerId} is gone` });
        }
        return new Uint8Array(m.source);
      }).pipe(Effect.scoped);

    /**
     * Downloads the part through BODY[part], decoded by imapflow. Falls back to
     * parsing the whole source when the structure names the part differently
     * than the parser that listed it.
     */
    const fetchAttachment: ProviderAdapter["fetchAttachment"] = (account, providerId, ref) =>
      Effect.gen(function* () {
        const id = decodeProviderId(providerId);
        if (Option.isNone(id)) {
          return yield* new PermanentError({ message: `Not an IMAP message id: ${providerId}` });
        }
        const { s } = yield* session(account);
        const same = yield* openFolderOf(s, id.value, true);
        const uid = String(id.value.uid);
        const m = same
          ? yield* call(s, (c) =>
              c.fetchOne(uid, { uid: true, bodyStructure: true }, { uid: true }),
            )
          : false;
        if (!m) return yield* new PermanentError({ message: `Message ${providerId} is gone` });
        const nodes = attachmentNodes(m.bodyStructure);
        const named = nodes.filter((n) => n.attachment.filename === ref.filename);
        const node = named[ref.occurrence];
        if (node) {
          const bytes = yield* call(s, async (c) => {
            const download = await c.download(uid, node.part, { uid: true });
            if (!download.content) return null;
            const chunks: Buffer[] = [];
            for await (const chunk of download.content) {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
            }
            return new Uint8Array(Buffer.concat(chunks));
          });
          if (bytes) return bytes;
        }
        const raw = yield* fetchRaw(account, providerId);
        const fromRaw = yield* attachmentFromRaw(raw, ref).pipe(
          Effect.provideService(MailCodec, codec),
        );
        if (!fromRaw)
          return yield* new PermanentError({ message: `No attachment ${ref.filename}` });
        return fromRaw;
      }).pipe(Effect.scoped);

    const changeLabel: ProviderAdapter["changeLabel"] = (account, change) =>
      Effect.gen(function* () {
        const { s } = yield* session(account);
        const folders = yield* call(s, (c) => c.list());
        if (change.kind === "create") {
          const parent = folders.find((f) => f.path === change.parentId);
          const path = parent
            ? `${parent.path}${parent.delimiter || "/"}${change.name}`
            : change.name;
          yield* call(s, (c) => c.mailboxCreate(path));
        } else if (change.kind === "parent") {
          const delimiter = folders.find((f) => f.path === change.id)?.delimiter || "/";
          const name = change.id.split(delimiter).at(-1);
          yield* call(s, (c) =>
            c.mailboxRename(
              change.id,
              `${change.parentId ? `${change.parentId}${delimiter}` : ""}${name}`,
            ),
          );
        } else if (change.kind === "rename") {
          const delimiter = folders.find((f) => f.path === change.id)?.delimiter || "/";
          yield* call(s, (c) => c.mailboxRename(change.id, change.name.split("/").join(delimiter)));
        } else if (change.kind === "delete") yield* call(s, (c) => c.mailboxDelete(change.id));
        return mapFolders(yield* call(s, (c) => c.list()))
          .filter((f) => f.userName !== undefined)
          .map((f) => ({ id: f.path, name: f.userName ?? f.path, color: null }));
      }).pipe(Effect.scoped);
    const search: ProviderAdapter["search"] = (account, query) =>
      Effect.gen(function* () {
        const { s } = yield* session(account);
        const folders = mapFolders(yield* call(s, (c) => c.list()));
        const labels = folders.map((f) => ({ id: f.label, name: f.userName ?? f.path }));
        const scope = searchMailboxLabel(query);
        const required = parseSearchQuery(query).criteria?.labels ?? [];
        const selected = folders.filter(
          (f) =>
            (!scope || f.label === scope) &&
            required.every((l) => f.label === l || f.userName === l),
        );
        const messages: IncomingMessage[] = [];
        const limit = Math.max(1, Math.min(query.limit ?? 200, 1000));
        let truncated = false;
        let scanned = 0;
        foldersLoop: for (const folder of selected) {
          const opened = yield* call(s, (c) => c.mailboxOpen(folder.path, { readOnly: true }));
          const found = yield* call(s, (c) =>
            c.search({ ...imapSearch(query), deleted: false }, { uid: true }),
          );
          const uids = (found || []).toSorted((a, b) => b - a);
          for (let start = 0; start < uids.length; start += FETCH_BATCH) {
            const batch = yield* fetchMessages(
              s,
              folder,
              String(opened.uidValidity),
              uids.slice(start, start + FETCH_BATCH),
            );
            scanned += Math.min(FETCH_BATCH, uids.length - start);
            for (const item of batch) {
              if (matchesSearch(item.message, query, labels)) messages.push(item.message);
              if (messages.length >= limit) break;
            }
            if (messages.length >= limit || scanned >= 1000) {
              truncated = true;
              break foldersLoop;
            }
          }
        }
        return { messages: messages.slice(0, limit), truncated };
      }).pipe(Effect.scoped);
    const HistoricalCursor = Schema.fromJsonString(
      Schema.Struct({
        path: Schema.String,
        validity: Schema.String,
        upper: Schema.Int,
      }),
    );
    const backfill: ProviderAdapter["backfill"] = (account, state, select) =>
      Effect.gen(function* () {
        const { s } = yield* session(account);
        const folders = mapFolders(yield* call(s, (c) => c.list())).toSorted((a, b) =>
          a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
        );
        const saved =
          state.cursor === null
            ? null
            : yield* Schema.decodeUnknownEffect(HistoricalCursor)(state.cursor).pipe(
                Effect.mapError(
                  () => new ProviderError({ message: "Invalid IMAP backfill cursor" }),
                ),
              );
        const remaining = folders.filter((f) => saved === null || f.path >= saved.path);
        for (const folder of remaining) {
          const opened = yield* call(s, (c) => c.mailboxOpen(folder.path, { readOnly: true }));
          const validity = String(opened.uidValidity);
          const upper =
            saved?.path === folder.path && saved.validity === validity
              ? saved.upper
              : opened.uidNext - 1;
          if (upper < 1) continue;
          // Scan a bounded range even when UIDs have large gaps. No full-folder UID list.
          const lower = Math.max(1, upper - 4999);
          const found = yield* call(s, (c) =>
            c.search(
              { uid: `${lower}:${upper}`, before: new Date(state.before), deleted: false },
              { uid: true },
            ),
          );
          const uids = (found || [])
            .filter((uid) => uid >= lower && uid <= upper)
            .toSorted((a, b) => b - a)
            .slice(0, 50);
          const listed = uids.map((uid) => encodeProviderId(folder.path, validity, uid));
          const selected = new Set(select ? yield* select(listed) : listed);
          const missing = uids.filter((uid) =>
            selected.has(encodeProviderId(folder.path, validity, uid)),
          );
          const fetched = missing.length ? yield* fetchMessages(s, folder, validity, missing) : [];
          return {
            messages: fetched.map((m) => m.message),
            scanned: uids.length,
            cursor: JSON.stringify({
              path: folder.path,
              validity,
              upper: (uids.at(-1) ?? lower) - 1,
            }),
          };
        }
        return { messages: [], scanned: 0, cursor: null };
      }).pipe(Effect.scoped);
    const fetchMessage: ProviderAdapter["fetchMessage"] = (account, providerId) =>
      Effect.gen(function* () {
        const ref = decodeProviderId(providerId);
        if (Option.isNone(ref))
          return yield* new PermanentError({ message: `Not an IMAP message id: ${providerId}` });
        const { s } = yield* session(account);
        if (!(yield* openFolderOf(s, ref.value, true)))
          return yield* new PermanentError({ message: "IMAP UIDVALIDITY changed" });
        const folders = mapFolders(yield* call(s, (c) => c.list()));
        const folder = folders.find((f) => f.path === ref.value.path);
        const fetched = folder
          ? yield* fetchMessages(s, folder, ref.value.uidValidity, [ref.value.uid])
          : [];
        const message = fetched[0]?.message;
        return message ?? (yield* new PermanentError({ message: `Message ${providerId} is gone` }));
      }).pipe(Effect.scoped);
    const verifyResetCandidates: NonNullable<ProviderAdapter["verifyResetCandidates"]> = (
      account,
      candidates,
    ) =>
      Effect.gen(function* () {
        const { s } = yield* session(account);
        const folders = mapFolders(yield* call(s, (client) => client.list()));
        if (!folders.length) return [];
        const results: ResetVerification[] = [];
        const groups = new Map<string, typeof candidates>();
        for (const candidate of candidates) {
          const ref = decodeProviderId(candidate.resetProviderId ?? candidate.providerId);
          if (Option.isNone(ref)) continue;
          groups.set(ref.value.path, [...(groups.get(ref.value.path) ?? []), candidate]);
        }
        for (const [path, group] of groups) {
          const original = folders.find((folder) => folder.path === path);
          let validity: string | undefined;
          let present = new Set<number>();
          if (original) {
            const mailbox = yield* call(s, (client) =>
              client.mailboxOpen(path, { readOnly: true }),
            );
            validity = String(mailbox.uidValidity);
            const uids = group.flatMap((candidate) => {
              const ref = decodeProviderId(candidate.resetProviderId ?? candidate.providerId);
              return !candidate.resetProviderId &&
                Option.isSome(ref) &&
                ref.value.uidValidity === validity
                ? [ref.value.uid]
                : [];
            });
            if (uids.length) {
              const found = yield* call(s, (client) =>
                client.search({ uid: uidSet(uids), deleted: false }, { uid: true }),
              );
              if (!found) return results; // A failed search is not proof of absence.
              present = new Set(found);
            }
          }
          for (const candidate of group) {
            const ref = decodeProviderId(candidate.resetProviderId ?? candidate.providerId);
            if (Option.isNone(ref)) continue;
            const retained = candidate.labels.filter((label) =>
              ["UNREAD", "STARRED", "IMPORTANT"].includes(label),
            );
            if (
              !candidate.resetProviderId &&
              ref.value.uidValidity === validity &&
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
              continue; // UIDVALIDITY changes without Message-ID cannot establish absence.
            }
            const matches: ResetVerification[] = [];
            for (const folder of folders) {
              const mailbox = yield* call(s, (client) =>
                client.mailboxOpen(folder.path, { readOnly: true }),
              );
              const found = yield* call(s, (client) =>
                client.search(
                  { header: { "message-id": candidate.rfcMessageId ?? "" }, deleted: false },
                  { uid: true },
                ),
              );
              if (!found) return results;
              for (const uid of found)
                matches.push({
                  kind: "present",
                  id: candidate.providerId,
                  providerId: encodeProviderId(folder.path, String(mailbox.uidValidity), uid),
                  labels: [folder.label, ...retained],
                });
            }
            if (!matches.length) results.push({ kind: "gone", id: candidate.providerId });
            else if (matches.length === 1 && matches[0]) results.push(matches[0]);
          }
        }
        return results;
      }).pipe(Effect.scoped);

    const FolderCursor = Schema.fromJsonString(
      Schema.Struct({
        path: Schema.String,
        validity: Schema.String,
        after: Schema.Int,
      }),
    );
    const listFolderMessages: ProviderAdapter["listFolderMessages"] = (
      account,
      scope,
      cursor,
      options,
    ) =>
      Effect.gen(function* () {
        const previous =
          cursor === null
            ? null
            : yield* Schema.decodeUnknownEffect(FolderCursor)(cursor).pipe(
                Effect.mapError(() => new PermanentError({ message: "Invalid folder cursor." })),
              );
        const { s } = yield* session(account);
        const labels: Record<string, string> = {
          inbox: "INBOX",
          sent: "SENT",
          drafts: "DRAFT",
          spam: "SPAM",
          trash: "TRASH",
        };
        const label = scope.label ?? labels[scope.mailbox];
        const folders = mapFolders(yield* call(s, (c) => c.list()))
          .filter((f) => (label ? f.label === label : !["SPAM", "TRASH"].includes(f.label)))
          .toSorted((a, b) => a.path.localeCompare(b.path));
        if (previous && !folders.some((f) => f.path === previous.path))
          return yield* new PermanentError({ message: "Folder disappeared during pagination." });
        const ids: string[] = [];
        for (const folder of folders) {
          if (previous && folder.path.localeCompare(previous.path) < 0) continue;
          const opened = yield* call(s, (c) => c.mailboxOpen(folder.path, { readOnly: true }));
          const validity = String(opened.uidValidity);
          const after =
            previous?.path === folder.path
              ? previous.after
              : options?.newestFirst
                ? 0x100000000
                : 0;
          if (previous?.path === folder.path && previous.validity !== validity)
            return yield* new PermanentError({
              message: "IMAP UIDVALIDITY changed during pagination.",
            });
          const query = imapSearch({
            ...(options?.unreadOnly ? { unreadOnly: true } : {}),
            ...(scope.mailbox === "starred" ? { starredOnly: true } : {}),
            ...(scope.mailbox === "important" ? { criteria: { important: true } } : {}),
          });
          const found = yield* call(s, (c) =>
            c.search(
              {
                ...query,
                deleted: false,
                uid: options?.newestFirst ? `1:${Math.max(1, after - 1)}` : `${after + 1}:*`,
              },
              { uid: true },
            ),
          );
          if (found === false || found === undefined)
            return yield* new PermanentError({ message: "IMAP folder search failed." });
          const uids = found
            .filter((uid) => (options?.newestFirst ? uid < after : uid > after))
            .toSorted((a, b) => (options?.newestFirst ? b - a : a - b));
          const take = uids.slice(0, FOLDER_BATCH_LIMIT - ids.length);
          ids.push(...take.map((uid) => encodeProviderId(folder.path, validity, uid)));
          if (ids.length === FOLDER_BATCH_LIMIT) {
            const last = take.at(-1);
            if (last !== undefined)
              return { ids, next: JSON.stringify({ path: folder.path, validity, after: last }) };
          }
        }
        return { ids, next: null };
      }).pipe(Effect.scoped);
    const permanentlyDelete: ProviderAdapter["permanentlyDelete"] = (account, ids) =>
      Effect.gen(function* () {
        if (ids.length > FOLDER_BATCH_LIMIT)
          return yield* new PermanentError({
            message: "Permanent delete batch exceeds 100 messages.",
          });
        const groups = new Map<
          string,
          { path: string; uidValidity: string; ids: string[]; uids: number[] }
        >();
        for (const id of ids) {
          const ref = decodeProviderId(id);
          if (Option.isNone(ref))
            return yield* new PermanentError({ message: "Invalid IMAP message id." });
          const key = JSON.stringify([ref.value.path, ref.value.uidValidity]);
          const group = groups.get(key) ?? {
            path: ref.value.path,
            uidValidity: ref.value.uidValidity,
            ids: [],
            uids: [],
          };
          group.ids.push(id);
          group.uids.push(ref.value.uid);
          groups.set(key, group);
        }
        const { s } = yield* session(account);
        yield* requireTargetedExpunge(s.client);
        const deleted: string[] = [];
        for (const group of groups.values()) {
          const result = yield* Effect.gen(function* () {
            const same = yield* openFolderOf(s, group, false).pipe(
              Effect.catchTag("PermanentError", () => Effect.succeed(false)),
            );
            if (!same) return false;
            const removed = yield* call(s, (client) =>
              client.messageDelete(group.uids, { uid: true }),
            );
            if (!removed)
              return yield* new PermanentError({ message: "IMAP permanent deletion failed." });
            return true;
          }).pipe(Effect.result);
          if (result._tag === "Failure")
            return {
              kind: "partial",
              ids: deleted,
              error: result.failure,
            } satisfies PermanentDeleteBatch;
          if (result.success) deleted.push(...group.ids);
        }
        return { kind: "complete", ids: deleted } satisfies PermanentDeleteBatch;
      }).pipe(Effect.scoped);
    const unsupported = Effect.fail(
      new PermanentError({ message: "IMAP does not support server filters or automatic replies" }),
    );
    return {
      watchInbox: (account, signal, changed, ready) =>
        Effect.gen(function* () {
          const settings = yield* settingsOf(account);
          const pass = yield* password(secrets, account);
          return yield* Effect.tryPromise({
            try: () => watchImapInbox(settings, pass, signal, changed, ready),
            catch: (error) => failure(account.id, settings.imapHost, error),
          });
        }).pipe(Effect.scoped),
      folderStatus: (account, path) =>
        Effect.gen(function* () {
          const { s } = yield* session(account);
          const status = yield* call(s, (client) =>
            client.status(path, { messages: true, unseen: true, uidNext: true, uidValidity: true }),
          );
          if (
            !status ||
            status.messages === undefined ||
            status.unseen === undefined ||
            status.uidNext === undefined ||
            status.uidValidity === undefined
          )
            return yield* new ProviderError({ message: "Incomplete IMAP STATUS" });
          return {
            total: status.messages,
            unread: status.unseen,
            threads: null,
            uidNext: status.uidNext,
            uidValidity: String(status.uidValidity),
          };
        }).pipe(Effect.scoped),
      listFolderMessages,
      checkPermanentDelete: (account, folder) =>
        Effect.gen(function* () {
          const { s } = yield* session(account);
          yield* requireTargetedExpunge(s.client);
          return [folder === "trash" ? "TRASH" : "SPAM"];
        }).pipe(Effect.scoped),
      markReadBatch: (account, ids) =>
        Effect.gen(function* () {
          const groups = new Map<string, { path: string; uidValidity: string; uids: number[] }>();
          for (const id of ids) {
            const decoded = decodeProviderId(id);
            if (Option.isNone(decoded))
              return yield* new PermanentError({ message: "Invalid IMAP message id." });
            const ref = decoded.value;
            const key = JSON.stringify([ref.path, ref.uidValidity]);
            const group = groups.get(key) ?? {
              path: ref.path,
              uidValidity: ref.uidValidity,
              uids: [],
            };
            group.uids.push(ref.uid);
            groups.set(key, group);
          }
          const { s } = yield* session(account);
          for (const group of groups.values()) {
            if (!(yield* openFolderOf(s, group, false))) continue;
            const accepted = yield* call(s, (client) =>
              client.messageFlagsAdd(group.uids, ["\\Seen"], { uid: true }),
            );
            if (!accepted)
              return yield* new PermanentError({ message: "IMAP mark as read failed." });
          }
          return yield* Effect.void;
        }).pipe(Effect.scoped),
      permanentlyDelete,
      backfill,
      fetchMessage,
      verifyResetCandidates,
      connect,
      pull,
      push,
      pushBatch,
      closeSessions,
      send,
      saveDraft,
      getDraftOrganization: (account, id) =>
        Effect.gen(function* () {
          const ref = decodeProviderId(id);
          if (Option.isNone(ref))
            return yield* new PermanentError({ message: `Not an IMAP message id: ${id}` });
          const { s } = yield* session(account);
          const same = yield* openFolderOf(s, ref.value, true);
          const message = same
            ? yield* call(s, (client) =>
                client.fetchOne(String(ref.value.uid), { flags: true }, { uid: true }),
              )
            : false;
          if (!message) return yield* new PermanentError({ message: `Message ${id} is gone` });
          return {
            labels: [...(message.flags ?? [])].filter((flag) => !flag.startsWith("\\")),
            starred: message.flags?.has("\\Flagged") ?? false,
          };
        }).pipe(Effect.scoped),
      deleteDraft,
      fetchRaw,
      fetchAttachment,
      changeLabel,
      search,
      filters: () => unsupported,
      createFilter: () => unsupported,
      updateFilter: () => unsupported,
      deleteFilter: () => unsupported,
      vacation: () => unsupported,
      setVacation: () => unsupported,
      sendAs: () => Effect.succeed([]),
      contacts: () => Effect.succeed([]),
      respondInvite: () =>
        Effect.fail(new PermanentError({ message: "IMAP invitations use the send pipeline" })),
    };
  });

/** Live adapter; tests inject a session without opening a socket. */
export const makeImap = makeImapWith(openImap);

import { Clock, Effect, Option, Predicate, Queue, Schema, Stream } from "effect";
import { ImapFlow, type ListResponse, type MessageStructureObject } from "imapflow";
import { type AddressObject, type ParsedMail, simpleParser } from "mailparser";
import { createTransport } from "nodemailer";

import { attachmentFromRaw, MEDIA_RAW_TOO_LARGE } from "./attachments.js";
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
} from "./domain.js";
import {
  AuthError,
  InvalidInput,
  PermanentError,
  ProviderError,
  type ProviderFailure,
} from "./errors.js";
import { IMAP_PRESETS, type ImapConnectInput } from "./imap-presets.js";
import { htmlToText } from "./mime.js";
import {
  type Change,
  type ConnectInput,
  type DraftPush,
  type ProviderAdapter,
  Secrets,
} from "./services.js";

import { imapSearch } from "./imap-search.js";
import { matchesSearch, parseSearchQuery, searchMailboxLabel } from "./search.js";

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

const invalid = (message: string) => Effect.fail(new InvalidInput({ message }));

/** Resolves a preset plus overrides into stored settings. */
export const resolveImapSettings = Effect.fnUntraced(function* (
  input: ImapConnectInput,
): Effect.fn.Return<ImapSettings, InvalidInput> {
  const email = input.email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return yield* invalid(`Invalid email address: ${email}`);
  }
  if (!input.password) return yield* invalid("Password is required");
  const preset = input.preset === "custom" ? undefined : IMAP_PRESETS[input.preset];
  if (input.preset !== "custom" && !preset) {
    return yield* invalid(`Unknown IMAP preset: ${input.preset}`);
  }

  const imapHost = input.imapHost?.trim() || preset?.imapHost;
  const smtpHost = input.smtpHost?.trim() || preset?.smtpHost;
  if (!imapHost) return yield* invalid("IMAP server is required");
  if (!smtpHost) return yield* invalid("SMTP server is required");
  const imapPort = input.imapPort ?? preset?.imapPort ?? 993;
  const smtpPort = input.smtpPort ?? preset?.smtpPort ?? 465;
  for (const port of [imapPort, smtpPort]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return yield* invalid(`Invalid port: ${port}`);
    }
  }
  return {
    preset: preset ? input.preset : "custom",
    username: input.username?.trim() || email,
    imapHost,
    imapPort,
    smtpHost,
    smtpPort,
    // 465 is implicit TLS; 587 and 25 upgrade with STARTTLS.
    smtpSecure: input.smtpSecure ?? preset?.smtpSecure ?? smtpPort === 465,
  };
});

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
function openImap(accountId: string, settings: ImapSettings, password: string) {
  const connect = Effect.gen(function* () {
    const client = yield* Effect.sync(() => {
      const c = new ImapFlow({
        host: settings.imapHost,
        port: settings.imapPort,
        secure: settings.imapPort === 993,
        auth: { user: settings.username, pass: password },
        clientInfo: CLIENT_INFO,
        logger: false,
        disableAutoIdle: true,
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
function call<A>(s: Session, f: (client: ImapFlow) => Promise<A>) {
  return Effect.tryPromise({
    try: () => f(s.client),
    catch: (error) => failure(s.accountId, s.settings.imapHost, error),
  });
}

function smtpTransport(settings: ImapSettings, password: string) {
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
export function encodeProviderId(path: string, uidValidity: bigint | string, uid: number): string {
  return `${uidValidity}:${uid}:${path}`;
}

export function decodeProviderId(
  id: string,
): Option.Option<{ path: string; uidValidity: string; uid: number }> {
  const match = /^(\d+):(\d+):([\s\S]+)$/.exec(id);
  if (!match) return Option.none();
  return Option.some({ uidValidity: match[1]!, uid: Number(match[2]), path: match[3]! });
}

/** Compacts UIDs into an IMAP sequence set, e.g. "1:3,7,9:10". */
export function uidSet(uids: Iterable<number>): string {
  const sorted = [...new Set(uids)].toSorted((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}:${sorted[j]}`);
    i = j + 1;
  }
  return parts.join(",");
}

/** Inverse of `uidSet`. */
export function parseUidSet(set: string): number[] {
  const out: number[] = [];
  for (const part of set.split(",")) {
    if (!part) continue;
    const [a, b] = part.split(":").map(Number);
    if (a === undefined || !Number.isFinite(a)) continue;
    const end = b !== undefined && Number.isFinite(b) ? b : a;
    for (let n = a; n <= end; n++) out.push(n);
  }
  return out;
}

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
  parsed: ParsedMail,
  meta: {
    providerId: string;
    label: string;
    flags: Set<string> | undefined;
    internalDate?: Date | string | undefined;
    /** Overrides parsed attachments when the source was truncated. */
    attachments?: Attachment[];
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
    subject: parsed.subject ?? "",
    from: addresses(parsed.from)[0] ?? { name: "", address: "" },
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    replyTo: addresses(parsed.replyTo),
    date: Number.isFinite(received) ? received : (parsed.date?.getTime() ?? 0),
    snippet: text.replace(/\s+/g, " ").trim().slice(0, 200),
    bodyText: text,
    bodyHtml: html,
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

// Sync cursor

/**
 * Per-folder sync state. Flags are kept here because the adapter never reads
 * the store: a flag change is found by comparing the server's flags with the
 * ones last reported.
 */
export interface FolderCursor {
  uidValidity: string;
  /** Highest UID seen; new mail has a bigger one. */
  lastUid: number;
  /** HIGHESTMODSEQ at the last sync, when the server has CONDSTORE. */
  modseq?: string;
  /** UIDs reported to the store, as an IMAP sequence set. */
  uids: string;
  /** The subset of `uids` without \Seen. */
  unread: string;
  /** The subset of `uids` with \Flagged. */
  starred: string;
}

export interface ImapCursor {
  folders: Record<string, FolderCursor>;
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

export function readCursor(raw: Option.Option<string>): ImapCursor {
  // A cursor from an older build or a corrupt one: start over.
  const parsed = Option.getOrUndefined(Option.flatMap(raw, decodeJson));
  if (
    !Predicate.isObject(parsed) ||
    !("folders" in parsed) ||
    !Predicate.isObject(parsed.folders)
  ) {
    return { folders: {} };
  }
  const folders: Record<string, FolderCursor> = {};
  for (const [path, f] of Object.entries(parsed.folders)) {
    if (
      Predicate.isObject(f) &&
      "uidValidity" in f &&
      Predicate.isString(f.uidValidity) &&
      "lastUid" in f &&
      Predicate.isNumber(f.lastUid) &&
      "uids" in f &&
      Predicate.isString(f.uids)
    ) {
      const text = (key: string) => {
        const v: unknown = key in f ? f[key as keyof typeof f] : undefined;
        return Predicate.isString(v) ? v : undefined;
      };
      const modseq = text("modseq");
      folders[path] = {
        uidValidity: f.uidValidity,
        lastUid: f.lastUid,
        uids: f.uids,
        unread: text("unread") ?? "",
        starred: text("starred") ?? "",
        ...(modseq ? { modseq } : {}),
      };
    }
  }
  return { folders };
}

/**
 * Mutable form of FolderCursor while a folder syncs. It keeps the read and
 * starred state per UID so a sync reports only what changed: without
 * CONDSTORE the server answers with every message's flags.
 */
export class FolderState {
  readonly flags = new Map<number, Flags>();
  constructor(
    readonly uidValidity: string,
    public lastUid: number,
    public modseq: string | undefined,
  ) {}

  static from(c: FolderCursor): FolderState {
    const state = new FolderState(c.uidValidity, c.lastUid, c.modseq);
    const unread = new Set(parseUidSet(c.unread));
    const starred = new Set(parseUidSet(c.starred));
    for (const uid of parseUidSet(c.uids)) {
      state.flags.set(uid, { unread: unread.has(uid), starred: starred.has(uid) });
    }
    return state;
  }

  /**
   * Folds a flag fetch into the state. Known UIDs not in `present` are gone
   * (Delete); a UID whose read or starred state in `current` differs from the
   * known one gets a Flags change. Deletes come first.
   */
  reconcile(
    path: string,
    present: ReadonlySet<number>,
    current: ReadonlyMap<number, Flags>,
  ): Change[] {
    const changes: Change[] = [];
    const id = (uid: number) => encodeProviderId(path, this.uidValidity, uid);
    // Deleting the current entry does not disturb a Map iterator.
    for (const uid of this.flags.keys()) {
      if (present.has(uid)) continue;
      this.flags.delete(uid);
      changes.push({ _tag: "Delete", providerId: id(uid) });
    }
    for (const [uid, flags] of current) {
      const before = this.flags.get(uid);
      if (!before || (before.unread === flags.unread && before.starred === flags.starred)) {
        continue;
      }
      this.flags.set(uid, flags);
      changes.push({
        _tag: "Flags",
        providerId: id(uid),
        isUnread: flags.unread,
        isStarred: flags.starred,
      });
    }
    return changes;
  }

  toCursor(): FolderCursor {
    const uids = [...this.flags.keys()];
    return {
      uidValidity: this.uidValidity,
      lastUid: this.lastUid,
      ...(this.modseq ? { modseq: this.modseq } : {}),
      uids: uidSet(uids),
      unread: uidSet(uids.filter((u) => this.flags.get(u)!.unread)),
      starred: uidSet(uids.filter((u) => this.flags.get(u)!.starred)),
    };
  }
}

// Pull

interface FetchedHead {
  uid: number;
  size: number;
}

/** Fetches, parses and returns messages by UID from the selected folder. */
/** Adds historical UIDs to normal flag/deletion tracking without advancing new-mail or MODSEQ checkpoints. */
export function trackImapBackfill(
  cursor: Option.Option<string>,
  messages: readonly IncomingMessage[],
): Option.Option<string> {
  const previous = readCursor(cursor);
  const states = new Map<string, FolderState>();
  for (const message of messages) {
    const ref = decodeProviderId(message.providerId);
    if (Option.isNone(ref)) continue;
    const old = previous.folders[ref.value.path];
    if (!old || old.uidValidity !== ref.value.uidValidity) continue;
    const state = states.get(ref.value.path) ?? FolderState.from(old);
    if (!state.flags.has(ref.value.uid))
      state.flags.set(ref.value.uid, { unread: message.isUnread, starred: message.isStarred });
    states.set(ref.value.path, state);
  }
  if (!states.size) return Option.none();
  for (const [folder, state] of states) previous.folders[folder] = state.toCursor();
  return Option.some(JSON.stringify(previous));
}

const fetchMessages = Effect.fnUntraced(function* (
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
  const fetched = [
    ...(small.length
      ? yield* call(s, (c) =>
          c.fetchAll(
            uidSet(small),
            { uid: true, flags: true, internalDate: true, source: true },
            { uid: true },
          ),
        )
      : []),
    ...(large.length
      ? yield* call(s, (c) =>
          c.fetchAll(
            uidSet(large),
            {
              uid: true,
              flags: true,
              internalDate: true,
              bodyStructure: true,
              source: { maxLength: TRUNCATED_SOURCE },
            },
            { uid: true },
          ),
        )
      : []),
  ];
  const out: { uid: number; flags: Flags; message: IncomingMessage }[] = [];
  for (const m of fetched) {
    const source = m.source;
    if (!source) continue;
    const parsed = yield* Effect.tryPromise({
      try: () => simpleParser(source, { skipImageLinks: true }),
      catch: (error) =>
        new ProviderError({ message: `Cannot parse message ${m.uid}: ${describe(error)}` }),
    });
    out.push({
      uid: m.uid,
      flags: flagsOf(m.flags),
      message: toIncoming(parsed, {
        providerId: encodeProviderId(folder.path, uidValidity, m.uid),
        label: folder.label,
        flags: m.flags,
        internalDate: m.internalDate,
        ...(large.includes(m.uid) ? { attachments: structureAttachments(m.bodyStructure) } : {}),
      }),
    });
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
  const dropFolder = Effect.fnUntraced(function* (path: string, state: FolderCursor) {
    for (const uid of parseUidSet(state.uids)) {
      yield* emit({ _tag: "Delete", providerId: encodeProviderId(path, state.uidValidity, uid) });
    }
  });

  // Pass 1: new UIDs per folder, so progress has a total.
  const plans: { folder: SyncFolder; newUids: number[] }[] = [];
  for (const folder of folders) {
    const opened = yield* call(s, (c) => c.mailboxOpen(folder.path, { readOnly: true })).pipe(
      Effect.map(Option.some),
      // A folder listed but not selectable (shared, broken) is skipped, not fatal.
      Effect.catchTag("ProviderError", () => Effect.succeed(Option.none())),
    );
    if (Option.isNone(opened)) continue;
    const mailbox = opened.value;
    const old = prev.folders[folder.path];
    let newUids: number[];
    if (!old || old.uidValidity !== String(mailbox.uidValidity)) {
      const since = new Date(now - INITIAL_DAYS * 86_400_000);
      const found = mailbox.exists ? yield* call(s, (c) => c.search({ since }, { uid: true })) : [];
      newUids = (found || []).toSorted((a, b) => b - a).slice(0, FOLDER_LIMIT);
    } else {
      const { lastUid } = old;
      const found =
        mailbox.exists && mailbox.uidNext > lastUid + 1
          ? yield* call(s, (c) => c.search({ uid: `${lastUid + 1}:*` }, { uid: true }))
          : [];
      newUids = (found || []).filter((u) => u > lastUid);
    }
    plans.push({ folder, newUids });
  }
  const total = plans.reduce((n, p) => n + p.newUids.length, 0);
  let fetched = 0;

  // Pass 2: per folder, deletions and flag changes, then new mail, then a checkpoint.
  for (const { folder, newUids } of plans) {
    const mailbox = yield* call(s, (c) => c.mailboxOpen(folder.path, { readOnly: true }));
    const uidValidity = String(mailbox.uidValidity);
    const highest = mailbox.highestModseq;
    let old = prev.folders[folder.path];
    if (!old || old.uidValidity !== uidValidity) yield* emit({ _tag: "BackfillReset" });
    if (old && old.uidValidity !== uidValidity) {
      yield* dropFolder(folder.path, old);
      old = undefined;
    }
    const state = old ? FolderState.from(old) : new FolderState(uidValidity, 0, undefined);

    if (old) {
      const known = [...state.flags.keys()];
      const present = new Set<number>();
      const current = new Map<number, Flags>();
      const since =
        condstore && old.modseq && highest !== undefined ? BigInt(old.modseq) : undefined;
      for (let i = 0; i < known.length; i += FLAG_BATCH) {
        const range = uidSet(known.slice(i, i + FLAG_BATCH));
        if (since !== undefined) {
          // CONDSTORE: only messages whose flags changed; existence via SEARCH.
          const exists = yield* call(s, (c) => c.search({ uid: range }, { uid: true }));
          for (const u of exists || []) present.add(u);
          if (highest !== undefined && highest > since) {
            const changed = yield* call(s, (c) =>
              c.fetchAll(range, { uid: true, flags: true }, { uid: true, changedSince: since }),
            );
            for (const m of changed) current.set(m.uid, flagsOf(m.flags));
          }
        } else {
          const all = yield* call(s, (c) =>
            c.fetchAll(range, { uid: true, flags: true }, { uid: true }),
          );
          for (const m of all) {
            present.add(m.uid);
            current.set(m.uid, flagsOf(m.flags));
          }
        }
      }
      for (const change of state.reconcile(folder.path, present, current)) yield* emit(change);
    }

    for (let i = 0; i < newUids.length; i += FETCH_BATCH) {
      const batch = newUids.slice(i, i + FETCH_BATCH);
      for (const m of yield* fetchMessages(s, folder, uidValidity, batch)) {
        yield* emit({ _tag: "Upsert", message: m.message });
        state.flags.set(m.uid, m.flags);
      }
      fetched += batch.length;
      yield* emit({ _tag: "Progress", fetched, total });
    }

    state.lastUid = Math.max(state.lastUid, mailbox.uidNext - 1, ...newUids);
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
    yield* dropFolder(path, state);
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

const moveTo = Effect.fnUntraced(function* (s: Session, uid: number, from: string, to: string) {
  if (from === to) return;
  const moved = yield* call(s, (c) => c.messageMove(String(uid), to, { uid: true }));
  if (!moved) yield* new ProviderError({ message: `Moving the message to ${to} failed` });
});

const applyOp = Effect.fnUntraced(function* (
  s: Session,
  ref: { path: string; uidValidity: string; uid: number },
  op: MailOp,
) {
  const list = yield* call(s, (c) => c.list());
  const mailbox = yield* Effect.tryPromise({
    try: () => s.client.mailboxOpen(ref.path),
    catch: (error): ProviderFailure =>
      isRefusal(error)
        ? new PermanentError({ message: `Folder ${ref.path} is gone: ${describe(error)}` })
        : failure(s.accountId, s.settings.imapHost, error),
  });
  if (String(mailbox.uidValidity) !== ref.uidValidity) {
    yield* new PermanentError({
      message: `Folder ${ref.path} was rebuilt; the message id is stale`,
    });
  }
  const found = yield* call(s, (c) => c.search({ uid: String(ref.uid) }, { uid: true }));
  if (!found || !found.includes(ref.uid)) {
    yield* new PermanentError({ message: `Message ${ref.uid} is no longer in ${ref.path}` });
  }
  const uid = String(ref.uid);
  const flag = (name: string, on: boolean) =>
    call(s, (c) =>
      on
        ? c.messageFlagsAdd(uid, [name], { uid: true })
        : c.messageFlagsRemove(uid, [name], { uid: true }),
    );
  if (op.kind === "important") return;
  if (op.kind === "read" || op.kind === "star") {
    yield* flag(op.kind === "read" ? "\\Seen" : "\\Flagged", op.value);
    return;
  }
  if (op.kind === "label" && op.value && !list.some((f) => f.path === op.labelId)) {
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
            : op.value
              ? op.labelId
              : // Removing a folder label only means something for the folder the message is in.
                ref.path === op.labelId
                ? "INBOX"
                : ref.path;
  yield* moveTo(s, ref.uid, ref.path, target);
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
const saveSent = Effect.fnUntraced(function* (s: Session, raw: Buffer, serverSaves: boolean) {
  const list = yield* call(s, (c) => c.list());
  const sent = yield* ensureFolder(s, list, "\\Sent", "Sent");
  const messageId = parseHeaders(raw).get("message-id");
  if (messageId) {
    for (let attempt = 0; attempt < (serverSaves ? 4 : 1); attempt++) {
      if (attempt) yield* Effect.sleep("1500 millis");
      yield* call(s, (c) => c.mailboxOpen(sent, { readOnly: true }));
      const found = yield* call(s, (c) =>
        c.search({ header: { "message-id": messageId } }, { uid: true }),
      );
      if (found && found.length) return;
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
  yield* call(s, (c) => c.messageDelete(String(ref.value.uid), { uid: true }));
});

/**
 * Files the draft in Drafts with the \Draft flag and removes the copy it
 * replaces; IMAP messages cannot be edited in place. The new UID comes from
 * UIDPLUS, or from a search by Message-ID on servers without it.
 */
const appendDraft = Effect.fnUntraced(function* (s: Session, raw: Buffer, previous: string | null) {
  const list = yield* call(s, (c) => c.list());
  const drafts = yield* ensureFolder(s, list, "\\Drafts", "Drafts");
  const appended = yield* call(s, (c) => c.append(drafts, raw, ["\\Draft", "\\Seen"]));
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

export const makeImapWith = (
  open: typeof openImap,
): Effect.Effect<ProviderAdapter, never, Secrets> =>
  Effect.gen(function* () {
    const secrets = yield* Secrets;

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
            yield* runPull(s, readCursor(cursor), (change) => Queue.offer(queue, change), scope);
            yield* Queue.end(queue);
          }).pipe(
            // A failure of this effect does not end the stream by itself; hand it to the queue.
            Effect.catchCause((cause) => Queue.failCause(queue, cause)),
          ),
        { bufferSize: 64, strategy: "suspend" },
      );

    const push: ProviderAdapter["push"] = (account, providerId, op) =>
      op.kind === "important"
        ? Effect.void
        : Option.match(decodeProviderId(providerId), {
            onNone: () =>
              Effect.fail(new PermanentError({ message: `Not an IMAP message id: ${providerId}` })),
            onSome: (ref) =>
              session(account).pipe(
                Effect.flatMap(({ s }) => applyOp(s, ref, op)),
                Effect.scoped,
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

        const transport = yield* smtpTransport(settings, pass);
        yield* Effect.tryPromise({
          try: () =>
            transport.sendMail({
              envelope: { from: account.email, to: recipients },
              raw: stripBcc(raw),
            }),
          catch: (error) => failure(account.id, settings.smtpHost, error),
        });

        // The mail is out; a failed Sent copy must not make the caller send it again.
        const serverSaves = IMAP_PRESETS[settings.preset]?.serverSavesSent ?? false;
        yield* saveSent(s, raw, serverSaves).pipe(
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
        ).pipe(
          Effect.mapError(
            (error) => new ProviderError({ message: `Cannot build the draft: ${describe(error)}` }),
          ),
        );
        return yield* appendDraft(s, raw, draft.remote?.messageId ?? null);
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
        const fromRaw = yield* attachmentFromRaw(raw, ref);
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
          const found = yield* call(s, (c) => c.search(imapSearch(query), { uid: true }));
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
            c.search({ uid: `${lower}:${upper}`, before: new Date(state.before) }, { uid: true }),
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
    const unsupported = Effect.fail(
      new PermanentError({ message: "IMAP does not support server filters or automatic replies" }),
    );
    return {
      backfill,
      fetchMessage,
      connect,
      pull,
      push,
      send,
      saveDraft,
      deleteDraft,
      fetchRaw,
      fetchAttachment,
      changeLabel,
      search,
      filters: () => unsupported,
      createFilter: () => unsupported,
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

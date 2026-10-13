import { Option, Predicate, Schema } from "effect";
import type { IncomingMessage } from "./domain/domain.js";
import type { Change } from "./services.js";
import type { Flags } from "./imap-helpers.js";
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
export function parseUidSet(set: string, limit = 1000000): number[] {
  const out: number[] = [];
  for (const part of set.split(",")) {
    if (!part) continue;
    const [a, b] = part.split(":").map(Number);
    if (
      a === undefined ||
      !Number.isSafeInteger(a) ||
      a < 1 ||
      (b !== undefined && (!Number.isSafeInteger(b) || b < 1))
    )
      return [];
    const end = b ?? a;
    if (out.length + Math.abs(end - a) + 1 > limit) return [];
    const step = end >= a ? 1 : -1;
    for (let n = a; step > 0 ? n <= end : n >= end; n += step) out.push(n);
  }
  return out;
}

// Sync cursor

/** Most \Deleted UIDs a folder watches for an undelete. */
const DELETED_LIMIT = 1000;

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
  /** Last complete flag scan on servers without CONDSTORE. */
  flagScanAt?: number;
  /** UIDs reported to the store, as an IMAP sequence set. */
  uids: string;
  /** The subset of `uids` without \Seen. */
  unread: string;
  /** The subset of `uids` with \Flagged. */
  starred: string;
  /**
   * UIDs on the server marked \Deleted but not expunged, so not in the store.
   * Each sync checks them again and fetches any whose \Deleted flag was cleared.
   */
  deleted?: string;
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
      const deleted = text("deleted");
      folders[path] = {
        uidValidity: f.uidValidity,
        lastUid: f.lastUid,
        ...("flagScanAt" in f && Predicate.isNumber(f.flagScanAt)
          ? { flagScanAt: f.flagScanAt }
          : {}),
        uids: f.uids,
        unread: text("unread") ?? "",
        starred: text("starred") ?? "",
        ...(modseq ? { modseq } : {}),
        ...(deleted ? { deleted } : {}),
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
  /** See FolderCursor.deleted. */
  readonly deleted = new Set<number>();
  flagScanAt: number | undefined;
  constructor(
    readonly uidValidity: string,
    public lastUid: number,
    public modseq: string | undefined,
  ) {}

  static from(c: FolderCursor): FolderState {
    const state = new FolderState(c.uidValidity, c.lastUid, c.modseq);
    state.flagScanAt = c.flagScanAt;
    for (const uid of parseUidSet(c.deleted ?? "")) state.deleted.add(uid);
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

  /** Replaces the watched \Deleted UIDs, keeping the newest DELETED_LIMIT not in the store. */
  watchDeleted(uids: Iterable<number>) {
    const watched = [...new Set(uids)]
      .filter((uid) => !this.flags.has(uid))
      .toSorted((a, b) => b - a)
      .slice(0, DELETED_LIMIT);
    this.deleted.clear();
    for (const uid of watched) this.deleted.add(uid);
  }

  toCursor(): FolderCursor {
    const uids = [...this.flags.keys()];
    const deleted = [...this.deleted].filter((uid) => !this.flags.has(uid));
    return {
      uidValidity: this.uidValidity,
      ...(this.flagScanAt === undefined ? {} : { flagScanAt: this.flagScanAt }),
      lastUid: this.lastUid,
      ...(this.modseq ? { modseq: this.modseq } : {}),
      uids: uidSet(uids),
      unread: uidSet(uids.filter((u) => this.flags.get(u)!.unread)),
      starred: uidSet(uids.filter((u) => this.flags.get(u)!.starred)),
      ...(deleted.length ? { deleted: uidSet(deleted) } : {}),
    };
  }
}

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

/**
 * Records a pushed \Seen or \Flagged change in the per-UID flags. Without it the
 * record keeps the pre-push state, and a later opposite change from another
 * device compares equal to it and is never reported.
 */
export function recordPushedFlags(
  cursor: Option.Option<string>,
  providerIds: readonly string[],
  flag: "read" | "star",
  value: boolean,
): Option.Option<string> {
  if (Option.isNone(cursor)) return Option.none();
  const previous = readCursor(cursor);
  const states = new Map<string, FolderState>();
  for (const providerId of providerIds) {
    const ref = decodeProviderId(providerId);
    if (Option.isNone(ref)) continue;
    const old = previous.folders[ref.value.path];
    if (!old || old.uidValidity !== ref.value.uidValidity) continue;
    const state = states.get(ref.value.path) ?? FolderState.from(old);
    states.set(ref.value.path, state);
    const flags = state.flags.get(ref.value.uid);
    if (!flags) continue;
    state.flags.set(
      ref.value.uid,
      flag === "read" ? { ...flags, unread: !value } : { ...flags, starred: value },
    );
  }
  if (!states.size) return Option.none();
  for (const [folder, state] of states) previous.folders[folder] = state.toCursor();
  return Option.some(JSON.stringify(previous));
}

export function folderRegressed(
  previous: FolderCursor | undefined,
  uidValidity: string,
  uidNext: number | undefined,
): boolean {
  return (
    previous?.uidValidity === uidValidity && uidNext !== undefined && uidNext < previous.lastUid + 1
  );
}

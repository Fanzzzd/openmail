import { Clock, Effect, Option, Stream } from "effect";
import type { IncomingMessage } from "../../../domain/domain.js";
import { ProviderError } from "../../../domain/errors.js";
import {
  encodeProviderId,
  folderRegressed,
  FolderState,
  parseUidSet,
  uidSet,
  type Flags,
  type ImapCursor,
} from "../../../providers/imap/imap-cursor.js";
import { flagsOf } from "../../../providers/imap/imap-helpers.js";
import type { Change } from "../../../providers/adapter.js";
import { nodeMailCodec } from "../mail-codec.js";
import { finishWith } from "../../html-text.js";
import { incomingBody, mapFolders, structureAttachments, type ImapSyncFolder } from "./parse.js";
import { call, confirmFolderGone, describe, failure, searchUids, type Session } from "./session.js";

/** First sync pulls this window per folder; older mail is left on the server. */
const INITIAL_DAYS = 90;

/** Newest messages taken per folder on the first sync. */
const FOLDER_LIMIT = 1000;

export const FETCH_BATCH = 25;

const FLAG_BATCH = 500;

/** Bigger messages are parsed from their first bytes only; attachments come from BODYSTRUCTURE. */
const MAX_SOURCE = 10 * 1024 * 1024;

const TRUNCATED_SOURCE = 512 * 1024;

// Pull

interface FetchedHead {
  uid: number;
  size: number;
}

/** Fetches, parses and returns messages by UID from the selected folder. */
/** Adds historical UIDs to normal flag/deletion tracking without advancing new-mail or MODSEQ checkpoints. */
export const fetchMessages = Effect.fnUntraced(function* (
  s: Session,
  folder: ImapSyncFolder,
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
    // ImapFlow applies backpressure between iterator yields. Parse as many raw
    // sources at once as HTML extraction can use, in order; no IMAP commands here.
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
      Stream.mapEffect(
        (m) =>
          Effect.gen(function* () {
            const source = m.source;
            if (!source || m.flags?.has("\\Deleted")) return null;
            const parsed = yield* Effect.tryPromise({
              try: () => nodeMailCodec.parse(new Uint8Array(source), { skipImageLinks: true }),
              catch: (error) =>
                new ProviderError({ message: `Cannot parse message ${m.uid}: ${describe(error)}` }),
            });
            const message = yield* finishWith(
              s.htmlText,
              incomingBody(parsed, {
                authservId: s.settings.authservId,
                providerId: encodeProviderId(folder.path, uidValidity, m.uid),
                label: folder.label,
                flags: m.flags,
                internalDate: m.internalDate,
                size: heads.find((head) => head.uid === m.uid)?.size,
                ...(truncated ? { attachments: structureAttachments(m.bodyStructure) } : {}),
              }),
            );
            return { uid: m.uid, flags: flagsOf(m.flags), message };
          }),
        { concurrency: s.htmlText.concurrency },
      ),
      Stream.runForEach((item) => Effect.sync(() => item && out.push(item))),
    );
  }
  return out;
});

/** The newest FOLDER_LIMIT UIDs, newest first. */
const newest = (uids: readonly number[]) => uids.toSorted((a, b) => b - a).slice(0, FOLDER_LIMIT);

/**
 * The first-sync window of the selected folder: undeleted UIDs to fetch, and
 * \Deleted ones to watch, since an undelete brings them back.
 */
const searchWindow = Effect.fnUntraced(function* (s: Session, now: number) {
  const since = new Date(now - INITIAL_DAYS * 86_400_000);
  const live = yield* searchUids(s, { since, deleted: false });
  const deleted = yield* searchUids(s, { since, deleted: true });
  return { newUids: newest(live), deleted: newest(deleted) };
});

/**
 * The sync, written as a loop that offers changes to the stream's queue. The
 * queue suspends when full, so a slow store slows the IMAP side down.
 */
export const runPull = Effect.fnUntraced(function* (
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
    folder: ImapSyncFolder;
    newUids: number[];
    /** \Deleted UIDs to watch for an undelete. */
    deleted: number[];
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
    const regressed = folderRegressed(old, String(mailbox.uidValidity), mailbox.uidNext);
    let newUids: number[] = [];
    let deleted: number[] = [];
    if (!old || regressed || old.uidValidity !== String(mailbox.uidValidity)) {
      if (mailbox.exists) ({ newUids, deleted } = yield* searchWindow(s, now));
    } else if (mailbox.exists) {
      const { lastUid } = old;
      if (mailbox.uidNext > lastUid + 1) {
        const uid = `${lastUid + 1}:*`;
        newUids = (yield* searchUids(s, { uid, deleted: false })).filter((u) => u > lastUid);
        deleted = (yield* searchUids(s, { uid, deleted: true })).filter((u) => u > lastUid);
      }
      // Watched \Deleted UIDs: an undeleted one is fetched like new mail; an expunged one is dropped.
      const watched = parseUidSet(old.deleted ?? "");
      if (watched.length)
        for (const m of yield* call(s, (c) =>
          c.fetchAll(uidSet(watched), { uid: true, flags: true }, { uid: true }),
        ))
          (m.flags?.has("\\Deleted") ? deleted : newUids).push(m.uid);
    }
    plans.push({
      folder,
      newUids: [...new Set(newUids)].toSorted((a, b) => a - b),
      deleted,
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
    let { newUids, uidNext, deleted } = plan;
    const mailbox = yield* call(s, (c) => c.mailboxOpen(folder.path, { readOnly: true }));
    const uidValidity = String(mailbox.uidValidity);
    const highest = mailbox.highestModseq;
    let old = prev.folders[folder.path];
    if (!old || old.uidValidity !== uidValidity) yield* emit({ _tag: "BackfillReset" });
    const rebuilt = old && old.uidValidity !== uidValidity ? old : undefined;
    if (rebuilt) regressed = false;
    const research =
      (folderRegressed(old, uidValidity, mailbox.uidNext) && !regressed) ||
      uidValidity !== plan.validity;
    if (folderRegressed(old, uidValidity, mailbox.uidNext)) regressed = true;
    if (research) {
      ({ newUids, deleted } = yield* searchWindow(s, now));
      newUids = newUids.toSorted((a, b) => a - b);
      uidNext = mailbox.uidNext;
    }
    if (rebuilt || regressed) old = undefined;
    const previousFolder = { path: folder.path, uidValidity: rebuilt?.uidValidity ?? uidValidity };
    if (regressed) {
      yield* emit({ _tag: "BackfillReset" });
      yield* emit({ _tag: "InvalidateFolder", previous: previousFolder });
    }
    const state = old ? FolderState.from(old) : new FolderState(uidValidity, 0, undefined);
    state.watchDeleted(deleted);

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
          const exists = yield* searchUids(s, { uid: range, deleted: false });
          for (const u of exists) present.add(u);
          if (highest !== undefined && highest > since) {
            const changed = yield* call(s, (c) =>
              c.fetchAll(range, { uid: true, flags: true }, { uid: true, changedSince: since }),
            );
            for (const m of changed) {
              if (m.flags?.has("\\Deleted")) {
                present.delete(m.uid);
                state.deleted.add(m.uid);
              } else current.set(m.uid, flagsOf(m.flags));
            }
          }
        } else if (scan) {
          const all = yield* call(s, (c) =>
            c.fetchAll(range, { uid: true, flags: true }, { uid: true }),
          );
          for (const m of all) {
            if (m.flags?.has("\\Deleted")) {
              state.deleted.add(m.uid);
              continue;
            }
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
        yield* emit({
          _tag: "RebuildFolder",
          previous: previousFolder,
          keep: [],
          candidates,
          partial: true,
        });
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
      // Marked \Deleted since the search (or expunged): watch it; the next sync drops it if expunged.
      for (const uid of batch) if (!state.flags.has(uid)) state.deleted.add(uid);
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
    state.watchDeleted(state.deleted);
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

    const gone = yield* confirmFolderGone(s, path).pipe(
      Effect.catchTag("ProviderError", () => Effect.succeed(false)),
    );
    if (!gone) {
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

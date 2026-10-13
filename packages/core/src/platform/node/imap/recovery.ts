import { Effect, Option, Schema } from "effect";
import { PermanentError, ProviderError } from "../../../domain/errors.js";
import { FOLDER_BATCH_LIMIT } from "../../../domain/folder-actions.js";
import { CACHED_HEADER_NAMES, cachedHeaders } from "../../../sync/header-backfill.js";
import type { CachedHeaders, ResetVerification } from "../../../sync/sync-records.js";
import {
  decodeProviderId,
  encodeProviderId,
  uidSet,
  type ImapCursor,
} from "../../../providers/imap/imap-cursor.js";
import { retainedResetLabels } from "../../../providers/imap/imap-helpers.js";
import type { ProviderAdapter } from "../../../providers/adapter.js";
import { imapSearch } from "../imap-search.js";
import { openFolderOf } from "./ops.js";
import { mapFolders } from "./parse.js";
import type { ImapPool } from "./pool.js";
import { fetchMessages } from "./pull.js";
import { call, confirmFolderGone, searchUids } from "./session.js";
export const makeImapRecovery = ({
  session,
  namespaces,
}: {
  session: ImapPool["session"];
  namespaces: Map<string, ImapCursor>;
}) => {
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
              Effect.mapError(() => new ProviderError({ message: "Invalid IMAP backfill cursor" })),
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
        const found = yield* searchUids(s, {
          uid: `${lower}:${upper}`,
          before: new Date(state.before),
          deleted: false,
        });
        const uids = found
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

  const fetchCachedHeaders: NonNullable<ProviderAdapter["fetchCachedHeaders"]> = (account, ids) =>
    Effect.gen(function* () {
      const { s } = yield* session(account);
      const groups = new Map<string, { validity: string; ids: Map<number, string> }>();
      const out: CachedHeaders[] = [];
      for (const id of ids) {
        const ref = decodeProviderId(id);
        if (Option.isNone(ref)) {
          out.push({ kind: "unavailable", id });
          continue;
        }
        const key = JSON.stringify([ref.value.path, ref.value.uidValidity]);
        const group = groups.get(key) ?? {
          validity: ref.value.uidValidity,
          ids: new Map<number, string>(),
        };
        group.ids.set(ref.value.uid, id);
        groups.set(key, group);
      }
      for (const group of groups.values()) {
        const firstId = group.ids.values().next().value;
        if (!firstId) continue;
        const ref = decodeProviderId(firstId);
        if (Option.isNone(ref)) continue;
        const mailbox = yield* call(s, (c) => c.mailboxOpen(ref.value.path, { readOnly: true }));
        const known = namespaces.get(account.id)?.folders[ref.value.path];
        if (
          String(mailbox.uidValidity) !== group.validity ||
          (known !== undefined && mailbox.uidNext < known.lastUid + 1)
        ) {
          for (const id of group.ids.values()) out.push({ kind: "unavailable", id });
          continue;
        }
        const rows = yield* call(s, (c) =>
          c.fetchAll(
            uidSet([...group.ids.keys()]),
            { uid: true, headers: CACHED_HEADER_NAMES },
            { uid: true },
          ),
        );
        const byUid = new Map(rows.map((row) => [row.uid, row]));
        for (const [uid, id] of group.ids) {
          const row = byUid.get(uid);
          if (!row) out.push({ kind: "unavailable", id });
          else if (row.headers) out.push(cachedHeaders(id, row.headers.toString("utf8")));
          // A returned UID without its requested literal is an incomplete reply.
        }
      }
      return out;
    }).pipe(Effect.scoped);

  const verifyResetCandidates: NonNullable<ProviderAdapter["verifyResetCandidates"]> = (
    account,
    candidates,
  ) =>
    Effect.gen(function* () {
      const { s } = yield* session(account);
      const folders = mapFolders(yield* call(s, (client) => client.list()));
      const results: ResetVerification[] = [];
      const groups = new Map<string, typeof candidates>();
      for (const candidate of candidates) {
        const ref = decodeProviderId(candidate.resetProviderId ?? candidate.providerId);
        if (Option.isNone(ref)) continue;
        groups.set(ref.value.path, [...(groups.get(ref.value.path) ?? []), candidate]);
      }
      for (const [path, group] of groups) {
        const original = folders.find((folder) => folder.path === path);
        if (!original && !(yield* confirmFolderGone(s, path))) continue;
        let validity: string | undefined;
        let present = new Set<number>();
        if (original) {
          const mailbox = yield* call(s, (client) => client.mailboxOpen(path, { readOnly: true }));
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
            const found = yield* searchUids(s, { uid: uidSet(uids), deleted: false });
            present = new Set(found);
          }
        }
        for (const candidate of group) {
          const ref = decodeProviderId(candidate.resetProviderId ?? candidate.providerId);
          if (Option.isNone(ref)) continue;
          const retained = retainedResetLabels(candidate.labels);
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
            if (!candidate.resetProviderId && (!original || validity === ref.value.uidValidity))
              results.push({ kind: "gone", id: candidate.providerId });
            continue; // UIDVALIDITY changes without Message-ID cannot establish absence.
          }
          const matches: ResetVerification[] = [];
          for (const folder of folders) {
            const mailbox = yield* call(s, (client) =>
              client.mailboxOpen(folder.path, { readOnly: true }),
            );
            const found = yield* searchUids(s, {
              header: { "message-id": candidate.rfcMessageId },
              deleted: false,
            });
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
          previous?.path === folder.path ? previous.after : options?.newestFirst ? 0x100000000 : 0;
        if (previous?.path === folder.path && previous.validity !== validity)
          return yield* new PermanentError({
            message: "IMAP UIDVALIDITY changed during pagination.",
          });
        const query = imapSearch({
          ...(options?.unreadOnly ? { unreadOnly: true } : {}),
          ...(scope.mailbox === "starred" ? { starredOnly: true } : {}),
          ...(scope.mailbox === "important" ? { criteria: { important: true } } : {}),
        });
        const found = yield* searchUids(s, {
          ...query,
          deleted: false,
          uid: options?.newestFirst ? `1:${Math.max(1, after - 1)}` : `${after + 1}:*`,
        });
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
  return {
    listFolderMessages,
    backfill,
    fetchMessage,
    fetchCachedHeaders,
    verifyResetCandidates,
  } satisfies Pick<
    ProviderAdapter,
    | "listFolderMessages"
    | "backfill"
    | "fetchMessage"
    | "fetchCachedHeaders"
    | "verifyResetCandidates"
  >;
};

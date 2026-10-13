import { Clock, Effect, Option, Queue, Schema, Stream } from "effect";
import { encodeFolder, mailQuote } from "../mail-socket.js";
import {
  FolderState,
  decodeProviderId,
  encodeProviderId,
  folderRegressed,
  readCursor,
  uidSet,
} from "../../providers/imap/imap-cursor.js";
import {
  AuthError,
  InvalidInput,
  PermanentError,
  ProviderError,
  SendUncertain,
  type ProviderFailure,
} from "../../domain/errors.js";
import { Buffer } from "../bytes.js";
import {
  array,
  failure,
  fetchFields,
  fetchRawIn,
  folders,
  mobileIncoming,
  refOf,
  text,
  unsupported,
} from "./imap-parse.js";
import type { Change, ProviderAdapter, ProviderIdMapping } from "../../providers/adapter.js";
import {
  FolderStatus,
  type CachedHeaders,
  type ResetVerification,
} from "../../sync/sync-records.js";
import { CACHED_HEADER_NAMES, cachedHeaders } from "../../sync/header-backfill.js";
import {
  flagsOf,
  groupIdsByFolder,
  retainedResetLabels,
} from "../../providers/imap/imap-helpers.js";
import { resolveImapSettings, serverSavesSent } from "../../providers/imap/imap-settings.js";
import { applyPush } from "./imap-push.js";
import { smtpSession } from "./smtp.js";
import { confirmDelivery } from "../../providers/provider-send.js";
import { searchMailboxLabel } from "../../search/search.js";
import type { IncomingMessage } from "../../domain/message.js";
import { matchesSearch } from "../../search/search-match.js";
import { makeMobileImapSessions } from "./imap-session.js";

export const makeMobileImap = Effect.gen(function* () {
  const {
    transport,
    codec,
    observedSent,
    namespaces,
    copiedFor,
    messageIdsFor,
    pushState,
    credentials,
    open,
    session,
    incoming,
    pushSession,
    closeSessions,
  } = yield* makeMobileImapSessions;
  const fetchRaw: ProviderAdapter["fetchRaw"] = (account, id, maxBytes) =>
    session(account, async (client) => {
      const row = await fetchRawIn(client, id, maxBytes);
      if (!(row.raw instanceof Uint8Array))
        throw new PermanentError({ message: "Missing mail source" });
      return row.raw;
    });
  const fetchCachedHeaders: NonNullable<ProviderAdapter["fetchCachedHeaders"]> = (account, ids) =>
    session(account, async (client) => {
      const groups = new Map<
        string,
        { path: string; validity: string; ids: Map<number, string> }
      >();
      const out: CachedHeaders[] = [];
      for (const id of ids) {
        const ref = decodeProviderId(id);
        if (Option.isNone(ref)) {
          out.push({ kind: "unavailable", id });
          continue;
        }
        const key = JSON.stringify([ref.value.path, ref.value.uidValidity]);
        const group = groups.get(key) ?? {
          path: ref.value.path,
          validity: ref.value.uidValidity,
          ids: new Map<number, string>(),
        };
        group.ids.set(ref.value.uid, id);
        groups.set(key, group);
      }
      for (const group of groups.values()) {
        const validity = await client.select(group.path);
        const known = namespaces.get(account.id)?.folders[group.path];
        if (
          validity !== group.validity ||
          (known !== undefined &&
            client.uidNext !== undefined &&
            client.uidNext < known.lastUid + 1)
        ) {
          for (const id of group.ids.values()) out.push({ kind: "unavailable", id });
          continue;
        }
        const rows = fetchFields(
          await client.command(
            `UID FETCH ${uidSet([...group.ids.keys()])} (UID BODY.PEEK[HEADER.FIELDS (${CACHED_HEADER_NAMES.join(" ")})])`,
          ),
        );
        const byUid = new Map(rows.map((row) => [row.uid, row]));
        for (const [uid, id] of group.ids) {
          const row = byUid.get(uid);
          if (!row) out.push({ kind: "unavailable", id });
          else if (row.raw) out.push(cachedHeaders(id, Buffer.from(row.raw).toString("utf8")));
        }
      }
      return out;
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
          const retained = retainedResetLabels(candidate.labels);
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
  const pushBatch: NonNullable<ProviderAdapter["pushBatch"]> = (
    account,
    ids,
    op,
    cursor,
    context,
  ) =>
    pushSession(account, async (client, signal) => {
      for (const id of ids) refOf(id);
      const decodedGroups = groupIdsByFolder(ids);
      if (Option.isNone(decodedGroups))
        throw new PermanentError({ message: "Invalid IMAP message id" });
      const groups = decodedGroups.value;
      const mappings: ProviderIdMapping[] = [];
      let reconcile = false;
      for (const group of groups.values()) {
        const moved = await applyPush(
          client,
          group.ids,
          op,
          messageIdsFor(account.id, context?.messageIds),
          copiedFor(account.id),
          pushState(account, group.path, cursor),
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
              const regressed = folderRegressed(old, validity, client.uidNext);
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
                  if (row.flags.includes("\\Deleted")) {
                    state.deleted.add(row.uid);
                    continue;
                  }
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
              // \Deleted mail isn't stored but is watched: an undelete brings it back.
              const restored: number[] = [];
              const watched = [...state.deleted];
              state.deleted.clear();
              for (const uid of await client.search(`DELETED ${criteria}`))
                if (uid > state.lastUid) state.deleted.add(uid);
              for (let i = 0; i < watched.length; i += 500)
                for (const row of fetchFields(
                  await client.command(
                    `UID FETCH ${uidSet(watched.slice(i, i + 500))} (UID FLAGS)`,
                  ),
                ))
                  if (row.flags.includes("\\Deleted")) state.deleted.add(row.uid);
                  else restored.push(row.uid);
              const pending = [
                ...new Set([...found.filter((uid) => uid > state.lastUid), ...restored]),
              ].toSorted((a, b) => a - b);
              const newest = old && !rebuilt && !regressed ? pending : pending.slice(-1000);
              for (const [index, uid] of newest.entries()) {
                const row = await fetchRawIn(client, encodeProviderId(path.path, validity, uid));
                if (row.flags.includes("\\Deleted")) {
                  state.deleted.add(uid);
                  continue;
                }
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
              state.watchDeleted(state.deleted);
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
    fetchCachedHeaders,
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

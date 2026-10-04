import { Effect, Exit, Option, Predicate, Queue, Schema, Scope, Semaphore, Stream } from "effect";
import { attachmentFromRaw, MEDIA_RAW_TOO_LARGE } from "../../../attachments.js";
import type { Account, IncomingMessage, OutgoingMessage } from "../../../domain.js";
import { PermanentError, ProviderError, type ProviderFailure } from "../../../errors.js";
import { FOLDER_BATCH_LIMIT, type PermanentDeleteBatch } from "../../../folder-actions.js";
import {
  CACHED_HEADER_NAMES,
  cachedHeaders,
  type CachedHeaders,
} from "../../../header-backfill.js";
import { groupIdsByFolder, retainedResetLabels } from "../../../imap-helpers.js";
import {
  decodeProviderId,
  encodeProviderId,
  readCursor,
  uidSet,
  type ImapCursor,
} from "../../../imap-cursor.js";
import { imapSettingsKey, serverSavesSent } from "../../../imap-settings.js";
import { confirmDelivery } from "../../../provider-send.js";
import { matchesSearch, parseSearchQuery, searchMailboxLabel } from "../../../search.js";
import {
  Secrets,
  type Change,
  type DraftPush,
  type ProviderAdapter,
  type ProviderPushContext,
} from "../../../services.js";
import type { ResetVerification } from "../../../sync-reset.js";
import { MailCodec } from "../../mail-codec.js";
import { buildMime } from "../compose.js";
import { watchImapInbox } from "../imap-idle.js";
import { imapSearch } from "../imap-search.js";
import { appendDraft, sameImapId, saveSent, threadingOf } from "./drafts.js";
import { applyOp, deleteMessage, openFolderOf, requireTargetedExpunge } from "./ops.js";
import { attachmentNodes, mapFolders, parseHeaders, stripBcc } from "./parse.js";
import { FETCH_BATCH, fetchMessages, runPull } from "./pull.js";
import {
  call,
  confirmFolderGone,
  connect,
  describe,
  failure,
  isAuthFailure,
  openImap,
  password,
  searchUids,
  type Session,
  settingsOf,
  smtpTransport,
} from "./session.js";

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
    const pushBatch: NonNullable<ProviderAdapter["pushBatch"]> = (
      account,
      ids,
      op,
      cursor,
      context?: ProviderPushContext,
    ) =>
      pushSession(account, (s) =>
        Effect.gen(function* () {
          const decodedGroups = groupIdsByFolder(ids);
          if (Option.isNone(decodedGroups)) {
            const invalid = ids.find((id) => Option.isNone(decodeProviderId(id)));
            return yield* new PermanentError({ message: `Not an IMAP message id: ${invalid}` });
          }
          const groups = decodedGroups.value;
          const mappings: import("../../../services.js").ProviderIdMapping[] = [];
          let reconcile = false;
          for (const first of groups.values()) {
            const moved = yield* applyOp(
              s,
              { ...first, uid: first.uids[0] },
              op,
              first.uids,
              pushState(account, first.path, cursor),
              context,
            );
            if ("reconcile" in moved) reconcile = true;
            else mappings.push(...moved);
          }
          return reconcile ? ({ reconcile: true } as const) : mappings;
        }),
      );
    const push: ProviderAdapter["push"] = (
      account,
      providerId,
      op,
      cursor,
      context?: ProviderPushContext,
    ) =>
      op.kind === "important"
        ? Effect.void
        : Option.match(decodeProviderId(providerId), {
            onNone: () =>
              Effect.fail(new PermanentError({ message: `Not an IMAP message id: ${providerId}` })),
            onSome: (ref) =>
              pushSession(account, (s) =>
                applyOp(s, ref, op, [ref.uid], pushState(account, ref.path, cursor), context),
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

        const phase = { dataSent: false };
        const transport = yield* smtp(settings, pass, () => {
          phase.dataSent = true;
        });
        const smtpRaw = stripBcc(raw);
        const submission = yield* Effect.tryPromise({
          try: () =>
            transport.sendMail({
              envelope: { from: account.email, to: recipients, size: smtpRaw.length },
              raw: smtpRaw,
            }),
          catch: (error) => error,
        }).pipe(Effect.result);
        let confirmed = false;
        const rejected: string[] = [];
        if (submission._tag === "Failure") {
          const error = submission.failure;
          const responseCode =
            Predicate.isObject(error) &&
            "responseCode" in error &&
            typeof error.responseCode === "number"
              ? error.responseCode
              : undefined;
          const code = Predicate.isObject(error) && "code" in error ? error.code : undefined;
          const command =
            Predicate.isObject(error) && "command" in error ? error.command : undefined;
          if (isAuthFailure(error)) return yield* failure(account.id, settings.smtpHost, error);
          if (responseCode !== undefined && responseCode >= 500)
            return yield* new PermanentError({
              message: `${settings.smtpHost}: ${describe(error)}`,
            });
          if (
            code === "EMESSAGE" &&
            command === "MAIL FROM" &&
            /size larger than allowed/i.test(describe(error))
          )
            return yield* new PermanentError({
              message: `SMTP SIZE limit: ${describe(error)}. Remove attachments before sending.`,
            });
          // CONN errors occur during greeting, authentication and DATA; only the tracked DATA phase is uncertain.
          const uncertain =
            phase.dataSent &&
            responseCode === undefined &&
            (code === "ETIMEDOUT" ||
              code === "ESOCKET" ||
              code === "ECONNECTION" ||
              code === "ECONNRESET" ||
              code === "EPIPE" ||
              command === "DATA");
          if (!uncertain) return yield* failure(account.id, settings.smtpHost, error);
          const messageId = parseHeaders(raw).get("message-id");
          yield* confirmDelivery(
            Effect.gen(function* () {
              if (!messageId) return false;
              const fresh = yield* session(account);
              const folders = yield* call(fresh.s, (c) => c.list());
              const sent =
                folders.find((folder) => folder.specialUse === "\\Sent")?.path ??
                folders.find((folder) => folder.path === "Sent")?.path;
              if (!sent) return false;
              yield* call(fresh.s, (c) => c.mailboxOpen(sent, { readOnly: true }));
              return (
                (yield* searchUids(fresh.s, {
                  header: { "message-id": messageId },
                  deleted: false,
                })).length > 0
              );
            }).pipe(Effect.scoped),
          );
          confirmed = true;
          observedSent.add(account.id);
        } else {
          for (const address of submission.success.rejected) rejected.push(address);
        }

        let sentCopyMissing = false;
        if (!confirmed) {
          const serverSaves = serverSavesSent(settings) || observedSent.has(account.id);
          const saved = yield* saveSent(s, raw, serverSaves, observedSent).pipe(Effect.result);
          if (saved._tag === "Failure") {
            const retried = yield* Effect.gen(function* () {
              const fresh = yield* session(account);
              yield* saveSent(fresh.s, raw, serverSaves, observedSent);
            }).pipe(Effect.scoped, Effect.result);
            sentCopyMissing = retried._tag === "Failure";
          }
        }
        return rejected.length || sentCopyMissing
          ? {
              ...(rejected.length ? { rejected } : {}),
              ...(sentCopyMissing ? { sentCopyMissing: true } : {}),
            }
          : undefined;
      }).pipe(Effect.scoped);

    const saveDraft: ProviderAdapter["saveDraft"] = (
      account,
      draft: DraftPush,
      context?: ProviderPushContext,
    ) =>
      Effect.gen(function* () {
        const { s } = yield* session(account);
        const threading = Option.isSome(draft.original)
          ? yield* threadingOf(s, draft.original.value.providerId)
          : {};
        const raw = yield* buildMime(
          { name: "", address: account.email },
          draft.message,
          threading,
          {
            draft: true,
            ...(context?.appendedDraftMessageId
              ? { messageId: context.appendedDraftMessageId }
              : {}),
          },
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
          context,
          codec,
        );
      }).pipe(Effect.scoped);

    const deleteDraft: ProviderAdapter["deleteDraft"] = (account, remote) =>
      Effect.gen(function* () {
        const id = remote.messageId ?? remote.draftId;
        if (!id && !remote.rfcMessageId) return;
        const { s } = yield* session(account);
        if (id) yield* deleteMessage(s, id);
        if (remote.rfcMessageId) {
          const list = yield* call(s, (c) => c.list());
          const drafts = list.filter(
            (folder) =>
              !folder.flags.has("\\Noselect") &&
              (folder.specialUse === "\\Drafts" ||
                folder.path
                  .split(folder.delimiter || "/")
                  .at(-1)
                  ?.toLowerCase() === "drafts"),
          );
          for (const folder of drafts) {
            const mailbox = yield* call(s, (c) => c.mailboxOpen(folder.path, { readOnly: true }));
            const found = yield* searchUids(s, { header: { "message-id": remote.rfcMessageId } });
            for (const uid of found) {
              const matched = encodeProviderId(folder.path, mailbox.uidValidity, uid);
              if (!id || !sameImapId(id, matched)) yield* deleteMessage(s, matched);
            }
          }
        }
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
          const found = yield* searchUids(s, { ...imapSearch(query), deleted: false });
          const uids = found.toSorted((a, b) => b - a);
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
    const permanentlyDelete: ProviderAdapter["permanentlyDelete"] = (account, ids) =>
      Effect.gen(function* () {
        if (ids.length > FOLDER_BATCH_LIMIT)
          return yield* new PermanentError({
            message: "Permanent delete batch exceeds 100 messages.",
          });
        const decodedGroups = groupIdsByFolder(ids);
        if (Option.isNone(decodedGroups))
          return yield* new PermanentError({ message: "Invalid IMAP message id." });
        const groups = decodedGroups.value;
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
          const decodedGroups = groupIdsByFolder(ids);
          if (Option.isNone(decodedGroups))
            return yield* new PermanentError({ message: "Invalid IMAP message id." });
          const groups = decodedGroups.value;
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
      fetchCachedHeaders,
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

import { Effect, Option, Queue, Stream } from "effect";
import { attachmentFromRaw, MEDIA_RAW_TOO_LARGE } from "../../../attachments.js";
import type { Account, IncomingMessage } from "../../../domain.js";
import { PermanentError, ProviderError, type ProviderFailure } from "../../../errors.js";
import { FOLDER_BATCH_LIMIT, type PermanentDeleteBatch } from "../../../folder-actions.js";
import { decodeProviderId, readCursor, type ImapCursor } from "../../../imap-cursor.js";
import { groupIdsByFolder } from "../../../imap-helpers.js";
import { matchesSearch, parseSearchQuery, searchMailboxLabel } from "../../../search.js";
import {
  Secrets,
  type Change,
  type ProviderAdapter,
  type ProviderPushContext,
} from "../../../services.js";
import { MailCodec } from "../../mail-codec.js";
import { watchImapInbox } from "../imap-idle.js";
import { imapSearch } from "../imap-search.js";

import { applyOp, openFolderOf, requireTargetedExpunge } from "./ops.js";
import { attachmentNodes, mapFolders } from "./parse.js";
import { makeImapPool } from "./pool.js";
import { FETCH_BATCH, fetchMessages, runPull } from "./pull.js";
import { makeImapRecovery } from "./recovery.js";
import { makeImapSend } from "./send.js";
import {
  call,
  connect,
  failure,
  openImap,
  password,
  searchUids,
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

    const namespaces = new Map<string, ImapCursor>();

    const pushState = (account: Account, path: string, cursor?: string) =>
      readCursor(Option.fromNullishOr(cursor)).folders[path] ??
      namespaces.get(account.id)?.folders[path];

    const { session, pushSession, closeSessions } = yield* makeImapPool(open, secrets);
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
      ...makeImapSend({ session, smtp, codec }),
      ...makeImapRecovery({ session, namespaces }),
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
      connect,
      pull,
      push,
      pushBatch,
      closeSessions,
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
    } satisfies ProviderAdapter;
  });
export const makeImap = makeImapWith(openImap);

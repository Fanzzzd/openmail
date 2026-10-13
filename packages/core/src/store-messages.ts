import { Cause, Clock, Effect, Option, Schema } from "effect";
import { type SqlClient } from "effect/sql";
import { isSqlError } from "effect/sql/SqlError";
import { type IncomingMessage, type MailOp, type Message } from "./domain/domain.js";
import { NotFound, ProviderError } from "./domain/errors.js";
import { decodeProviderId } from "./imap-cursor.js";
import { applyOpToLabels } from "./domain/mail-ops.js";
import { cleanDisplayName } from "./message-security.js";
import { type PlatformCrypto } from "./platform/crypto.js";
import { type Store } from "./services.js";
import { all, first, run } from "./sql-rows.js";
import { type makeComposeStore } from "./store-compose.js";
import { type makeContactStore } from "./store-contacts.js";
import { type makeMediaStore } from "./store-media.js";
import {
  EpochRow,
  imapEpochKey,
  Labels,
  LabelsAndProvider,
  MESSAGE_COLUMNS,
  MessageId,
  MessageRow,
  REDACT_DECIDED,
  Ref,
  Reminder,
  ThreadKey,
  toMessage,
} from "./store-rows.js";
import { makeSyncResetStore } from "./store-sync-reset.js";
import { logSyncReset } from "./sync-reset.js";

import { type makeQueryStore } from "./store-query.js";

export const makeMessagesStore = ({
  sql,
  crypto,
  compose,
  media,
  contacts,
  getAccount,
  hasLabel,
  imapFolder,
  outsideKeep,
}: {
  sql: SqlClient.SqlClient;
  crypto: PlatformCrypto;
  compose: ReturnType<typeof makeComposeStore>;
  media: ReturnType<typeof makeMediaStore>;
  contacts: ReturnType<typeof makeContactStore>;
  getAccount: Store["Service"]["getAccount"];
  hasLabel: ReturnType<typeof makeQueryStore>["hasLabel"];
  imapFolder: ReturnType<typeof makeQueryStore>["imapFolder"];
  outsideKeep: ReturnType<typeof makeQueryStore>["outsideKeep"];
}) =>
  Effect.gen(function* () {
    const syncResets = makeSyncResetStore(sql, hasLabel, imapFolder);

    const invalidateImapFolder = (
      account: string,
      previous: import("./services.js").ImapFolderIdentity,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const ids = (yield* all(MessageId)(
              sql`SELECT m.id FROM messages AS m WHERE m.account_id=${account} AND ${imapFolder(previous)}`,
            )).map((row) => row.id);
            const snapshot = yield* syncResets.resetCandidates(account, {
              _tag: "RebuildFolder",
              previous,
              keep: [],
            });
            const generation = crypto.randomUUID();
            const now = yield* Clock.currentTimeMillis;
            yield* logSyncReset(yield* getAccount(account).pipe(Effect.orDie), previous.path, {
              phase: "reset",
              listed: 0,
              kept: 0,
              local: snapshot.local,
              candidates: snapshot.candidates.length,
              verified: 0,
              incomplete: 0,
              deferred: snapshot.candidates.length,
            });
            // Persist the generation before deleting rows; stale handles must never name refetched mail.
            yield* run(
              sql`INSERT INTO prefs(key,value_json) VALUES(${imapEpochKey(account, previous)},${JSON.stringify(generation)}) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json`,
            );
            yield* run(
              sql`DELETE FROM undo_batches WHERE EXISTS(SELECT 1 FROM json_tree(payload) e WHERE e.key='id' AND e.value IN (SELECT value FROM json_each(${JSON.stringify(ids)})))`,
            );
            yield* run(
              sql`UPDATE proposals SET status='rejected',decided_at=${now},${sql.literal(REDACT_DECIDED)} WHERE status='pending' AND (EXISTS(SELECT 1 FROM json_each(command_json,'$.threads') t WHERE t.value IN (SELECT value FROM json_each(${JSON.stringify(ids)}))) OR json_extract(command_json,'$.message.inReplyTo') IN (SELECT value FROM json_each(${JSON.stringify(ids)})))`,
            );
            // The server reused UIDs without changing UIDVALIDITY. None of the old references are safe.
            yield* run(
              sql`UPDATE pending_ops AS m SET provider_id='unmapped:' || provider_id || ':' || id, op_json=${JSON.stringify({ kind: "reconcile" })}, claimed_at=NULL, attempts=0, last_error='IMAP UID namespace reset' WHERE m.account_id=${account} AND ${imapFolder(previous)}`,
            );
            yield* run(
              sql`DELETE FROM snoozed_messages AS m WHERE m.account_id=${account} AND ${imapFolder(previous)}`,
            );
            yield* run(
              sql`DELETE FROM thread_reminders WHERE account_id=${account} AND NOT EXISTS(SELECT 1 FROM snoozed_messages s WHERE s.account_id=thread_reminders.account_id AND s.thread_id=thread_reminders.thread_id)`,
            );
            yield* run(
              sql`UPDATE drafts SET remote_message_id=NULL, remote_draft_id=NULL WHERE account_id=${account} AND (${imapFolder(previous, sql.literal("remote_message_id"))} OR ${imapFolder(previous, sql.literal("remote_draft_id"))})`,
            );
            const pending = yield* syncResets.pendingResetCandidates(account);
            const originals = new Set(snapshot.candidates.map((candidate) => candidate.providerId));
            const detached = snapshot.candidates.map((candidate) => ({
              ...candidate,
              resetProviderId: candidate.providerId,
              providerId: `unmapped:${candidate.providerId}:reset:${generation}`,
            }));
            for (const candidate of detached)
              yield* run(
                sql`UPDATE messages SET provider_id=${candidate.providerId} WHERE account_id=${account} AND provider_id=${candidate.resetProviderId}`,
              );
            yield* syncResets.saveResetCandidates(account, [
              ...pending.filter((candidate) => !originals.has(candidate.providerId)),
              ...detached,
            ]);
            return ids;
          }),
        )
        .pipe(Effect.catchIf(isSqlError, (error) => Effect.die(error)));

    let lastTruncate = yield* Clock.currentTimeMillis;

    const messageIdForProvider = (account: string, providerId: string) =>
      first(MessageId)(
        sql`SELECT id FROM messages WHERE account_id=${account} AND provider_id=${providerId} ORDER BY date DESC,id LIMIT 1`,
      ).pipe(Effect.map((row) => (Option.isSome(row) ? row.value.id : null)));

    const remapProviderIds = (
      account: string,
      mappings: readonly import("./services.js").ProviderIdMapping[],
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            for (const mapping of mappings) {
              if (mapping.from === mapping.to) continue;
              const source = yield* messageIdForProvider(account, mapping.from);
              if (source) {
                const sameMessage = sql`m.rfc_message_id IS NOT NULL AND m.rfc_message_id=(SELECT rfc_message_id FROM messages WHERE id=${source})`;
                yield* media.deleteVectorsForMessages(
                  sql`m.account_id=${account} AND m.provider_id=${mapping.to} AND m.id<>${source} AND ${sameMessage}`,
                );
                yield* run(
                  sql`DELETE FROM messages AS m WHERE m.account_id=${account} AND m.provider_id=${mapping.to} AND m.id<>${source} AND ${sameMessage}`,
                );
                // Keep an unrelated cached target, but never bind its queued mutations to the moved mail.
                if (yield* messageIdForProvider(account, mapping.to)) {
                  const detached = `unmapped:${crypto.randomUUID()}`;
                  yield* run(
                    sql`UPDATE pending_ops SET provider_id=${detached}, op_json=${JSON.stringify({ kind: "reconcile" })}, claimed_at=NULL WHERE account_id=${account} AND provider_id=${mapping.to}`,
                  );
                  yield* run(
                    sql`UPDATE messages SET provider_id=${detached} WHERE account_id=${account} AND provider_id=${mapping.to} AND id<>${source}`,
                  );
                  const now = yield* Clock.currentTimeMillis;
                  yield* run(
                    sql`INSERT INTO pending_ops(account_id,provider_id,op_json,created_at) SELECT ${account},${detached},${JSON.stringify({ kind: "reconcile" })},${now} WHERE NOT EXISTS(SELECT 1 FROM pending_ops WHERE account_id=${account} AND provider_id=${detached})`,
                  );
                  yield* run(
                    sql`DELETE FROM snoozed_messages WHERE account_id=${account} AND provider_id=${mapping.to}`,
                  );
                  yield* run(
                    sql`UPDATE drafts SET remote_message_id=NULL,remote_draft_id=NULL WHERE account_id=${account} AND remote_message_id=${mapping.to}`,
                  );
                }
                yield* run(sql`UPDATE messages SET provider_id=${mapping.to} WHERE id=${source}`);
              }
              yield* run(
                sql`UPDATE pending_ops SET provider_id=${mapping.to} WHERE account_id=${account} AND provider_id=${mapping.from}`,
              );
              yield* run(
                sql`DELETE FROM snoozed_messages WHERE account_id=${account} AND provider_id=${mapping.to} AND EXISTS(SELECT 1 FROM snoozed_messages WHERE account_id=${account} AND provider_id=${mapping.from})`,
              );
              yield* run(
                sql`INSERT OR IGNORE INTO snoozed_messages(account_id,thread_id,provider_id,wake_pending) SELECT account_id,thread_id,${mapping.to},wake_pending FROM snoozed_messages WHERE account_id=${account} AND provider_id=${mapping.from}`,
              );
              yield* run(
                sql`DELETE FROM snoozed_messages WHERE account_id=${account} AND provider_id=${mapping.from}`,
              );
              yield* run(
                sql`UPDATE drafts SET remote_message_id=${mapping.to}, remote_draft_id=CASE WHEN remote_draft_id=${mapping.from} THEN ${mapping.to} ELSE remote_draft_id END WHERE account_id=${account} AND remote_message_id=${mapping.from}`,
              );
            }
          }),
        )
        .pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.interrupt
              : Effect.fail(
                  new ProviderError({
                    message:
                      "Could not update local message identities. The change will be retried.",
                  }),
                ),
          ),
        );

    const upsertMessage = Effect.fn("Store.upsertMessage")(function* (
      account: string,
      incoming: IncomingMessage,
    ) {
      if (incoming.labels.some((l) => ["DRAFT", "TRASH", "SPAM"].includes(l)))
        yield* run(
          sql`DELETE FROM snoozed_messages WHERE account_id=${account} AND provider_id=${incoming.providerId}`,
        );
      const reminder = yield* first(Reminder)(
        sql`SELECT r.due_at, r.woken_at, s.wake_pending FROM thread_reminders r JOIN snoozed_messages s ON s.account_id=r.account_id AND s.thread_id=r.thread_id WHERE s.account_id=${account} AND s.provider_id=${incoming.providerId}`,
      );
      let localId = yield* messageIdForProvider(account, incoming.providerId);
      if (localId === null) {
        const ref = decodeProviderId(incoming.providerId);
        const epoch = Option.isSome(ref)
          ? yield* first(EpochRow)(
              sql`SELECT value_json AS epoch FROM prefs WHERE key=${imapEpochKey(account, ref.value)}`,
            )
          : Option.none();
        const candidate = Option.isSome(epoch)
          ? `${account}/epoch:${epoch.value.epoch}/${incoming.providerId}`
          : `${account}/${incoming.providerId}`;
        const existing = yield* first(Schema.Struct({ provider_id: Schema.String }))(
          sql`SELECT provider_id FROM messages WHERE id=${candidate}`,
        );
        localId =
          Option.isSome(existing) && existing.value.provider_id !== incoming.providerId
            ? `${account}/local:${crypto.randomUUID()}`
            : candidate;
      }
      let m = incoming;
      if (incoming.parentRfcMessageId) {
        const parent = yield* first(Schema.Struct({ thread_id: Schema.String }))(
          sql`SELECT thread_id FROM messages WHERE account_id=${account} AND trim(rfc_message_id, '<>')=${incoming.parentRfcMessageId.replace(/^<|>$/g, "")} ORDER BY date DESC LIMIT 1`,
        );
        if (Option.isSome(parent)) m = { ...m, threadId: parent.value.thread_id };
        else {
          const existing = yield* first(Schema.Struct({ thread_id: Schema.String }))(
            sql`SELECT thread_id FROM messages WHERE id=${localId}`,
          );
          if (Option.isSome(existing)) m = { ...m, threadId: existing.value.thread_id };
        }
      }
      if (incoming.labels.includes("DRAFT")) {
        const owner = yield* getAccount(account).pipe(Effect.orDie);
        if (owner.provider === "gmail") {
          const draft = yield* compose.draftByRemoteMessage(account, incoming.providerId);
          const draftOrganization = Option.isSome(draft)
            ? draft.value.message.draftOrganization
            : undefined;
          if (draftOrganization)
            m = {
              ...incoming,
              labels: [
                "DRAFT",
                ...draftOrganization.labels,
                ...(draftOrganization.starred ? ["STARRED"] : []),
              ],
              isStarred: draftOrganization.starred,
            };
        }
      }
      if (Option.isSome(reminder) && reminder.value.due_at !== null) {
        const owner = yield* getAccount(account).pipe(Effect.orDie);
        m = {
          ...m,
          labels: [...applyOpToLabels(m.labels, { kind: "archive" }, owner.provider), "SNOOZED"],
        };
      }
      if (
        Option.isSome(reminder) &&
        reminder.value.wake_pending &&
        reminder.value.due_at === null
      ) {
        if (m.labels.includes("INBOX") && m.isUnread)
          yield* run(
            sql`UPDATE snoozed_messages SET wake_pending=0 WHERE account_id=${account} AND provider_id=${m.providerId}`,
          );
        else {
          const owner = yield* getAccount(account).pipe(Effect.orDie);
          m = {
            ...m,
            labels: applyOpToLabels(
              applyOpToLabels(m.labels, { kind: "inbox" }, owner.provider),
              { kind: "read", value: false },
              owner.provider,
            ),
            isUnread: true,
          };
        }
      }
      yield* media.deleteVectorsForMessages(sql`m.id=${localId} AND
        (m.attachments_json!=${JSON.stringify(m.attachments)} OR
          ((m.body_cached=${m.bodyCached === false ? 0 : 1} OR ${m.bodyCached === false ? 0 : 1}=1) AND (m.body_text!=${m.bodyText} OR m.body_html!=${m.bodyHtml})))`);
      yield* (
        // ON CONFLICT DO UPDATE keeps the rowid stable, which the external-content
        // FTS table is keyed on. INSERT OR REPLACE would orphan index rows.
        run(sql`INSERT INTO messages (id, account_id, provider_id, thread_id, subject, from_name,
            from_addr, to_json, cc_json, reply_to_json, date, snippet, body_text, body_html, labels_json,
            attachments_json, is_unread, is_starred, calendar_hint, body_cached, list_date, web_link, bcc_json, rfc_message_id, message_size, headers_json, security_json)
          VALUES (${localId}, ${account}, ${m.providerId}, ${m.threadId},
            ${m.subject}, ${cleanDisplayName(m.from.name)}, ${m.from.address}, ${JSON.stringify(m.to)},
            ${JSON.stringify(m.cc)}, ${JSON.stringify(m.replyTo ?? [])}, ${m.date}, ${m.snippet}, ${m.bodyText}, ${m.bodyHtml},
            ${JSON.stringify(m.labels)}, ${JSON.stringify(m.attachments)}, ${m.isUnread ? 1 : 0},
            ${m.isStarred ? 1 : 0}, ${m.hasCalendar || m.bodyText.trimStart().startsWith("BEGIN:VCALENDAR") || m.attachments.some((a) => a.mimeType === "text/calendar" || /\.ics$/i.test(a.filename)) ? 1 : 0}, ${m.bodyCached === false ? 0 : 1}, ${Math.max(m.date, Option.isSome(reminder) ? (reminder.value.woken_at ?? 0) : 0)}, ${m.webLink ?? null}, ${JSON.stringify(m.bcc ?? [])}, ${m.rfcMessageId ?? null}, ${m.size ?? null}, ${m.headers ? JSON.stringify(m.headers) : null}, ${m.security ? JSON.stringify(m.security) : null})
          ON CONFLICT(id) DO UPDATE SET
            headers_json=COALESCE(excluded.headers_json,messages.headers_json),
            security_json=COALESCE(excluded.security_json,messages.security_json),
            bcc_json=excluded.bcc_json, rfc_message_id=COALESCE(excluded.rfc_message_id,messages.rfc_message_id), message_size=COALESCE(excluded.message_size,messages.message_size),
            thread_id = excluded.thread_id, subject = excluded.subject,
            from_name = excluded.from_name, from_addr = excluded.from_addr,
            to_json = excluded.to_json, cc_json = excluded.cc_json, reply_to_json = excluded.reply_to_json, date = excluded.date,
            snippet = excluded.snippet, body_text = excluded.body_text,
            body_html = excluded.body_html, labels_json = excluded.labels_json,
            attachments_json = excluded.attachments_json, is_unread = excluded.is_unread,
            is_starred = excluded.is_starred, calendar_hint = excluded.calendar_hint, body_cached = excluded.body_cached, list_date = excluded.list_date,
            web_link = COALESCE(excluded.web_link, messages.web_link)
          WHERE messages.security_json IS NOT COALESCE(excluded.security_json,messages.security_json) OR messages.thread_id IS NOT excluded.thread_id OR messages.subject IS NOT excluded.subject
            OR messages.from_name IS NOT excluded.from_name OR messages.from_addr IS NOT excluded.from_addr
            OR messages.to_json IS NOT excluded.to_json OR messages.cc_json IS NOT excluded.cc_json
            OR messages.reply_to_json IS NOT excluded.reply_to_json OR messages.bcc_json IS NOT excluded.bcc_json
            OR messages.date IS NOT excluded.date OR messages.snippet IS NOT excluded.snippet
            OR messages.body_text IS NOT excluded.body_text OR messages.body_html IS NOT excluded.body_html
            OR messages.labels_json IS NOT excluded.labels_json OR messages.attachments_json IS NOT excluded.attachments_json
            OR messages.is_unread IS NOT excluded.is_unread OR messages.is_starred IS NOT excluded.is_starred
            OR messages.calendar_hint IS NOT excluded.calendar_hint OR messages.body_cached IS NOT excluded.body_cached
            OR messages.list_date IS NOT excluded.list_date
            OR messages.headers_json IS NOT COALESCE(excluded.headers_json,messages.headers_json)
            OR messages.rfc_message_id IS NOT COALESCE(excluded.rfc_message_id,messages.rfc_message_id)
            OR messages.message_size IS NOT COALESCE(excluded.message_size,messages.message_size)
            OR messages.web_link IS NOT COALESCE(excluded.web_link,messages.web_link)`)
      );
      if (m.labels.includes("SENT"))
        yield* contacts.rememberMailedAddresses(
          account,
          [...m.to, ...m.cc].map((recipient) => recipient.address),
        );
    });

    const deleteMessage = Effect.fn("Store.deleteMessage")((account: string, providerId: string) =>
      media
        .deleteVectorsForMessages(sql`m.account_id=${account} AND m.provider_id=${providerId}`)
        .pipe(
          Effect.andThen(
            run(
              sql`DELETE FROM messages WHERE account_id=${account} AND provider_id=${providerId}`,
            ),
          ),
        ),
    );

    const deleteMessagesWithLabel = Effect.fn("Store.deleteMessagesWithLabel")(
      (account: string, label: string, keep?: readonly string[]) =>
        media
          .deleteVectorsForMessages(
            sql`m.account_id=${account} AND ${hasLabel(label)} AND ${outsideKeep(keep)}`,
          )
          .pipe(
            Effect.andThen(
              run(
                sql`DELETE FROM messages AS m WHERE m.account_id=${account} AND ${hasLabel(label)} AND ${outsideKeep(keep)}`,
              ),
            ),
          ),
    );

    const deleteAccountMessages = Effect.fn("Store.deleteAccountMessages")(
      (account: string, keep?: readonly string[], since?: number) =>
        media
          .deleteVectorsForMessages(
            sql`m.account_id=${account} AND ${outsideKeep(keep)} AND (${since ?? null} IS NULL OR m.date>=${since ?? null})`,
          )
          .pipe(
            Effect.andThen(
              run(
                sql`DELETE FROM messages AS m WHERE m.account_id=${account} AND ${outsideKeep(keep)} AND (${since ?? null} IS NULL OR m.date>=${since ?? null})`,
              ),
            ),
          ),
    );

    const getMessage = Effect.fn("Store.getMessage")(function* (
      id: string,
    ): Effect.fn.Return<Message, NotFound> {
      const row = yield* first(MessageRow)(
        sql`SELECT ${sql.literal(MESSAGE_COLUMNS)} FROM messages m WHERE m.id = ${id}`,
      );
      if (Option.isNone(row)) return yield* new NotFound({ what: "message", id });
      return toMessage(row.value);
    });

    const getThread = Effect.fn("Store.getThread")(function* (
      id: string,
    ): Effect.fn.Return<Message[], NotFound> {
      const key = yield* first(ThreadKey)(
        sql`SELECT account_id, thread_id FROM messages WHERE id = ${id}`,
      );
      if (Option.isNone(key)) return yield* new NotFound({ what: "message", id });
      const rows = yield* all(MessageRow)(sql`SELECT ${sql.literal(MESSAGE_COLUMNS)} FROM messages m
        WHERE account_id = ${key.value.account_id} AND thread_id = ${key.value.thread_id}
        ORDER BY date`);
      return rows.map(toMessage);
    });

    const messageRef = Effect.fn("Store.messageRef")(function* (id: string) {
      const row = yield* first(Ref)(
        sql`SELECT account_id, provider_id FROM messages WHERE id = ${id}`,
      );
      if (Option.isNone(row)) return yield* new NotFound({ what: "message", id });
      return { accountId: row.value.account_id, providerId: row.value.provider_id };
    });

    const threadMessageIds = Effect.fn("Store.threadMessageIds")(function* (id: string) {
      // `+t.date` keeps the planner on an (account_id, thread_id) index instead of walking the
      // account by date. Same-date messages keep the newest-rowid-first order explicitly.
      const rows = yield* all(MessageId)(sql`SELECT t.id FROM messages t
        JOIN messages m ON t.account_id = m.account_id AND t.thread_id = m.thread_id
        WHERE m.id = ${id} ORDER BY +t.date, t.rowid DESC`);
      return rows.map((r) => r.id);
    });

    const messageLabels = Effect.fn("Store.messageLabels")(function* (
      account: string,
      providerId: string,
    ) {
      const row = yield* first(Labels)(sql`SELECT labels_json FROM messages
        WHERE account_id = ${account} AND provider_id = ${providerId}`);
      return Option.match(row, { onNone: () => [], onSome: (r) => [...r.labels_json] });
    });

    /**
     * Sets the read and starred state a provider reported without refetching
     * the message. Unknown messages are ignored: their next Upsert brings them.
     */
    const setFlags = Effect.fn("Store.setFlags")(function* (
      account: string,
      providerId: string,
      flags: { isUnread: boolean; isStarred: boolean },
    ) {
      const labels = new Set(yield* messageLabels(account, providerId));
      const wake = yield* first(Reminder)(
        sql`SELECT r.due_at, r.woken_at, s.wake_pending FROM thread_reminders r JOIN snoozed_messages s ON s.account_id=r.account_id AND s.thread_id=r.thread_id WHERE s.account_id=${account} AND s.provider_id=${providerId}`,
      );
      const isUnread = flags.isUnread || (Option.isSome(wake) && wake.value.wake_pending);
      if (isUnread) labels.add("UNREAD");
      else labels.delete("UNREAD");
      if (flags.isStarred) labels.add("STARRED");
      else labels.delete("STARRED");
      yield* run(sql`UPDATE messages SET labels_json = ${JSON.stringify([...labels])},
          is_unread = ${isUnread ? 1 : 0}, is_starred = ${flags.isStarred ? 1 : 0}
        WHERE account_id=${account} AND provider_id=${providerId}`);
    });

    /**
     * Applies an op to the local copy so the UI updates before the provider
     * answers. Pulls replay queued changes until the provider accepts them.
     */
    const applyLocalOp = Effect.fn("Store.applyLocalOp")(function* (id: string, op: MailOp) {
      const row = yield* first(LabelsAndProvider)(sql`SELECT m.labels_json, a.provider
        FROM messages m JOIN accounts a ON a.id = m.account_id WHERE m.id = ${id}`);
      if (Option.isNone(row)) return;
      if (op.kind === "read" && op.value)
        yield* run(
          sql`UPDATE snoozed_messages SET wake_pending=0 WHERE (account_id, provider_id) IN (SELECT account_id, provider_id FROM messages WHERE id=${id})`,
        );
      if (
        ["inbox", "archive", "trash", "spam", "move"].includes(op.kind) ||
        (op.kind === "label" && op.value && row.value.provider !== "gmail")
      )
        yield* run(
          sql`UPDATE thread_reminders SET due_at=NULL, wake_pending=CASE WHEN ${op.kind} = 'inbox' THEN wake_pending ELSE 0 END WHERE (account_id, thread_id) IN (SELECT account_id, thread_id FROM messages WHERE id=${id})`,
        );
      if (
        ["archive", "trash", "spam", "move"].includes(op.kind) ||
        (op.kind === "label" && op.value && row.value.provider !== "gmail")
      )
        yield* run(
          sql`DELETE FROM snoozed_messages WHERE (account_id, provider_id) IN (SELECT account_id, provider_id FROM messages WHERE id=${id})`,
        );
      const labels = applyOpToLabels(row.value.labels_json, op, row.value.provider);
      yield* run(sql`UPDATE messages SET labels_json = ${JSON.stringify(labels)},
        is_unread = ${labels.includes("UNREAD") ? 1 : 0},
        is_starred = ${labels.includes("STARRED") ? 1 : 0}
        WHERE id = ${id}`);
    });
    return {
      upsertMessage,
      setFlags,
      deleteMessage,
      ...syncResets,
      deleteMessagesWithLabel,
      deleteAccountMessages,
      getMessage,
      getThread,
      findMessageByRfcId: (ownerId, messageId, folder) =>
        first(MessageId)(
          sql`SELECT id FROM messages AS m WHERE m.account_id=${ownerId} AND m.account_id IN (SELECT id FROM accounts WHERE enabled=1) AND trim(m.rfc_message_id, '<>')=${messageId.replace(/^<|>$/g, "")} ${folder ? sql`AND ${imapFolder(folder)}` : sql.literal("")} ORDER BY date DESC,id LIMIT 1`,
        ).pipe(Effect.map((row) => (Option.isSome(row) ? row.value.id : null))),
      deleteImapFolder: (account, previous, keep) =>
        media
          .deleteVectorsForMessages(
            sql`m.account_id=${account} AND ${imapFolder(previous)} AND ${outsideKeep(keep)}`,
          )
          .pipe(
            Effect.andThen(
              run(
                sql`DELETE FROM messages AS m WHERE m.account_id=${account} AND ${imapFolder(previous)} AND ${outsideKeep(keep)}`,
              ),
            ),
          ),
      invalidateImapFolder,
      messageRef,
      messageIdForProvider,
      remapProviderIds,
      checkpoint: run(sql`PRAGMA wal_checkpoint(PASSIVE)`).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            if (now - lastTruncate >= 24 * 60 * 60 * 1000) {
              const pages = yield* all(
                Schema.Struct({
                  busy: Schema.Number,
                  log: Schema.Number,
                  checkpointed: Schema.Number,
                }),
              )(sql`PRAGMA wal_checkpoint(PASSIVE)`);
              if (pages.every((page) => page.busy === 0 && page.log === page.checkpointed)) {
                yield* run(sql`PRAGMA wal_checkpoint(TRUNCATE)`);
                lastTruncate = now;
              }
            }
          }),
        ),
      ),
      threadMessageIds,
      messageLabels,
      applyLocalOp,
      setMessageWebLink: (id, url) => run(sql`UPDATE messages SET web_link=${url} WHERE id=${id}`),
    } satisfies Pick<
      Store["Service"],
      | "upsertMessage"
      | "setFlags"
      | "deleteMessage"
      | "deleteMessagesWithLabel"
      | "deleteAccountMessages"
      | "getMessage"
      | "getThread"
      | "findMessageByRfcId"
      | "deleteImapFolder"
      | "invalidateImapFolder"
      | "messageRef"
      | "messageIdForProvider"
      | "remapProviderIds"
      | "checkpoint"
      | "threadMessageIds"
      | "messageLabels"
      | "applyLocalOp"
      | "setMessageWebLink"
    >;
  });

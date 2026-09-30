import { applyOpToLabels } from "./mail-ops.js";
export { applyOpToLabels, folderTarget } from "./mail-ops.js";
import { makeSemanticStore } from "./store-semantic.js";
import { DatabaseCapabilities } from "./db.js";
import { makeMediaStore } from "./store-media.js";
import { DerivedChunk } from "./media.js";
/**
 * The Store service over SQLite. The only module that runs SQL. Rows are
 * decoded with schemas built from the domain types (this is the IO boundary);
 * SQL and decode failures die, since they mean a bug or a corrupt file.
 */
import { Clock, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { isSqlError } from "effect/sql/SqlError";
import type { Fragment } from "effect/sql/Statement";

import {
  type Account,
  Actor,
  actorLabel,
  Address,
  AgentWriteMode,
  Attachment,
  Command,
  ImapSettings,
  type IncomingMessage,
  type Label,
  type MailOp,
  type MailboxView,
  type Message,
  type MessageSummary,
  type NotificationBatch,
  Profile,
  type ProfileInput,
  type Proposal,
  Provider,
  QueuedOp,
  type ThreadQuery,
  type ThreadSummary,
} from "./domain.js";
import { InvalidInput, NotFound } from "./errors.js";
import { type PendingOp, Store } from "./services.js";
import { all, first, run } from "./sql-rows.js";
import { parseSearchQuery, searchWords, reciprocalRankFusion } from "./search.js";
import { makeOrganizationStore } from "./store-organization.js";
import { makeContactStore } from "./store-contacts.js";
import { makeCacheStore } from "./store-cache.js";
import { makeComposeStore } from "./store-compose.js";
import { notificationEligible, profileNotificationsActive } from "./system.js";

// Row shapes as SQLite returns them. JSON columns and 0/1 flags decode here,
// so the mapping functions below only rename fields.

const AccountRow = Schema.Struct({
  id: Schema.String,
  provider: Provider,
  email: Schema.String,
  created_at: Schema.Number,
  last_synced_at: Schema.NullOr(Schema.Number),
  last_sync_error: Schema.NullOr(Schema.String),
  profile_id: Schema.NullOr(Schema.String),
  settings_json: Schema.NullOr(Schema.fromJsonString(ImapSettings)),
  needs_reauth: Schema.BooleanFromBit,
});

const summaryRowFields = {
  id: Schema.String,
  account_id: Schema.String,
  thread_id: Schema.String,
  subject: Schema.String,
  from_name: Schema.String,
  from_addr: Schema.String,
  date: Schema.Number,
  snippet: Schema.String,
  labels_json: Schema.fromJsonString(Schema.Array(Schema.String)),
  attachments_json: Schema.fromJsonString(Schema.Array(Attachment)),
  is_unread: Schema.BooleanFromBit,
  is_starred: Schema.BooleanFromBit,
};
const SummaryRow = Schema.Struct(summaryRowFields);

const MessageRow = Schema.Struct({
  ...summaryRowFields,
  to_json: Schema.fromJsonString(Schema.Array(Address)),
  cc_json: Schema.fromJsonString(Schema.Array(Address)),
  reply_to_json: Schema.NullOr(Schema.fromJsonString(Schema.Array(Address))),
  body_text: Schema.String,
  body_html: Schema.String,
  web_link: Schema.NullOr(Schema.String),
  draft_id: Schema.NullOr(Schema.String),
  calendar_hint: Schema.NullOr(Schema.BooleanFromBit),
  body_cached: Schema.BooleanFromBit,
});

/** Messages with the local draft each one is a copy of, for MessageRow. */
const MESSAGE_COLUMNS = `m.*, (SELECT d.id FROM drafts d
  WHERE d.account_id = m.account_id AND d.remote_message_id = m.provider_id) AS draft_id`;

const ThreadRow = Schema.Struct({
  ...summaryRowFields,
  any_unread: Schema.BooleanFromBit,
  any_starred: Schema.BooleanFromBit,
  thread_count: Schema.Number,
  participants_json: Schema.fromJsonString(Schema.Array(Address)),
});

const LabelRow = Schema.Struct({
  account_id: Schema.String,
  id: Schema.String,
  name: Schema.String,
  color: Schema.NullOr(Schema.String),
});

const PendingOpRow = Schema.Struct({
  id: Schema.Number,
  account_id: Schema.String,
  provider_id: Schema.String,
  op_json: Schema.fromJsonString(QueuedOp),
  attempts: Schema.Number,
  last_error: Schema.NullOr(Schema.String),
});

const AuditRow = Schema.Struct({
  at: Schema.Number,
  actor: Schema.String,
  account_id: Schema.NullOr(Schema.String),
  action: Schema.String,
  detail_json: Schema.fromJsonString(Schema.Unknown),
});

const ProposalRow = Schema.Struct({
  id: Schema.Number,
  created_at: Schema.Number,
  actor_json: Schema.fromJsonString(Actor),
  command_json: Schema.fromJsonString(Command),
  status: Schema.Literals(["pending", "approved", "rejected"]),
});

const Count = Schema.Struct({ key: Schema.String, n: Schema.Number });
const Id = Schema.Struct({ id: Schema.Number });
const MessageId = Schema.Struct({ id: Schema.String });
const Ref = Schema.Struct({ account_id: Schema.String, provider_id: Schema.String });
const ThreadKey = Schema.Struct({ account_id: Schema.String, thread_id: Schema.String });
const Labels = Schema.Struct({ labels_json: SummaryRow.fields.labels_json });
const LabelsAndProvider = Schema.Struct({
  labels_json: SummaryRow.fields.labels_json,
  provider: Provider,
});
const Cursor = Schema.Struct({ sync_cursor: Schema.NullOr(Schema.String) });
const Mode = Schema.Struct({ modify: AgentWriteMode });
const Next = Schema.Struct({ next: Schema.Number });

/** A claim on a queued op older than this belongs to a process that died mid-push. */
const CLAIM_TTL = 2 * 60_000;

/** CLI sync also discovers arrivals; bound storage without requiring a desktop consumer. */
const NOTIFICATION_RETENTION = 7 * 86_400_000;
const MAX_PENDING_NOTIFICATIONS = 1000;
const IMMEDIATE_NOTIFICATION_AGE = 5 * 60_000;

function toAccount(r: typeof AccountRow.Type): Account {
  return {
    id: r.id,
    provider: r.provider,
    email: r.email,
    createdAt: r.created_at,
    lastSyncedAt: r.last_synced_at,
    lastSyncError: r.last_sync_error,
    profileId: r.profile_id,
    needsReauth: r.needs_reauth,
    ...(r.settings_json ? { imap: r.settings_json } : {}),
  };
}

function toSummary(r: typeof SummaryRow.Type): MessageSummary {
  return {
    id: r.id,
    accountId: r.account_id,
    threadId: r.thread_id,
    subject: r.subject,
    from: { name: r.from_name, address: r.from_addr },
    date: r.date,
    snippet: r.snippet,
    labels: r.labels_json,
    isUnread: r.is_unread,
    isStarred: r.is_starred,
    hasAttachments: r.attachments_json.length > 0,
  };
}

function toMessage(r: typeof MessageRow.Type): Message {
  return {
    ...toSummary(r),
    to: r.to_json,
    cc: r.cc_json,
    ...(r.reply_to_json === null ? {} : { replyTo: r.reply_to_json }),
    bodyText: r.body_text,
    bodyHtml: r.body_html,
    ...(r.web_link === null ? {} : { webLink: r.web_link }),
    bodyCached: r.body_cached,
    attachments: r.attachments_json,
    ...(r.calendar_hint === null ? {} : { hasCalendar: r.calendar_hint }),
    ...(r.draft_id === null ? {} : { draftId: r.draft_id }),
  };
}

function toProposal(r: typeof ProposalRow.Type): Proposal {
  return {
    id: r.id,
    createdAt: r.created_at,
    actor: r.actor_json,
    command: r.command_json,
    status: r.status,
  };
}

export function accountId(provider: Provider, email: string): string {
  return `${provider}:${email.toLowerCase()}`;
}

/** Gmail system label behind each mailbox. Outlook and IMAP folders are mapped onto the same names. */
const MAILBOX_LABEL: Record<Exclude<MailboxView, "all">, string> = {
  inbox: "INBOX",
  snoozed: "SNOOZED",
  important: "IMPORTANT",
  starred: "STARRED",
  sent: "SENT",
  drafts: "DRAFT",
  spam: "SPAM",
  trash: "TRASH",
};

const EFFECTIVE_DATE = "m.list_date";
const SUMMARY_COLUMNS = `m.id, m.account_id, m.thread_id, m.subject, m.from_name, m.from_addr,
  ${EFFECTIVE_DATE} AS date,
  m.snippet, m.labels_json, m.attachments_json, m.is_unread, m.is_starred`;

/** Labels that are flags on every provider; the rest name a folder on Outlook and IMAP. */
const literalLike = (value: string) =>
  `%${value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;

export const StoreLive: Layer.Layer<Store, never, SqlClient.SqlClient> = Layer.effect(
  Store,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const cache = makeCacheStore(sql);
    const compose = makeComposeStore(sql);
    const capabilities = yield* Effect.serviceOption(DatabaseCapabilities);
    const vectors = Option.isSome(capabilities) && capabilities.value.vectors;
    const media = makeMediaStore(sql, vectors);
    const semantics = makeSemanticStore(sql, vectors, (q) => {
      const { attachmentText: _scope, ...criteria } = q.criteria ?? {};
      return listFilter({ ...q, search: "", criteria });
    });
    const contacts = makeContactStore(sql);
    const organization = makeOrganizationStore(sql);

    const hasLabel = (label: string) =>
      sql`EXISTS (SELECT 1 FROM json_each(m.labels_json) WHERE value = ${label})`;

    // An empty profile matches nothing rather than everything.
    const inAccounts = (ids: readonly string[]) =>
      ids.length === 0 ? sql.literal("0") : sql`m.account_id IN ${sql.in(ids)}`;

    // Accounts

    const accountRows = all(AccountRow);
    const ACCOUNT_COLUMNS = sql.literal(`id, provider, email, created_at, last_synced_at,
      COALESCE(last_sync_error,(SELECT poll_error FROM incoming_state WHERE account_id=accounts.id)) AS last_sync_error, profile_id, settings_json, needs_reauth`);

    const listAccounts = accountRows(
      sql`SELECT ${ACCOUNT_COLUMNS} FROM accounts ORDER BY created_at`,
    ).pipe(
      Effect.map((rows) => rows.map(toAccount)),
      Effect.withSpan("Store.listAccounts"),
    );

    const getAccount = Effect.fn("Store.getAccount")(function* (
      id: string,
    ): Effect.fn.Return<Account, NotFound> {
      const row = yield* first(AccountRow)(
        sql`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ${id}`,
      );
      if (Option.isNone(row)) return yield* new NotFound({ what: "account", id });
      return toAccount(row.value);
    });

    const upsertAccount = Effect.fn("Store.upsertAccount")(function* (
      provider: Provider,
      email: string,
    ) {
      const id = accountId(provider, email);
      const now = yield* Clock.currentTimeMillis;
      yield* run(sql`INSERT INTO accounts (id, provider, email, created_at)
        VALUES (${id}, ${provider}, ${email}, ${now}) ON CONFLICT(id) DO NOTHING`);
      return yield* Effect.orDie(getAccount(id));
    });

    const removeAccount = Effect.fn("Store.removeAccount")((id: string) =>
      media
        .deleteVectorsForMessages(sql`m.account_id=${id}`)
        .pipe(Effect.andThen(run(sql`DELETE FROM accounts WHERE id=${id}`))),
    );

    const setAccountProfile = Effect.fn("Store.setAccountProfile")(
      (id: string, profileId: string | null) =>
        run(sql`UPDATE accounts SET profile_id = ${profileId} WHERE id = ${id}`),
    );

    const setImapSettings = Effect.fn("Store.setImapSettings")(
      (id: string, settings: ImapSettings) =>
        run(sql`UPDATE accounts SET settings_json = ${JSON.stringify(settings)} WHERE id = ${id}`),
    );

    const setNeedsReauth = Effect.fn("Store.setNeedsReauth")((id: string, value: boolean) =>
      run(sql`UPDATE accounts SET needs_reauth = ${value ? 1 : 0} WHERE id = ${id}`),
    );

    const setSyncError = Effect.fn("Store.setSyncError")((id: string, error: string | null) =>
      run(sql`UPDATE accounts SET last_sync_error = ${error} WHERE id = ${id}`),
    );

    const getSyncCursor = Effect.fn("Store.getSyncCursor")(function* (id: string) {
      const row = yield* first(Cursor)(sql`SELECT sync_cursor FROM accounts WHERE id = ${id}`);
      return Option.flatMap(row, (r) => Option.fromNullishOr(r.sync_cursor));
    });

    const saveSyncCursor = Effect.fn("Store.saveSyncCursor")(function* (
      id: string,
      cursor: string,
      stamp = true,
    ) {
      const now = yield* Clock.currentTimeMillis;
      yield* run(
        sql`UPDATE accounts SET sync_cursor = ${cursor}, last_synced_at = CASE WHEN ${stamp ? 1 : 0} THEN ${now} ELSE last_synced_at END WHERE id = ${id}`,
      );
    });

    const initialSyncState = (id: string, complete: boolean) =>
      run(sql`INSERT INTO incoming_state(account_id,initial_sync_complete) VALUES (${id}, ${complete ? 1 : 0})
        ON CONFLICT(account_id) DO UPDATE SET initial_sync_complete=excluded.initial_sync_complete`);
    const notificationsReady = Effect.fn("Store.notificationsReady")(function* (id: string) {
      const row = yield* first(Schema.Struct({ complete: Schema.BooleanFromBit }))(
        sql`SELECT initial_sync_complete AS complete FROM incoming_state WHERE account_id=${id}`,
      );
      if (Option.isSome(row)) return row.value.complete;
      return (yield* getAccount(id).pipe(Effect.orDie)).lastSyncedAt !== null;
    });
    const getInboxCursor = (id: string) =>
      first(Schema.Struct({ cursor: Schema.NullOr(Schema.String) }))(
        sql`SELECT inbox_cursor AS cursor FROM incoming_state WHERE account_id=${id}`,
      ).pipe(Effect.map((row) => Option.flatMap(row, (r) => Option.fromNullishOr(r.cursor))));
    const saveInboxCursor = (id: string, cursor: string) =>
      run(sql`INSERT INTO incoming_state(account_id,inbox_cursor) VALUES (${id},${cursor})
        ON CONFLICT(account_id) DO UPDATE SET inbox_cursor=excluded.inbox_cursor`);
    const getInboxError = (id: string) =>
      first(Schema.Struct({ error: Schema.NullOr(Schema.String) }))(
        sql`SELECT poll_error AS error FROM incoming_state WHERE account_id=${id}`,
      ).pipe(
        Effect.map((row) => Option.match(row, { onNone: () => null, onSome: (r) => r.error })),
      );
    const setInboxError = (id: string, error: string | null) =>
      run(sql`INSERT INTO incoming_state(account_id,poll_error) VALUES (${id},${error})
        ON CONFLICT(account_id) DO UPDATE SET poll_error=excluded.poll_error`);
    const observeIncoming = (id: string, identity: string) =>
      first(Schema.Struct({ present: Schema.Number }))(
        sql`INSERT INTO seen_incoming(account_id,identity) VALUES (${id},${identity})
        ON CONFLICT(account_id,identity) DO NOTHING RETURNING 1 AS present`,
      ).pipe(Effect.map(Option.isSome));
    const hasMessage = (id: string) =>
      first(Schema.Struct({ present: Schema.Number }))(
        sql`SELECT 1 AS present FROM messages WHERE id=${id}`,
      ).pipe(Effect.map(Option.isSome));

    // Messages

    const Reminder = Schema.Struct({
      due_at: Schema.NullOr(Schema.Number),
      woken_at: Schema.NullOr(Schema.Number),
      wake_pending: Schema.BooleanFromBit,
    });
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
      let m = incoming;
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
      yield* media.deleteVectorsForMessages(sql`m.id=${`${account}/${m.providerId}`} AND
        (m.body_text!=${m.bodyText} OR m.body_html!=${m.bodyHtml} OR m.attachments_json!=${JSON.stringify(m.attachments)})`);
      yield* (
        // ON CONFLICT DO UPDATE keeps the rowid stable, which the external-content
        // FTS table is keyed on. INSERT OR REPLACE would orphan index rows.
        run(sql`INSERT INTO messages (id, account_id, provider_id, thread_id, subject, from_name,
            from_addr, to_json, cc_json, reply_to_json, date, snippet, body_text, body_html, labels_json,
            attachments_json, is_unread, is_starred, calendar_hint, body_cached, list_date, web_link)
          VALUES (${`${account}/${m.providerId}`}, ${account}, ${m.providerId}, ${m.threadId},
            ${m.subject}, ${m.from.name}, ${m.from.address}, ${JSON.stringify(m.to)},
            ${JSON.stringify(m.cc)}, ${JSON.stringify(m.replyTo ?? [])}, ${m.date}, ${m.snippet}, ${m.bodyText}, ${m.bodyHtml},
            ${JSON.stringify(m.labels)}, ${JSON.stringify(m.attachments)}, ${m.isUnread ? 1 : 0},
            ${m.isStarred ? 1 : 0}, ${m.hasCalendar || m.bodyText.trimStart().startsWith("BEGIN:VCALENDAR") || m.attachments.some((a) => a.mimeType === "text/calendar" || /\.ics$/i.test(a.filename)) ? 1 : 0}, ${m.bodyCached === false ? 0 : 1}, ${Math.max(m.date, Option.isSome(reminder) ? (reminder.value.woken_at ?? 0) : 0)}, ${m.webLink ?? null})
          ON CONFLICT(id) DO UPDATE SET
            thread_id = excluded.thread_id, subject = excluded.subject,
            from_name = excluded.from_name, from_addr = excluded.from_addr,
            to_json = excluded.to_json, cc_json = excluded.cc_json, reply_to_json = excluded.reply_to_json, date = excluded.date,
            snippet = excluded.snippet, body_text = excluded.body_text,
            body_html = excluded.body_html, labels_json = excluded.labels_json,
            attachments_json = excluded.attachments_json, is_unread = excluded.is_unread,
            is_starred = excluded.is_starred, calendar_hint = excluded.calendar_hint, body_cached = excluded.body_cached, list_date = excluded.list_date,
            web_link = COALESCE(excluded.web_link, messages.web_link)`)
      );
      if (m.labels.includes("SENT"))
        yield* contacts.rememberMailedAddresses(
          account,
          [...m.to, ...m.cc].map((recipient) => recipient.address),
        );
    });

    const deleteMessage = Effect.fn("Store.deleteMessage")((account: string, providerId: string) =>
      media
        .deleteVectorsForMessages(sql`m.id=${`${account}/${providerId}`}`)
        .pipe(
          Effect.andThen(run(sql`DELETE FROM messages WHERE id=${`${account}/${providerId}`}`)),
        ),
    );
    const deleteMessagesWithLabel = Effect.fn("Store.deleteMessagesWithLabel")(
      (account: string, label: string) =>
        media
          .deleteVectorsForMessages(sql`m.account_id=${account} AND ${hasLabel(label)}`)
          .pipe(
            Effect.andThen(
              run(
                sql`DELETE FROM messages AS m WHERE m.account_id=${account} AND ${hasLabel(label)}`,
              ),
            ),
          ),
    );
    const deleteAccountMessages = Effect.fn("Store.deleteAccountMessages")((account: string) =>
      media
        .deleteVectorsForMessages(sql`m.account_id=${account}`)
        .pipe(Effect.andThen(run(sql`DELETE FROM messages WHERE account_id=${account}`))),
    );

    /** WHERE clauses of a thread list. Paging (`before`) is applied after collapsing threads. */
    const listFilter = (q: ThreadQuery) => {
      const where: Fragment[] = [];
      const mailbox =
        q.search !== undefined && q.searchScope !== "folder" ? "all" : (q.mailbox ?? "inbox");
      if (mailbox === "all") {
        if (q.messageIds === undefined)
          where.push(sql`NOT ${hasLabel("SPAM")}`, sql`NOT ${hasLabel("TRASH")}`);
      } else where.push(hasLabel(MAILBOX_LABEL[mailbox]));
      if (mailbox === "inbox")
        where.push(
          sql`NOT EXISTS (SELECT 1 FROM thread_reminders r WHERE r.account_id=m.account_id AND r.thread_id=m.thread_id AND r.due_at IS NOT NULL)`,
        );
      if (q.label !== undefined && (q.search === undefined || q.searchScope === "folder"))
        where.push(hasLabel(q.label));
      if (q.accountIds) where.push(inAccounts(q.accountIds));
      if (q.messageIds)
        where.push(sql`m.id IN (SELECT value FROM json_each(${JSON.stringify(q.messageIds)}))`);
      if (q.unreadOnly) where.push(sql`m.is_unread = 1`);
      if (q.starredOnly) where.push(sql`m.is_starred = 1`);
      const c = q.criteria;
      if (c?.from)
        where.push(
          sql`(m.from_addr LIKE ${literalLike(c.from)} ESCAPE '\\' OR m.from_name LIKE ${literalLike(c.from)} ESCAPE '\\')`,
        );
      if (c?.to)
        where.push(
          sql`EXISTS (SELECT 1 FROM json_each(m.to_json) WHERE json_extract(value, '$.address') LIKE ${literalLike(c.to)} ESCAPE '\\' OR json_extract(value, '$.name') LIKE ${literalLike(c.to)} ESCAPE '\\')`,
        );
      if (c?.subject) where.push(sql`m.subject LIKE ${literalLike(c.subject)} ESCAPE '\\'`);
      if (c?.important) where.push(hasLabel("IMPORTANT"));
      if (c?.attachmentText)
        where.push(sql`EXISTS(SELECT 1 FROM derived_chunks d WHERE d.message_id=m.id)`);
      if (c?.image)
        where.push(sql`(EXISTS(SELECT 1 FROM json_each(m.attachments_json)
        WHERE lower(json_extract(value,'$.mimeType')) LIKE 'image/%') OR m.body_html LIKE '%cid:%')`);
      if (c?.attachment) where.push(sql`json_array_length(m.attachments_json)>0`);
      if (c?.filename)
        where.push(
          sql`EXISTS (SELECT 1 FROM json_each(m.attachments_json) WHERE json_extract(value, '$.filename') LIKE ${literalLike(c.filename)} ESCAPE '\\')`,
        );
      if (c?.dateBefore !== undefined) where.push(sql`m.date < ${c.dateBefore}`);
      if (c?.dateAfter !== undefined) where.push(sql`m.date >= ${c.dateAfter}`);
      for (const label of c?.labels ?? [])
        where.push(
          sql`EXISTS (SELECT 1 FROM json_each(m.labels_json) j WHERE j.value=${label} OR j.value IN (SELECT id FROM labels WHERE account_id=m.account_id AND name=${label}))`,
        );
      const terms = searchWords(q.search ?? "").map((word) => word.replace(/^"(.*)"$/, "$1"));
      const fts = terms.filter((t) => Array.from(t).length >= 3);
      if (fts.length) {
        const match = fts.map((t) => `"${t.replaceAll('"', '""')}"`).join(" AND ");
        where.push(
          sql`m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ${match})`,
        );
      }
      for (const term of terms.filter((t) => Array.from(t).length < 3)) {
        const like = literalLike(term);
        where.push(
          sql`(m.subject LIKE ${like} ESCAPE '\\' OR m.from_name LIKE ${like} ESCAPE '\\' OR m.from_addr LIKE ${like} ESCAPE '\\' OR m.body_text LIKE ${like} ESCAPE '\\')`,
        );
      }
      return sql.and(where);
    };

    const countThreads = (raw: ThreadQuery) => {
      const query = raw.search === undefined ? raw : parseSearchQuery(raw);
      return all(Schema.Struct({ n: Schema.Number }))(
        query.flat
          ? sql`SELECT COUNT(*) AS n FROM messages m WHERE ${listFilter(query)}`
          : sql`SELECT COUNT(*) AS n FROM (SELECT m.account_id,m.thread_id FROM messages m WHERE ${listFilter(query)} GROUP BY m.account_id,m.thread_id)`,
      ).pipe(Effect.map((rows) => rows[0]?.n ?? 0));
    };

    // Stream the date/id index and resolve only selected conversations. The
    // CTE is inlined, so a 100k-thread inbox does not rank 100k rows per page.
    const threadList = Effect.fn("Store.threadList")(function* (q: ThreadQuery, limit: number) {
      const rows = yield* all(ThreadRow)(sql`
        WITH candidates AS NOT MATERIALIZED (SELECT ${sql.literal(SUMMARY_COLUMNS)} FROM messages m WHERE ${listFilter(q)}),
        page AS (
          SELECT c.* FROM candidates c
          WHERE ${q.before === undefined ? sql.literal("1") : sql`(c.date < ${q.before} ${q.beforeId === undefined ? sql.literal("") : sql`OR (c.date = ${q.before} AND c.id < ${q.beforeId})`})`}
            AND NOT EXISTS (SELECT 1 FROM candidates n WHERE n.account_id=c.account_id AND n.thread_id=c.thread_id
              AND (n.date > c.date OR (n.date=c.date AND n.id>c.id)))
          ORDER BY c.date DESC,c.id DESC LIMIT ${limit}
        )
        SELECT c.*,
          (SELECT MAX(v.is_unread) FROM candidates v WHERE v.account_id=c.account_id AND v.thread_id=c.thread_id) AS any_unread,
          (SELECT MAX(v.is_starred) FROM candidates v WHERE v.account_id=c.account_id AND v.thread_id=c.thread_id) AS any_starred,
          (SELECT COUNT(*) FROM messages t WHERE t.account_id=c.account_id AND t.thread_id=c.thread_id) AS thread_count,
          (SELECT json_group_array(json_object('name',p.from_name,'address',p.from_addr))
            FROM (SELECT from_name,from_addr,MIN(date) AS first FROM messages t
              WHERE t.account_id=c.account_id AND t.thread_id=c.thread_id GROUP BY from_addr ORDER BY first) p) AS participants_json
        FROM page c ORDER BY c.date DESC,c.id DESC`);
      return rows.map((r): ThreadSummary => ({
        ...toSummary(r),
        isUnread: r.any_unread,
        isStarred: r.any_starred,
        threadCount: r.thread_count,
        participants: r.participants_json,
      }));
    });

    /** Conversation grouping off: each message in the view is its own row, newest first. */
    const messageList = (q: ThreadQuery, limit: number) =>
      all(SummaryRow)(sql`SELECT ${sql.literal(SUMMARY_COLUMNS)} FROM messages m
        WHERE ${listFilter(q)} ${q.before === undefined ? sql.literal("") : sql`AND (${sql.literal(EFFECTIVE_DATE)} < ${q.before} ${q.beforeId === undefined ? sql.literal("") : sql`OR (${sql.literal(EFFECTIVE_DATE)} = ${q.before} AND m.id < ${q.beforeId})`})`}
        ORDER BY date DESC, m.id DESC LIMIT ${limit}`).pipe(
        Effect.map((rows) =>
          rows.map((r): ThreadSummary => {
            const summary = toSummary(r);
            return { ...summary, threadCount: 1, participants: [summary.from] };
          }),
        ),
      );

    const listThreads = Effect.fn("Store.listThreads")(function* (raw: ThreadQuery) {
      if (raw.search !== undefined && !raw.search.trim()) return [];
      const q = raw.search === undefined ? raw : parseSearchQuery(raw);
      const limit = q.limit ?? 50;
      const listing = q.flat ? messageList : threadList;
      const terms = searchWords(q.search ?? "").map((word) => word.replace(/^"(.*)"$/, "$1"));
      let threads = q.criteria?.attachmentText && terms.length ? [] : yield* listing(q, limit);
      if (terms.length) {
        const predicates: Fragment[] = [];
        const long = terms.filter((term) => Array.from(term).length >= 3);
        if (long.length)
          predicates.push(
            sql`d.id IN (SELECT rowid FROM derived_fts WHERE derived_fts MATCH ${long.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ")})`,
          );
        for (const term of terms.filter((word) => Array.from(word).length < 3))
          predicates.push(sql`d.text LIKE ${literalLike(term)} ESCAPE '\\'`);
        const { attachmentText: _scope, ...criteria } = q.criteria ?? {};
        const matches = yield* all(
          Schema.Struct({
            account_id: Schema.String,
            thread_id: Schema.String,
            provenance_json: Schema.fromJsonString(DerivedChunk),
          }),
        )(
          sql`SELECT m.account_id,m.thread_id,d.provenance_json FROM derived_chunks d JOIN messages m ON m.id=d.message_id
          WHERE ${listFilter({ ...q, search: "", criteria })} AND ${sql.and(predicates)}
          ${q.before === undefined ? sql.literal("") : sql`AND m.date < ${q.before}`}
          ORDER BY ${long.length ? sql`(SELECT rank FROM derived_fts WHERE rowid=d.id AND derived_fts MATCH ${long.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ")})` : sql.literal("m.date DESC")},d.id LIMIT ${Math.min(Math.max(limit * 20, 200), 4096)}`,
        );
        const chunks = matches.map((row) => row.provenance_json);
        const ids = [...new Set(chunks.map((chunk) => chunk.messageId))].slice(0, 1024);
        const candidates = ids.length
          ? yield* listing({ ...q, search: "", criteria, messageIds: ids }, ids.length)
          : [];
        const grouped = new Map<string, DerivedChunk[]>();
        const ranks = new Map<string, number>();
        for (const [rank, match] of matches.entries()) {
          const key = q.flat
            ? match.provenance_json.messageId
            : `${match.account_id}/${match.thread_id}`;
          const group = grouped.get(key) ?? [];
          if (group.length < 20) group.push(match.provenance_json);
          grouped.set(key, group);
          if (!ranks.has(key)) ranks.set(key, rank);
        }
        const keyOf = (thread: ThreadSummary) =>
          q.flat ? thread.id : `${thread.accountId}/${thread.threadId}`;
        const derived = candidates
          .map((thread) => ({ ...thread, derivedMatches: grouped.get(keyOf(thread)) ?? [] }))
          .toSorted(
            (a, b) => (ranks.get(keyOf(a)) ?? Infinity) - (ranks.get(keyOf(b)) ?? Infinity),
          );
        threads = reciprocalRankFusion(threads, derived, q.flat).slice(0, limit);
      }
      // The Drafts list also shows drafts the provider has no copy of yet.
      const plain = q.label === undefined && !q.unreadOnly && !q.starredOnly;
      if (q.mailbox !== "drafts" || !plain) return threads;
      const local = yield* compose.localDrafts(q, limit);
      return [...threads, ...local]
        .toSorted((a, b) => b.date - a.date || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
        .slice(0, limit);
    });

    const vectorThreads = Effect.fn("Store.vectorThreads")(function* (
      raw: ThreadQuery,
      hits: readonly DerivedChunk[],
    ) {
      const parsed = parseSearchQuery(raw);
      const { attachmentText: _scope, ...criteria } = parsed.criteria ?? {};
      const q = { ...parsed, criteria };
      const sourceHits = hits.filter(
        (hit) => !parsed.criteria?.attachmentText || hit.source.kind !== "body",
      );
      const ids = [...new Set(sourceHits.map((hit) => hit.messageId))].slice(0, 200);
      if (!ids.length) return [];
      const candidates = yield* (q.flat ? messageList : threadList)(
        { ...q, search: "", messageIds: ids },
        ids.length,
      );
      const keys = yield* all(
        Schema.Struct({ id: Schema.String, account_id: Schema.String, thread_id: Schema.String }),
      )(
        sql`SELECT id,account_id,thread_id FROM messages WHERE id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`,
      );
      const matched = new Map<string, DerivedChunk[]>();
      const ranks = new Map<string, number>();
      for (const [rank, hit] of sourceHits.entries()) {
        const message = keys.find((key) => key.id === hit.messageId);
        if (!message) continue;
        const key = q.flat ? hit.messageId : `${message.account_id}/${message.thread_id}`;
        const group = matched.get(key) ?? [];
        if (group.length < 20) group.push(hit);
        matched.set(key, group);
        if (!ranks.has(key)) ranks.set(key, rank);
      }
      const keyOf = (thread: ThreadSummary) =>
        q.flat ? thread.id : `${thread.accountId}/${thread.threadId}`;
      return candidates
        .map((thread) => ({ ...thread, derivedMatches: matched.get(keyOf(thread)) ?? [] }))
        .toSorted((a, b) => (ranks.get(keyOf(a)) ?? Infinity) - (ranks.get(keyOf(b)) ?? Infinity));
    });

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
      const rows = yield* all(MessageId)(sql`SELECT t.id FROM messages t
        JOIN messages m ON t.account_id = m.account_id AND t.thread_id = m.thread_id
        WHERE m.id = ${id} ORDER BY t.date`);
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
        WHERE id = ${`${account}/${providerId}`}`);
    });

    /**
     * Applies an op to the local copy so the UI updates before the provider
     * answers. The next sync overwrites it with the provider's state either way.
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
        ["inbox", "archive", "trash", "spam"].includes(op.kind) ||
        (op.kind === "label" && op.value && row.value.provider !== "gmail")
      )
        yield* run(
          sql`UPDATE thread_reminders SET due_at=NULL, wake_pending=CASE WHEN ${op.kind} = 'inbox' THEN wake_pending ELSE 0 END WHERE (account_id, thread_id) IN (SELECT account_id, thread_id FROM messages WHERE id=${id})`,
        );
      if (
        ["archive", "trash", "spam"].includes(op.kind) ||
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

    const counts = (rows: ReadonlyArray<typeof Count.Type>): Record<string, number> =>
      Object.fromEntries(rows.map((r) => [r.key, r.n]));

    /** Unread inbox messages per account, for the sidebar badges. */
    const unreadCounts = all(Count)(sql`SELECT account_id AS key, COUNT(*) AS n FROM messages m
      WHERE is_unread = 1 AND ${hasLabel("INBOX")} AND NOT EXISTS (SELECT 1 FROM thread_reminders r WHERE r.account_id=m.account_id AND r.thread_id=m.thread_id AND r.due_at IS NOT NULL) GROUP BY account_id`).pipe(
      Effect.map(counts),
      Effect.withSpan("Store.unreadCounts"),
    );

    /**
     * Unread messages per label id, across the given accounts (all when omitted).
     * Keys are system labels (INBOX, SPAM, CATEGORY_*) and user label ids alike.
     * `within` counts only messages that also carry that label, e.g. INBOX for
     * category badges.
     */
    const unreadByLabel = Effect.fn("Store.unreadByLabel")(function* (
      accountIds?: readonly string[],
      within?: string,
    ) {
      const where: Fragment[] = [sql`m.is_unread = 1`];
      if (accountIds) where.push(inAccounts(accountIds));
      if (within !== undefined) where.push(hasLabel(within));
      const rows = yield* all(Count)(sql`SELECT l.value AS key, COUNT(*) AS n
        FROM messages m, json_each(m.labels_json) l
        WHERE ${sql.and(where)} GROUP BY l.value`);
      return counts(rows);
    });

    // Labels

    /** Replaces an account's label list with what the provider reports now. */
    const replaceLabels = Effect.fn("Store.replaceLabels")(
      (account: string, labels: readonly Omit<Label, "accountId">[]) =>
        Effect.orDie(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`DELETE FROM labels WHERE account_id = ${account}`;
              for (const l of labels) {
                yield* sql`INSERT INTO labels (account_id, id, name, color)
                  VALUES (${account}, ${l.id}, ${l.name}, ${l.color})`;
              }
            }),
          ),
        ),
    );

    const listLabels = Effect.fn("Store.listLabels")(function* (accountIds?: readonly string[]) {
      const rows = yield* all(LabelRow)(sql`SELECT account_id, id, name, color FROM labels m
        WHERE ${accountIds ? inAccounts(accountIds) : sql.literal("1")}
        ORDER BY account_id, name`);
      return rows.map((r) => ({ accountId: r.account_id, id: r.id, name: r.name, color: r.color }));
    });

    // Profiles

    const listProfiles = all(Profile)(
      sql`SELECT id, name, icon, color, position FROM profiles ORDER BY position, name`,
    ).pipe(
      Effect.map((rows) => [...rows]),
      Effect.withSpan("Store.listProfiles"),
    );

    const createProfile = Effect.fn("Store.createProfile")(function* (input: ProfileInput) {
      const id = crypto.randomUUID();
      const next = yield* first(Next)(
        sql`SELECT COALESCE(MAX(position), -1) + 1 AS next FROM profiles`,
      );
      const position = Option.match(next, { onNone: () => 0, onSome: (r) => r.next });
      yield* run(sql`INSERT INTO profiles (id, name, icon, color, position)
        VALUES (${id}, ${input.name}, ${input.icon}, ${input.color}, ${position})`);
      return { id, name: input.name, icon: input.icon, color: input.color, position };
    });

    const updateProfile = Effect.fn("Store.updateProfile")((id: string, input: ProfileInput) =>
      run(sql`UPDATE profiles SET name = ${input.name}, icon = ${input.icon},
        color = ${input.color} WHERE id = ${id}`),
    );

    /** Deletes the profile. Its accounts stay and become ungrouped (ON DELETE SET NULL). */
    const deleteProfile = Effect.fn("Store.deleteProfile")((id: string) =>
      run(sql`DELETE FROM profiles WHERE id = ${id}`),
    );

    // Outgoing change queue

    const enqueueOp = Effect.fn("Store.enqueueOp")(function* (
      account: string,
      providerId: string,
      op: QueuedOp,
    ) {
      const now = yield* Clock.currentTimeMillis;
      yield* run(sql`INSERT INTO pending_ops (account_id, provider_id, op_json, created_at)
        VALUES (${account}, ${providerId}, ${JSON.stringify(op)}, ${now})`);
    });

    const listPendingOps = all(PendingOpRow)(
      sql`SELECT id, account_id, provider_id, op_json, attempts, last_error
        FROM pending_ops ORDER BY id`,
    ).pipe(
      Effect.map((rows) =>
        rows.map((r): PendingOp => ({
          id: r.id,
          accountId: r.account_id,
          providerId: r.provider_id,
          op: r.op_json,
          attempts: r.attempts,
          lastError: r.last_error,
        })),
      ),
      Effect.withSpan("Store.listPendingOps"),
    );

    const claimPendingOp = Effect.fn("Store.claimPendingOp")(function* (id: number) {
      const now = yield* Clock.currentTimeMillis;
      const row = yield* first(Id)(sql`UPDATE pending_ops SET claimed_at = ${now}
        WHERE id = ${id} AND (claimed_at IS NULL OR claimed_at < ${now - CLAIM_TTL})
        RETURNING id`);
      return Option.isSome(row);
    });

    const removePendingOp = Effect.fn("Store.removePendingOp")((id: number) =>
      run(sql`DELETE FROM pending_ops WHERE id = ${id}`),
    );

    const releasePendingOp = Effect.fn("Store.releasePendingOp")((id: number) =>
      run(sql`UPDATE pending_ops SET claimed_at = NULL WHERE id = ${id}`),
    );

    const failPendingOp = Effect.fn("Store.failPendingOp")((id: number, error: string) =>
      run(sql`UPDATE pending_ops SET attempts = attempts + 1, last_error = ${error},
        claimed_at = NULL WHERE id = ${id}`),
    );

    // Audit, agent policy, proposals

    const audit = Effect.fn("Store.audit")(function* (entry: {
      actor: Actor;
      accountId?: string;
      action: string;
      detail: unknown;
    }) {
      const now = yield* Clock.currentTimeMillis;
      yield* run(sql`INSERT INTO audit_log (at, actor, account_id, action, detail_json)
        VALUES (${now}, ${actorLabel(entry.actor)}, ${entry.accountId ?? null}, ${entry.action},
          ${JSON.stringify(entry.detail ?? null)})`);
    });

    const listAudit = Effect.fn("Store.listAudit")(function* (limit: number) {
      const rows = yield* all(AuditRow)(sql`SELECT at, actor, account_id, action, detail_json
        FROM audit_log ORDER BY id DESC LIMIT ${limit}`);
      return rows.map((r) => ({
        at: r.at,
        actor: r.actor,
        accountId: r.account_id,
        action: r.action,
        detail: r.detail_json,
      }));
    });

    /** The agent's own row, else the '*' default, else off. */
    const agentWriteMode = Effect.fn("Store.agentWriteMode")(function* (name: string) {
      const row = yield* first(Mode)(sql`SELECT modify FROM agent_policies
        WHERE name IN (${name}, '*') ORDER BY name = '*' LIMIT 1`);
      return Option.match(row, { onNone: (): AgentWriteMode => "off", onSome: (r) => r.modify });
    });

    const setAgentWriteMode = Effect.fn("Store.setAgentWriteMode")(
      (name: string, mode: AgentWriteMode) =>
        run(sql`INSERT INTO agent_policies (name, modify) VALUES (${name}, ${mode})
          ON CONFLICT(name) DO UPDATE SET modify = excluded.modify`),
    );

    const insertProposal = Effect.fn("Store.insertProposal")(function* (
      actor: Actor,
      command: Command,
    ) {
      const now = yield* Clock.currentTimeMillis;
      const row = yield* first(Id)(sql`INSERT INTO proposals (created_at, actor_json, command_json)
        VALUES (${now}, ${JSON.stringify(actor)}, ${JSON.stringify(command)}) RETURNING id`);
      if (Option.isNone(row)) return yield* Effect.die("INSERT ... RETURNING returned no row");
      return row.value.id;
    });

    const PROPOSAL_COLUMNS = sql.literal("id, created_at, actor_json, command_json, status");

    const listProposals = Effect.fn("Store.listProposals")(function* (status: Proposal["status"]) {
      const rows = yield* all(ProposalRow)(sql`SELECT ${PROPOSAL_COLUMNS} FROM proposals
        WHERE status = ${status} ORDER BY created_at, id`);
      return rows.map(toProposal);
    });

    const getProposal = Effect.fn("Store.getProposal")(function* (
      id: number,
    ): Effect.fn.Return<Proposal, NotFound> {
      const row = yield* first(ProposalRow)(
        sql`SELECT ${PROPOSAL_COLUMNS} FROM proposals WHERE id = ${id}`,
      );
      if (Option.isNone(row)) return yield* new NotFound({ what: "proposal", id: String(id) });
      return toProposal(row.value);
    });

    /** Decides a pending proposal. A decided one keeps its first decision. */
    const setProposalStatus = Effect.fn("Store.setProposalStatus")(function* (
      id: number,
      status: "approved" | "rejected",
    ) {
      const now = yield* Clock.currentTimeMillis;
      yield* run(sql`UPDATE proposals SET status = ${status}, decided_at = ${now}
        WHERE id = ${id} AND status = 'pending'`);
    });

    const snooze = Effect.fn("Store.snooze")(function* (id: string, due: number) {
      const message = yield* getMessage(id);
      const previous = yield* all(Schema.Struct({ provider_id: Schema.String }))(
        sql`SELECT provider_id FROM snoozed_messages WHERE account_id=${message.accountId} AND thread_id=${message.threadId}`,
      );
      const targets = (yield* getThread(id)).filter(
        (member) =>
          !member.labels.some((l) => ["DRAFT", "TRASH", "SPAM"].includes(l)) &&
          (member.labels.includes("INBOX") ||
            (member.labels.includes("SNOOZED") &&
              previous.some((p) => member.id === `${message.accountId}/${p.provider_id}`))),
      );
      if (!targets.length)
        yield* new InvalidInput({ message: "Only inbox messages can be snoozed" });
      yield* run(sql`INSERT INTO thread_reminders (account_id, thread_id, due_at, woken_at)
        VALUES (${message.accountId}, ${message.threadId}, ${due}, NULL)
        ON CONFLICT(account_id, thread_id) DO UPDATE SET due_at=excluded.due_at, woken_at=NULL, wake_pending=0`);
      yield* run(
        sql`DELETE FROM snoozed_messages WHERE account_id=${message.accountId} AND thread_id=${message.threadId}`,
      );
      const owner = yield* getAccount(message.accountId);
      for (const member of targets) {
        const { providerId } = yield* messageRef(member.id);
        yield* run(
          sql`INSERT INTO snoozed_messages (account_id, thread_id, provider_id) VALUES (${message.accountId}, ${message.threadId}, ${providerId})`,
        );
        const labels = [
          ...applyOpToLabels(
            member.labels.filter((l) => l !== "SNOOZED"),
            { kind: "archive" },
            owner.provider,
          ),
          "SNOOZED",
        ];
        yield* run(
          sql`UPDATE messages SET labels_json=${JSON.stringify(labels)} WHERE id=${member.id}`,
        );
      }
    });

    const reminderSnapshot: Store["Service"]["reminderSnapshot"] = (id) =>
      Effect.gen(function* () {
        const message = yield* getMessage(id);
        const reminder = yield* first(
          Schema.Struct({
            due_at: Schema.NullOr(Schema.Number),
            woken_at: Schema.NullOr(Schema.Number),
            wake_pending: Schema.BooleanFromBit,
          }),
        )(
          sql`SELECT due_at,woken_at,wake_pending FROM thread_reminders WHERE account_id=${message.accountId} AND thread_id=${message.threadId}`,
        );
        if (Option.isNone(reminder)) return Option.none();
        const members = yield* all(
          Schema.Struct({ provider_id: Schema.String, wake_pending: Schema.BooleanFromBit }),
        )(
          sql`SELECT provider_id,wake_pending FROM snoozed_messages WHERE account_id=${message.accountId} AND thread_id=${message.threadId}`,
        );
        return Option.some({
          accountId: message.accountId,
          threadId: message.threadId,
          dueAt: reminder.value.due_at,
          wokenAt: reminder.value.woken_at,
          wakePending: reminder.value.wake_pending,
          members: members.map((member) => ({
            providerId: member.provider_id,
            wakePending: member.wake_pending,
          })),
        });
      });
    const restoreReminder: Store["Service"]["restoreReminder"] = (snapshot) =>
      Effect.gen(function* () {
        yield* run(sql`INSERT INTO thread_reminders (account_id,thread_id,due_at,woken_at,wake_pending)
        VALUES (${snapshot.accountId},${snapshot.threadId},${snapshot.dueAt},${snapshot.wokenAt},${snapshot.wakePending ? 1 : 0})
        ON CONFLICT(account_id,thread_id) DO UPDATE SET due_at=excluded.due_at,woken_at=excluded.woken_at,wake_pending=excluded.wake_pending`);
        yield* run(
          sql`DELETE FROM snoozed_messages WHERE account_id=${snapshot.accountId} AND thread_id=${snapshot.threadId}`,
        );
        for (const member of snapshot.members) {
          yield* run(sql`INSERT INTO snoozed_messages (account_id,thread_id,provider_id,wake_pending)
          VALUES (${snapshot.accountId},${snapshot.threadId},${member.providerId},${member.wakePending ? 1 : 0})`);
          if (snapshot.dueAt !== null)
            yield* run(sql`UPDATE messages AS m SET labels_json=json_insert(labels_json,'$[#]','SNOOZED')
          WHERE account_id=${snapshot.accountId} AND provider_id=${member.providerId} AND NOT ${hasLabel("SNOOZED")}`);
        }
      });

    const pruneNotifications = (now: number) =>
      Effect.gen(function* () {
        yield* run(
          sql`DELETE FROM pending_notifications WHERE enqueued_at < ${now - NOTIFICATION_RETENTION}`,
        );
        yield* run(sql`DELETE FROM pending_notifications WHERE message_id IN (
        SELECT message_id FROM pending_notifications ORDER BY enqueued_at DESC,rowid DESC
        LIMIT -1 OFFSET ${MAX_PENDING_NOTIFICATIONS})`);
      });
    const enqueueNotification = (id: string, digest: boolean) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            yield* run(sql`INSERT INTO pending_notifications (message_id,digest,enqueued_at)
          VALUES (${id},${digest ? 1 : 0},${now}) ON CONFLICT(message_id) DO NOTHING`);
            yield* pruneNotifications(now);
          }),
        )
        .pipe(Effect.catchIf(isSqlError, (error) => Effect.die(error)));
    const takeNotifications = (now: number) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* pruneNotifications(now);
            const pending = yield* all(
              Schema.Struct({
                ...summaryRowFields,
                digest: Schema.BooleanFromBit,
                enqueued_at: Schema.Number,
              }),
            )(sql`SELECT ${sql.literal(SUMMARY_COLUMNS)},n.digest,n.enqueued_at FROM pending_notifications n
              JOIN messages m ON m.id=n.message_id ORDER BY n.rowid`);
            const accounts = yield* listAccounts;
            const prefs = yield* compose.prefs;
            const batches = new Map<
              string,
              {
                kind: NotificationBatch["kind"];
                profileId: string | null;
                messages: MessageSummary[];
              }
            >();
            for (const entry of pending) {
              const message = toSummary(entry);
              const account = accounts.find((a) => a.id === message.accountId);
              if (account && notificationEligible(account, message, prefs)) {
                if (!profileNotificationsActive(account, prefs, new Date(now))) {
                  if (!entry.digest)
                    yield* run(
                      sql`UPDATE pending_notifications SET digest=1 WHERE message_id=${message.id} AND digest=0`,
                    );
                  continue;
                }
                const digest =
                  entry.digest || now - entry.enqueued_at >= IMMEDIATE_NOTIFICATION_AGE;
                const kind = digest ? "digest" : "immediate";
                // A digest spans the Profile, including its multiple accounts.
                const key = JSON.stringify([kind, digest ? account.profileId : account.id]);
                const batch = batches.get(key) ?? {
                  kind,
                  profileId: account.profileId,
                  messages: [],
                };
                batch.messages.push(message);
                batches.set(key, batch);
              }
              // Read, archived, disabled or delivered arrivals must never notify later.
              yield* run(sql`DELETE FROM pending_notifications WHERE message_id=${message.id}`);
            }
            return [...batches.values()];
          }),
        )
        .pipe(Effect.catchIf(isSqlError, (error) => Effect.die(error)));

    return Store.of({
      ...cache,
      ...organization,
      snooze,
      reminderSnapshot,
      restoreReminder,
      transaction: (effect) =>
        sql.withTransaction(effect).pipe(Effect.catchIf(isSqlError, (e) => Effect.die(e))),
      listAccounts,
      getAccount,
      upsertAccount,
      removeAccount,
      setAccountProfile,
      setImapSettings,
      setNeedsReauth,
      setSyncError,
      getSyncCursor,
      beginInitialSync: (id) => initialSyncState(id, false),
      finishInitialSync: (id) => initialSyncState(id, true),
      notificationsReady,
      getInboxCursor,
      getInboxError,
      setInboxError,
      hasMessage,
      saveInboxCursor,
      observeIncoming,
      enqueueNotification,
      takeNotifications,
      saveSyncCursor,
      media,
      semantics,
      upsertMessage,
      setFlags,
      deleteMessage,
      deleteMessagesWithLabel,
      deleteAccountMessages,
      listThreads,
      countThreads,
      vectorThreads,
      getMessage,
      getThread,
      messageRef,
      threadMessageIds,
      messageLabels,
      applyLocalOp,
      unreadCounts,
      unreadByLabel,
      replaceLabels,
      listLabels,
      listProfiles,
      createProfile,
      updateProfile,
      deleteProfile,
      enqueueOp,
      listPendingOps,
      claimPendingOp,
      releasePendingOp,
      removePendingOp,
      failPendingOp,
      imageSenders: compose.imageSenders,
      setImageSender: compose.setImageSender,
      getDraft: compose.getDraft,
      draftByRemoteMessage: compose.draftByRemoteMessage,
      draftByProposal: compose.draftByProposal,
      putDraft: compose.putDraft,
      setDraftRemote: compose.setDraftRemote,
      deleteDraft: compose.deleteDraft,
      enqueueDraftSave: compose.enqueueDraftSave,
      dropSyncedDrafts: compose.dropSyncedDrafts,
      prefs: compose.prefs,
      setPrefs: compose.setPrefs,
      signatures: compose.signatures,
      setSignature: compose.setSignature,
      templates: compose.templates,
      saveTemplate: compose.saveTemplate,
      deleteTemplate: compose.deleteTemplate,
      ...contacts,
      setMessageWebLink: (id, url) => run(sql`UPDATE messages SET web_link=${url} WHERE id=${id}`),
      suggestContacts: compose.suggestContacts,
      hiddenContacts: compose.hiddenContacts,
      setContactHidden: compose.setContactHidden,
      audit,
      listAudit,
      agentWriteMode,
      setAgentWriteMode,
      insertProposal,
      listProposals,
      getProposal,
      setProposalStatus,
    });
  }),
);

/**
 * The Store service over SQLite. The only module that runs SQL. Rows are
 * decoded with schemas built from the domain types (this is the IO boundary);
 * SQL and decode failures die, since they mean a bug or a corrupt file.
 */
import { Clock, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { isSqlError, type SqlError } from "effect/sql/SqlError";
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
  MailOp,
  type MailboxView,
  type Message,
  type MessageSummary,
  Profile,
  type ProfileInput,
  type Proposal,
  Provider,
  type ThreadQuery,
  type ThreadSummary,
} from "./domain.js";
import { NotFound } from "./errors.js";
import { type PendingOp, Store } from "./services.js";

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
  body_text: Schema.String,
  body_html: Schema.String,
});

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
  op_json: Schema.fromJsonString(MailOp),
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

type Query = Effect.Effect<ReadonlyArray<unknown>, SqlError>;

/** Runs a query and decodes every row. */
function all<A, I>(schema: Schema.Codec<A, I>) {
  const decode = Schema.decodeUnknownEffect(Schema.Array(schema));
  return (query: Query): Effect.Effect<ReadonlyArray<A>> =>
    query.pipe(
      Effect.flatMap((rows) => decode(rows)),
      Effect.orDie,
    );
}

/** Runs a query and decodes the first row, if any. */
function first<A, I>(schema: Schema.Codec<A, I>) {
  const rows = all(schema);
  return (query: Query): Effect.Effect<Option.Option<A>> =>
    Effect.map(rows(query), (r) => Option.fromNullishOr(r[0]));
}

const run = (query: Effect.Effect<unknown, SqlError>): Effect.Effect<void> =>
  Effect.orDie(Effect.asVoid(query));

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
    bodyText: r.body_text,
    bodyHtml: r.body_html,
    attachments: r.attachments_json,
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
  important: "IMPORTANT",
  starred: "STARRED",
  sent: "SENT",
  drafts: "DRAFT",
  spam: "SPAM",
  trash: "TRASH",
};

const SUMMARY_COLUMNS = `m.id, m.account_id, m.thread_id, m.subject, m.from_name, m.from_addr,
  m.date, m.snippet, m.labels_json, m.attachments_json, m.is_unread, m.is_starred`;

/** Labels that are flags on every provider; the rest name a folder on Outlook and IMAP. */
const FLAG_LABELS = new Set(["UNREAD", "STARRED", "IMPORTANT"]);

/**
 * The labels a message carries after `op`. Gmail labels stack; on Outlook and
 * IMAP a message sits in exactly one folder, so moving ops swap the folder
 * label and `important` does nothing.
 */
export function applyOpToLabels(
  labels: readonly string[],
  op: MailOp,
  provider: Provider,
): string[] {
  const out = new Set(labels);
  const flag = (label: string, value: boolean) => (value ? out.add(label) : out.delete(label));
  if (op.kind === "read") flag("UNREAD", !op.value);
  else if (op.kind === "star") flag("STARRED", op.value);
  else if (provider === "gmail") {
    switch (op.kind) {
      case "important":
        flag("IMPORTANT", op.value);
        break;
      case "archive":
        out.delete("INBOX");
        break;
      case "inbox":
        out.delete("TRASH");
        out.delete("SPAM");
        out.add("INBOX");
        break;
      case "trash":
      case "spam":
        out.delete("INBOX");
        out.add(op.kind === "trash" ? "TRASH" : "SPAM");
        break;
      case "label":
        flag(op.labelId, op.value);
        break;
    }
  } else {
    const target = folderTarget(op, labels);
    if (target) {
      for (const l of labels) if (!FLAG_LABELS.has(l)) out.delete(l);
      out.add(target);
    }
  }
  return [...out];
}

/** The folder label a moving op sends a folder-model message to, or null for no move. */
export function folderTarget(op: MailOp, labels: readonly string[]): string | null {
  switch (op.kind) {
    case "archive":
      return "ARCHIVE";
    case "inbox":
      return "INBOX";
    case "trash":
      return "TRASH";
    case "spam":
      return "SPAM";
    case "label":
      if (op.value) return op.labelId;
      return labels.includes(op.labelId) ? "INBOX" : null;
    default:
      return null;
  }
}

export const StoreLive: Layer.Layer<Store, never, SqlClient.SqlClient> = Layer.effect(
  Store,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const hasLabel = (label: string) =>
      sql`EXISTS (SELECT 1 FROM json_each(m.labels_json) WHERE value = ${label})`;

    // An empty profile matches nothing rather than everything.
    const inAccounts = (ids: readonly string[]) =>
      ids.length === 0 ? sql.literal("0") : sql`m.account_id IN ${sql.in(ids)}`;

    // Accounts

    const accountRows = all(AccountRow);
    const ACCOUNT_COLUMNS = sql.literal(`id, provider, email, created_at, last_synced_at,
      last_sync_error, profile_id, settings_json, needs_reauth`);

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
      run(sql`DELETE FROM accounts WHERE id = ${id}`),
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
    ) {
      const now = yield* Clock.currentTimeMillis;
      yield* run(
        sql`UPDATE accounts SET sync_cursor = ${cursor}, last_synced_at = ${now} WHERE id = ${id}`,
      );
    });

    // Messages

    const upsertMessage = Effect.fn("Store.upsertMessage")((account: string, m: IncomingMessage) =>
      // ON CONFLICT DO UPDATE keeps the rowid stable, which the external-content
      // FTS table is keyed on. INSERT OR REPLACE would orphan index rows.
      run(sql`INSERT INTO messages (id, account_id, provider_id, thread_id, subject, from_name,
            from_addr, to_json, cc_json, date, snippet, body_text, body_html, labels_json,
            attachments_json, is_unread, is_starred)
          VALUES (${`${account}/${m.providerId}`}, ${account}, ${m.providerId}, ${m.threadId},
            ${m.subject}, ${m.from.name}, ${m.from.address}, ${JSON.stringify(m.to)},
            ${JSON.stringify(m.cc)}, ${m.date}, ${m.snippet}, ${m.bodyText}, ${m.bodyHtml},
            ${JSON.stringify(m.labels)}, ${JSON.stringify(m.attachments)}, ${m.isUnread ? 1 : 0},
            ${m.isStarred ? 1 : 0})
          ON CONFLICT(id) DO UPDATE SET
            thread_id = excluded.thread_id, subject = excluded.subject,
            from_name = excluded.from_name, from_addr = excluded.from_addr,
            to_json = excluded.to_json, cc_json = excluded.cc_json, date = excluded.date,
            snippet = excluded.snippet, body_text = excluded.body_text,
            body_html = excluded.body_html, labels_json = excluded.labels_json,
            attachments_json = excluded.attachments_json, is_unread = excluded.is_unread,
            is_starred = excluded.is_starred`),
    );

    const deleteMessage = Effect.fn("Store.deleteMessage")((account: string, providerId: string) =>
      run(sql`DELETE FROM messages WHERE id = ${`${account}/${providerId}`}`),
    );

    const deleteMessagesWithLabel = Effect.fn("Store.deleteMessagesWithLabel")(
      (account: string, label: string) =>
        run(sql`DELETE FROM messages AS m WHERE m.account_id = ${account} AND ${hasLabel(label)}`),
    );

    /** Drops an account's local mail, for a provider whose ids changed meaning. */
    const deleteAccountMessages = Effect.fn("Store.deleteAccountMessages")((account: string) =>
      run(sql`DELETE FROM messages WHERE account_id = ${account}`),
    );

    /** WHERE clauses of a thread list. Paging (`before`) is applied after collapsing threads. */
    const listFilter = (q: ThreadQuery) => {
      const where: Fragment[] = [];
      const mailbox = q.mailbox ?? "inbox";
      if (mailbox === "all")
        where.push(sql`NOT ${hasLabel("SPAM")}`, sql`NOT ${hasLabel("TRASH")}`);
      else where.push(hasLabel(MAILBOX_LABEL[mailbox]));
      if (q.label !== undefined) where.push(hasLabel(q.label));
      if (q.accountIds) where.push(inAccounts(q.accountIds));
      if (q.unreadOnly) where.push(sql`m.is_unread = 1`);
      if (q.starredOnly) where.push(sql`m.is_starred = 1`);
      return sql.and(where);
    };

    /**
     * Conversation list: one row per thread that has a message in the view,
     * represented by its newest such message. Unread and starred roll up across
     * the thread's messages in the view. `before` pages by the thread's newest
     * date, so a thread never shows up on two pages.
     */
    const threadList = (q: ThreadQuery, limit: number) =>
      all(ThreadRow)(sql`
        WITH ranked AS (
          SELECT ${sql.literal(SUMMARY_COLUMNS)},
            ROW_NUMBER() OVER thread AS rn,
            MAX(m.is_unread) OVER thread AS any_unread,
            MAX(m.is_starred) OVER thread AS any_starred
          FROM messages m
          WHERE ${listFilter(q)}
          WINDOW thread AS (PARTITION BY m.account_id, m.thread_id ORDER BY m.date DESC
            ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
        )
        SELECT r.*,
          (SELECT COUNT(*) FROM messages t
            WHERE t.account_id = r.account_id AND t.thread_id = r.thread_id) AS thread_count,
          (SELECT json_group_array(json_object('name', p.from_name, 'address', p.from_addr))
            FROM (SELECT from_name, from_addr, MIN(date) AS first FROM messages t
              WHERE t.account_id = r.account_id AND t.thread_id = r.thread_id
              GROUP BY from_addr ORDER BY first) p) AS participants_json
        FROM ranked r
        WHERE r.rn = 1 ${q.before === undefined ? sql.literal("") : sql`AND r.date < ${q.before}`}
        ORDER BY r.date DESC LIMIT ${limit}`).pipe(
        Effect.map((rows) =>
          rows.map((r): ThreadSummary => ({
            ...toSummary(r),
            isUnread: r.any_unread,
            isStarred: r.any_starred,
            threadCount: r.thread_count,
            participants: r.participants_json,
          })),
        ),
      );

    /**
     * Substring search over subject, sender and plain-text body, newest first.
     * Each whitespace-separated term must match. Terms of three or more
     * characters use the trigram index; shorter ones (common in Chinese) fall
     * back to LIKE. Mailbox, label and flag filters do not apply: search looks
     * through all mail of the given accounts. Each hit is its own row.
     */
    const search = (q: ThreadQuery, text: string, limit: number) => {
      const terms = text.trim().split(/\s+/).filter(Boolean);
      if (terms.length === 0) return Effect.succeed([]);
      const where: Fragment[] = [];
      const ftsTerms = terms.filter((t) => Array.from(t).length >= 3);
      if (ftsTerms.length > 0) {
        const match = ftsTerms.map((t) => `"${t.replaceAll('"', '""')}"`).join(" AND ");
        where.push(
          sql`m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ${match})`,
        );
      }
      for (const t of terms.filter((term) => Array.from(term).length < 3)) {
        const like = `%${t}%`;
        where.push(
          sql`(m.subject LIKE ${like} OR m.from_name LIKE ${like} OR m.from_addr LIKE ${like}
            OR m.body_text LIKE ${like})`,
        );
      }
      if (q.accountIds) where.push(inAccounts(q.accountIds));
      if (q.before !== undefined) where.push(sql`m.date < ${q.before}`);
      return all(SummaryRow)(sql`SELECT ${sql.literal(SUMMARY_COLUMNS)} FROM messages m
        WHERE ${sql.and(where)} ORDER BY m.date DESC LIMIT ${limit}`).pipe(
        Effect.map((rows) =>
          rows.map((r): ThreadSummary => {
            const summary = toSummary(r);
            return { ...summary, threadCount: 1, participants: [summary.from] };
          }),
        ),
      );
    };

    const listThreads = Effect.fn("Store.listThreads")((q: ThreadQuery) =>
      q.search === undefined ? threadList(q, q.limit ?? 50) : search(q, q.search, q.limit ?? 50),
    );

    const getMessage = Effect.fn("Store.getMessage")(function* (
      id: string,
    ): Effect.fn.Return<Message, NotFound> {
      const row = yield* first(MessageRow)(sql`SELECT m.* FROM messages m WHERE m.id = ${id}`);
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
      const rows = yield* all(MessageRow)(sql`SELECT m.* FROM messages m
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
      if (flags.isUnread) labels.add("UNREAD");
      else labels.delete("UNREAD");
      if (flags.isStarred) labels.add("STARRED");
      else labels.delete("STARRED");
      yield* run(sql`UPDATE messages SET labels_json = ${JSON.stringify([...labels])},
          is_unread = ${flags.isUnread ? 1 : 0}, is_starred = ${flags.isStarred ? 1 : 0}
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
      WHERE is_unread = 1 AND ${hasLabel("INBOX")} GROUP BY account_id`).pipe(
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
      op: MailOp,
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

    const removePendingOp = Effect.fn("Store.removePendingOp")((id: number) =>
      run(sql`DELETE FROM pending_ops WHERE id = ${id}`),
    );

    const failPendingOp = Effect.fn("Store.failPendingOp")((id: number, error: string) =>
      run(sql`UPDATE pending_ops SET attempts = attempts + 1, last_error = ${error}
        WHERE id = ${id}`),
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

    return Store.of({
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
      saveSyncCursor,
      upsertMessage,
      setFlags,
      deleteMessage,
      deleteMessagesWithLabel,
      deleteAccountMessages,
      listThreads,
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
      removePendingOp,
      failPendingOp,
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

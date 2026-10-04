import { Effect, Schema } from "effect";
import { type SqlClient } from "effect/sql";
import { type Fragment } from "effect/sql/Statement";
import { attachmentFilename } from "./attachment-filename.js";
import { categoryKey } from "./categories.js";
import { type Label, type ThreadQuery, type ThreadSummary } from "./domain.js";
import { DerivedChunk } from "./media.js";
import {
  ftsSearchTerm,
  hasSearchExpression,
  parseSearchQuery,
  reciprocalRankFusion,
  searchQueryError,
  searchWords,
  unquoteSearchValue,
  usesSubstringSearch,
} from "./search.js";
import { type Store } from "./services.js";
import { all } from "./sql-rows.js";
import { type makeComposeStore } from "./store-compose.js";
import {
  accountScope,
  EFFECTIVE_DATE,
  expressionMedia,
  type LocalQuery,
  type makeQueryStore,
  SUMMARY_COLUMNS,
} from "./store-query.js";
import {
  Count,
  counts,
  DerivedSearchRow,
  LabelRow,
  SummaryRow,
  ThreadRow,
  toSummary,
} from "./store-rows.js";
import { type makeWordIndexStore } from "./store-word-index.js";

export const makeThreadsStore = ({
  sql,
  compose,
  wordIndex,
  hasLabel,
  textFilter,
  listFilter,
  listSource,
  planTextPage,
}: {
  sql: SqlClient.SqlClient;
  compose: ReturnType<typeof makeComposeStore>;
  wordIndex: ReturnType<typeof makeWordIndexStore>;
  hasLabel: ReturnType<typeof makeQueryStore>["hasLabel"];
  textFilter: ReturnType<typeof makeQueryStore>["textFilter"];
  listFilter: ReturnType<typeof makeQueryStore>["listFilter"];
  listSource: ReturnType<typeof makeQueryStore>["listSource"];
  planTextPage: ReturnType<typeof makeQueryStore>["planTextPage"];
}) => {
  const countThreads = Effect.fn("Store.countThreads")(function* (raw: ThreadQuery) {
    const invalid = searchQueryError(raw);
    if (invalid) return yield* invalid;
    const readiness = yield* wordIndex.wordIndexReady;
    const query = yield* planTextPage({
      ...(raw.search === undefined ? raw : parseSearchQuery(raw)),
      wordIndexReady: readiness.messages,
      derivedWordIndexReady: readiness.derived,
    });
    if (
      query.textPage &&
      query.searchScope !== "folder" &&
      !query.messageIds &&
      !query.unreadOnly &&
      !query.starredOnly &&
      !query.listFilters?.enabled
    ) {
      const table = sql.literal(query.textPage.index);
      const filter = sql.and([
        sql`s.eligible=1`,
        sql`s.row_id IN (SELECT rowid FROM ${table} WHERE ${table} MATCH ${query.textPage.match})`,
      ]);
      const scope = sql.and([sql`a.enabled=1`, accountScope(sql, query.accountIds, "a.id")]);
      return yield* all(Schema.Struct({ n: Schema.Number }))(
        sql`SELECT COALESCE(SUM((SELECT COUNT(*) FROM (
            SELECT ${query.flat ? sql.literal("s.row_id") : sql.literal("s.thread_id")} FROM message_search_meta s INDEXED BY message_search_meta_threads
            WHERE s.account_id=a.id AND ${filter} ${query.flat ? sql.literal("") : sql.literal("GROUP BY s.thread_id")}
          ))),0) AS n FROM accounts a WHERE ${scope}`,
      ).pipe(Effect.map((rows) => rows[0]?.n ?? 0));
    }
    return yield* all(Schema.Struct({ n: Schema.Number }))(
      query.flat
        ? sql`SELECT COUNT(*) AS n FROM messages m WHERE ${listFilter(query)}`
        : sql`SELECT COUNT(*) AS n FROM (SELECT m.account_id,m.thread_id FROM messages m WHERE ${listFilter(query)} GROUP BY m.account_id,m.thread_id)`,
    ).pipe(Effect.map((rows) => rows[0]?.n ?? 0));
  });

  const threadList = Effect.fn("Store.threadList")(function* (q: LocalQuery, limit: number) {
    const materialize = !!q.criteria?.proximity || /\bAROUND\s+\d+\b/.test(q.search ?? "");
    // Proximity positions are computed once; only compact matching metadata is materialized.
    const grouped = sql`
        WITH matches AS MATERIALIZED (
          SELECT m.id,m.account_id,m.thread_id,m.list_date AS date,m.is_unread,m.is_starred
          FROM messages m INDEXED BY messages_list_date_id WHERE ${listFilter({ ...q, rowBoundText: false })}
        ), heads AS (
          SELECT account_id,thread_id,MAX(date) AS date,MAX(is_unread) AS any_unread,MAX(is_starred) AS any_starred
          FROM matches GROUP BY account_id,thread_id
        ), resolved AS (
          SELECT h.*,(SELECT MAX(c.id) FROM matches c WHERE c.account_id=h.account_id AND c.thread_id=h.thread_id AND c.date=h.date) AS id FROM heads h
        ), page AS (
          SELECT * FROM resolved c WHERE ${q.before === undefined ? sql.literal("1") : sql`(c.date < ${q.before} ${q.beforeId === undefined ? sql.literal("") : sql`OR (c.date = ${q.before} AND c.id < ${q.beforeId})`})`}
          ORDER BY c.date DESC,c.id DESC LIMIT ${limit}
        )
        SELECT ${sql.literal(SUMMARY_COLUMNS)},c.any_unread,c.any_starred,
          (SELECT COUNT(*) FROM messages t WHERE t.account_id=c.account_id AND t.thread_id=c.thread_id) AS thread_count,
          (SELECT json_group_array(json_object('name',p.from_name,'address',p.from_addr))
            FROM (SELECT from_name,from_addr,MIN(date) AS first FROM messages t
              WHERE t.account_id=c.account_id AND t.thread_id=c.thread_id GROUP BY from_addr ORDER BY first) p) AS participants_json
        FROM page c JOIN messages m ON m.id=c.id ORDER BY c.date DESC,c.id DESC`;
    const rows = yield* all(ThreadRow)(
      materialize
        ? grouped
        : sql`
        WITH candidates AS NOT MATERIALIZED (SELECT ${sql.literal(SUMMARY_COLUMNS)} FROM messages m WHERE ${listFilter({ ...q, rowBoundText: false })}),
        page AS (
          SELECT ${sql.literal(SUMMARY_COLUMNS)} FROM ${listSource(q)}
          WHERE NOT EXISTS (SELECT 1 FROM candidates n WHERE n.account_id=m.account_id AND n.thread_id=m.thread_id
              AND n.date>=m.list_date AND (n.date > m.list_date OR (n.date=m.list_date AND n.id>m.id)))
            AND ${listFilter(q)}
            AND ${q.before === undefined ? sql.literal("1") : sql`(m.list_date < ${q.before} ${q.beforeId === undefined ? sql.literal("") : sql`OR (m.list_date = ${q.before} AND m.id < ${q.beforeId})`})`}
          ORDER BY m.list_date DESC,m.id DESC LIMIT ${limit}
        )
        SELECT c.*,
          (SELECT MAX(v.is_unread) FROM candidates v WHERE v.account_id=c.account_id AND v.thread_id=c.thread_id) AS any_unread,
          (SELECT MAX(v.is_starred) FROM candidates v WHERE v.account_id=c.account_id AND v.thread_id=c.thread_id) AS any_starred,
          (SELECT COUNT(*) FROM messages t WHERE t.account_id=c.account_id AND t.thread_id=c.thread_id) AS thread_count,
          (SELECT json_group_array(json_object('name',p.from_name,'address',p.from_addr))
            FROM (SELECT from_name,from_addr,MIN(date) AS first FROM messages t
              WHERE t.account_id=c.account_id AND t.thread_id=c.thread_id GROUP BY from_addr ORDER BY first) p) AS participants_json
        FROM page c ORDER BY c.date DESC,c.id DESC`,
    );
    return rows.map((r): ThreadSummary => ({
      ...toSummary(r),
      ...(r.attachments_json.length
        ? {
            attachmentNames: r.attachments_json
              .slice(0, 2)
              .map((a) => attachmentFilename(a.filename)),
          }
        : {}),
      isUnread: r.any_unread,
      isStarred: r.any_starred,
      threadCount: r.thread_count,
      participants: r.participants_json,
    }));
  });

  /** Conversation grouping off: each message in the view is its own row, newest first. */
  const messageList = (q: LocalQuery, limit: number) =>
    all(SummaryRow)(sql`SELECT ${sql.literal(SUMMARY_COLUMNS)} FROM ${listSource(q)}
        WHERE ${listFilter(q)} ${q.before === undefined ? sql.literal("") : sql`AND (${sql.literal(EFFECTIVE_DATE)} < ${q.before} ${q.beforeId === undefined ? sql.literal("") : sql`OR (${sql.literal(EFFECTIVE_DATE)} = ${q.before} AND m.id < ${q.beforeId})`})`}
        ORDER BY date DESC, m.id DESC LIMIT ${limit}`).pipe(
      Effect.map((rows) =>
        rows.map((r): ThreadSummary => {
          const summary = toSummary(r);
          return {
            ...summary,
            ...(r.attachments_json.length
              ? {
                  attachmentNames: r.attachments_json
                    .slice(0, 2)
                    .map((a) => attachmentFilename(a.filename)),
                }
              : {}),
            threadCount: 1,
            participants: [summary.from],
          };
        }),
      ),
    );

  const listThreads = Effect.fn("Store.listThreads")(function* (raw: ThreadQuery) {
    const invalid = searchQueryError(raw);
    if (invalid) return yield* invalid;
    if (raw.search !== undefined && !raw.search.trim()) return [];
    const readiness = yield* wordIndex.wordIndexReady;
    const q = yield* planTextPage({
      ...(raw.search === undefined ? raw : parseSearchQuery(raw)),
      wordIndexReady: readiness.messages,
      derivedWordIndexReady: readiness.derived,
    });
    const mediaExpression = expressionMedia(q.search ?? "");
    const limit = mediaExpression ? Math.min(q.limit ?? 50, 1024) : (q.limit ?? 50);
    const listing = q.flat ? messageList : threadList;
    const terms = searchWords(q.search ?? "").map(unquoteSearchValue);
    let threads =
      q.criteria?.attachmentText && terms.length && !mediaExpression
        ? []
        : yield* listing(q, limit);
    if (
      terms.length &&
      !hasSearchExpression(q.search ?? "") &&
      !searchWords(q.search ?? "").some((term) => term.startsWith("-"))
    ) {
      const predicates = searchWords(q.search ?? "").map((term) =>
        textFilter(term, true, readiness.derived),
      );
      const long = searchWords(q.search ?? "")
        .map(ftsSearchTerm)
        .filter((term) => term !== null);
      const ranking =
        readiness.derived && !usesSubstringSearch(q.search ?? "")
          ? sql`(SELECT rank FROM derived_words WHERE rowid=d.id AND derived_words MATCH ${long.join(" AND ")})`
          : sql.literal("m.date DESC");
      const { attachmentText: _scope, ...criteria } = q.criteria ?? {};
      const matches = yield* all(DerivedSearchRow)(
        sql`SELECT m.account_id,m.thread_id,d.provenance_json FROM derived_chunks d JOIN messages m ON m.id=d.message_id
          WHERE ${listFilter({ ...q, search: "", criteria })} AND ${sql.and(predicates)}
          ${q.before === undefined ? sql.literal("") : sql`AND m.date < ${q.before}`}
          ORDER BY ${long.length ? ranking : sql.literal("m.date DESC")},d.id LIMIT ${Math.min(Math.max(limit * 20, 200), 4096)}`,
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
        .toSorted((a, b) => (ranks.get(keyOf(a)) ?? Infinity) - (ranks.get(keyOf(b)) ?? Infinity));
      threads = reciprocalRankFusion(threads, derived, q.flat).slice(0, limit);
    }
    // The Drafts list also shows drafts the provider has no copy of yet.
    const filters = q.listFilters;
    const filtered =
      filters?.enabled &&
      (filters.unread || filters.starred || filters.important || filters.inInbox);
    const plain = q.label === undefined && !q.unreadOnly && !q.starredOnly && !filtered;
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
    const invalid = searchQueryError(raw);
    if (invalid) return yield* invalid;
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

  /** Sidebar/account badge units follow the conversation preference. */
  const unreadCounts = Effect.gen(function* () {
    const prefs = yield* compose.prefs;
    const rows = yield* all(
      Count,
    )(sql`SELECT account_id AS key, ${prefs.threadGrouping ? sql`COUNT(DISTINCT thread_id)` : sql`COUNT(*)`} AS n FROM messages m
        WHERE m.account_id IN (SELECT id FROM accounts WHERE enabled=1) AND is_unread=1 AND ${hasLabel("INBOX")} AND NOT EXISTS (SELECT 1 FROM thread_reminders r WHERE r.account_id=m.account_id AND r.thread_id=m.thread_id AND r.due_at IS NOT NULL) GROUP BY account_id`);
    return counts(rows);
  }).pipe(Effect.withSpan("Store.unreadCounts"));

  /**
   * Unread messages per label id, across the given accounts (all when omitted).
   * Keys are system labels (INBOX, SPAM, CATEGORY_*) and user label ids alike.
   * `within` counts only messages that also carry that label, e.g. INBOX for
   * category badges.
   */
  const unreadByLabel = Effect.fn("Store.unreadByLabel")(function* (
    accountIds?: readonly string[],
    within?: string,
    conversations = false,
  ) {
    const where: Fragment[] = [sql`b.account_id IN (SELECT id FROM accounts WHERE enabled=1)`];
    if (accountIds) where.push(accountScope(sql, accountIds, "b.account_id"));
    if (within === "INBOX") where.push(sql`b.in_inbox=1`);
    else if (within !== undefined)
      where.push(
        sql`EXISTS (SELECT 1 FROM messages m WHERE m.id=b.message_id AND ${hasLabel(within)})`,
      );
    where.push(
      sql`(b.label != 'INBOX' OR NOT EXISTS(SELECT 1 FROM thread_reminders r WHERE r.account_id=b.account_id AND r.thread_id=b.thread_id AND r.due_at IS NOT NULL))`,
    );
    const rows = yield* all(Count)(
      conversations
        ? sql`SELECT key,SUM(n) AS n FROM (
            SELECT b.label AS key,b.account_id,COUNT(DISTINCT b.thread_id) AS n
            FROM message_badges b
            WHERE ${sql.and(where)} GROUP BY b.label,b.account_id
          ) GROUP BY key`
        : sql`SELECT b.label AS key,COUNT(*) AS n
            FROM message_badges b
            WHERE ${sql.and(where)} GROUP BY b.label`,
    );
    const result = counts(rows);
    if (within === undefined || within === "DRAFT") {
      const local = yield* compose.countLocalDrafts(accountIds);
      if (local) result["DRAFT"] = (result["DRAFT"] ?? 0) + local;
    }
    return result;
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
              yield* sql`INSERT INTO labels (account_id, id, name, color, label_list_visibility, message_list_visibility)
                  VALUES (${account}, ${l.id}, ${l.name}, ${l.color}, ${l.labelListVisibility ?? null}, ${l.messageListVisibility ?? null})`;
            }
          }),
        ),
      ),
  );

  const listLabels = Effect.fn("Store.listLabels")(function* (accountIds?: readonly string[]) {
    const rows = yield* all(
      LabelRow,
    )(sql`SELECT account_id, id, name, color, label_list_visibility, message_list_visibility FROM labels m
        WHERE m.account_id IN (SELECT id FROM accounts WHERE enabled=1) AND ${accountScope(sql, accountIds)}
        ORDER BY account_id, name`);
    const categories = yield* all(
      Schema.Struct({
        accountId: Schema.String,
        id: Schema.String,
        name: Schema.String,
        color: Schema.NullOr(Schema.String),
      }),
    )(sql`
        SELECT DISTINCT m.account_id AS accountId, j.value AS id, substr(j.value,10) AS name, NULL AS color
        FROM messages m JOIN accounts a ON a.id=m.account_id, json_each(m.labels_json) j
        WHERE a.enabled=1 AND a.provider='outlook' AND j.value LIKE 'category:%' AND ${accountScope(sql, accountIds)}`);
    return [
      ...new Map(
        categories.map((category) => [
          `${category.accountId}/${categoryKey(category.id.slice(9))}`,
          category,
        ]),
      ).values(),
      ...rows.map((r) => ({
        accountId: r.account_id,
        id: r.id,
        name: r.name,
        color: r.color,
        ...(r.label_list_visibility ? { labelListVisibility: r.label_list_visibility } : {}),
        ...(r.message_list_visibility ? { messageListVisibility: r.message_list_visibility } : {}),
      })),
    ];
  });
  return {
    listThreads,
    countThreads,
    vectorThreads,
    unreadCounts,
    unreadByLabel,
    replaceLabels,
    listLabels,
  } satisfies Pick<
    Store["Service"],
    | "listThreads"
    | "countThreads"
    | "vectorThreads"
    | "unreadCounts"
    | "unreadByLabel"
    | "replaceLabels"
    | "listLabels"
  >;
};

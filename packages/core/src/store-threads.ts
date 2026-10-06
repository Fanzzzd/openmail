import { Effect, Schema } from "effect";
import { type SqlClient } from "effect/sql";
import { type Fragment } from "effect/sql/Statement";
import { attachmentFilename } from "./attachment-filename.js";
import { categoryKey } from "./categories.js";
import { type Label, type SearchMatch, type ThreadQuery, type ThreadSummary } from "./domain.js";
import { exactSearchPhrase, searchHighlightTerms, searchSnippet } from "./search-snippets.js";
import { SearchProfile, searchEffect, searchStep, type SearchProfiler } from "./search-profile.js";
import { DerivedChunk } from "./media.js";
import {
  ftsSearchTerm,
  hasSearchExpression,
  keyOf,
  parseSearchQuery,
  parseSearchExpression,
  proximityMatch,
  quoteSearchValue,
  reciprocalRankFusion,
  searchQueryError,
  searchWords,
  unquoteSearchValue,
  usesSubstringSearch,
  wordTokens,
  type SearchExpression,
} from "./search.js";
import { type Store } from "./services.js";
import { all, sqliteTextCompare } from "./sql-rows.js";
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
import { type makeWordIndexStore, type WordIndexState } from "./store-word-index.js";
import { messageModelText, visibleHtmlText } from "./visible-text.js";

const rowKey = (row: typeof DerivedSearchRow.Type, flat?: boolean) =>
  flat ? row.provenance_json.messageId : `${row.account_id}/${row.thread_id}`;

function getOrSet<K, V>(memo: Map<K, V>, key: K, create: () => V): V {
  const previous = memo.get(key);
  if (previous !== undefined) return previous;
  const value = create();
  memo.set(key, value);
  return value;
}

const decodeSummaries = Schema.decodeUnknownSync(Schema.Array(SummaryRow));
const decodeThreads = Schema.decodeUnknownSync(Schema.Array(ThreadRow));

const nonzeroProximity = (q: LocalQuery) =>
  (q.criteria?.proximity?.distance ?? 0) > 0 ||
  q.criteria?.excluded?.some((condition) => (condition.proximity?.distance ?? 0) > 0) ||
  /\bAROUND\s+0*[1-9]\d*\b/.test(q.search ?? "");

const proximityWindow = (limit: number) => Math.min(limit, 50);
const asciiText = (text: string) => /^[\t\n\r\x20-\x7e]*$/.test(text);
const soleExpression = (node: SearchExpression): SearchExpression => {
  if (node.kind === "and" || node.kind === "or") {
    const [child, ...rest] = node.children;
    if (child && !rest.length) return soleExpression(child);
  }
  return node;
};

const unsearchedProximity = (q: LocalQuery): LocalQuery => {
  const { proximity: _proximity, excluded, ...criteria } = q.criteria ?? {};
  return {
    ...q,
    search: "",
    criteria: { ...criteria, excluded: excluded?.filter((condition) => !condition.proximity) },
    proximityPage: { kind: "prefilter" },
  };
};

const ProximityProbeRow = Schema.Struct({
  subject: Schema.String,
  from_name: Schema.String,
  from_addr: Schema.String,
  body_text: Schema.String,
  has_derived: Schema.Number,
});

const newestFirst = (a: ThreadSummary, b: ThreadSummary) =>
  b.date - a.date || sqliteTextCompare(b.id, a.id);

const SearchBodyRow = Schema.Struct({
  id: Schema.String,
  body_text: Schema.String,
  body_html: Schema.String,
  relevance: Schema.NullOr(Schema.Number),
});
type SearchBodies = ReadonlyMap<string, typeof SearchBodyRow.Type>;
type SearchContext = {
  profile: SearchProfiler | null;
  q: LocalQuery;
  readiness: WordIndexState;
  highlights: readonly string[];
  mailCandidates: ReadonlyMap<string, ThreadSummary>;
  derivedRanks: Map<string, number>;
  threads: readonly ThreadSummary[];
  limit: number;
};
type MatchedSearch = {
  threads: ThreadSummary[];
  exactMail: ReadonlySet<string>;
  exactAttachments: ReadonlySet<string>;
};

const rankBySource = (
  { q, mailCandidates, derivedRanks, limit }: SearchContext,
  matched: MatchedSearch,
  bodies: SearchBodies,
): ThreadSummary[] => {
  const threads = matched.threads;
  const body = threads
    .filter((thread) => thread.searchMatches?.some((match) => match.source !== "attachment"))
    .toSorted(
      (a, b) =>
        (bodies.get(mailCandidates.get(keyOf(a, q.flat))?.id ?? a.id)?.relevance ?? 0) -
          (bodies.get(mailCandidates.get(keyOf(b, q.flat))?.id ?? b.id)?.relevance ?? 0) ||
        b.date - a.date,
    );
  const derived = threads
    .filter((thread) => thread.searchMatches?.some((match) => match.source === "attachment"))
    .toSorted(
      (a, b) =>
        (derivedRanks.get(keyOf(a, q.flat)) ?? Infinity) -
        (derivedRanks.get(keyOf(b, q.flat)) ?? Infinity),
    );
  if (!derived.length) return threads;
  const rankedKeys = new Set([...body, ...derived].map((thread) => keyOf(thread, q.flat)));
  const other = threads.filter((thread) => !rankedKeys.has(keyOf(thread, q.flat)));
  return [
    ...reciprocalRankFusion(body, derived, q.flat, matched.exactAttachments, matched.exactMail),
    ...other,
  ].slice(0, limit);
};

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
  const threadMessageIds = (threads: readonly ThreadSummary[]) =>
    sql`SELECT m.id FROM json_each(${JSON.stringify(threads.map(({ accountId, threadId }) => ({ accountId, threadId })))}) k
      JOIN messages m ON m.account_id=json_extract(k.value,'$.accountId') AND m.thread_id=json_extract(k.value,'$.threadId')`;

  // For a simple atom, ASCII columns use exactly unicode61's token boundaries.
  // A failed cheap probe can skip the scoped instance-stream read. Derived
  // chunks, other expressions and Unicode columns retain the SQLite check.
  const mayMatchProximity = Effect.fnUntraced(function* (
    q: LocalQuery,
    messageIds: readonly string[],
  ) {
    if (!q.wordIndexReady || !q.derivedWordIndexReady || messageIds.length > 200) return true;
    const expression = soleExpression(parseSearchExpression(q.search ?? ""));
    const atom = expression.kind === "not" ? soleExpression(expression.child) : expression;
    const term = atom.kind === "term" ? atom : undefined;
    if (!term) return true;
    const p = parseSearchQuery({ search: term.value }).criteria?.proximity;
    if (!p?.distance) return true;
    const rows = yield* all(
      ProximityProbeRow,
    )(sql`SELECT m.subject,m.from_name,m.from_addr,m.body_text,
        EXISTS(SELECT 1 FROM derived_chunks d WHERE d.message_id=m.id) AS has_derived
      FROM messages m WHERE m.id IN (SELECT value FROM json_each(${JSON.stringify(messageIds)}))`);
    const columns = rows.map((row) => [row.subject, row.from_name, row.from_addr, row.body_text]);
    if (rows.some((row) => row.has_derived) || columns.some((texts) => !texts.every(asciiText)))
      return true;
    return columns.some(
      (texts) => texts.some((text) => proximityMatch(text, p)) !== (expression.kind === "not"),
    );
  });

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

  const threadPage = Effect.fn("Store.threadPage")(function* (q: LocalQuery, limit: number) {
    // Exact passes group the candidate scope, or the corpus after fallback.
    const materialize = q.proximityPage?.kind === "exact";
    const grouped = sql`
        WITH matches AS MATERIALIZED (
          SELECT m.id,m.account_id,m.thread_id,m.list_date AS date,m.is_unread,m.is_starred
          FROM ${q.proximityPage?.kind === "exact" && q.proximityPage.messageIds ? sql`messages m` : sql`messages m INDEXED BY messages_list_date_id`} WHERE ${listFilter({ ...q, rowBoundText: false })}
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
    // If every head in the newest unsearched window matches, older matching
    // replies cannot enter that window. Avoid building the corpus-wide FTS set.
    // Any missing head requires the full query; cursors always use that query.
    const optimistic =
      !!q.textPage &&
      q.before === undefined &&
      !materialize &&
      !hasSearchExpression(q.search ?? "");
    const unsearched = { ...q, search: "", textPage: undefined };
    const newestMatch = sql`NOT EXISTS (SELECT 1 FROM candidates n WHERE n.account_id=m.account_id AND n.thread_id=m.thread_id
      AND n.date>=m.list_date AND (n.date > m.list_date OR (n.date=m.list_date AND n.id>m.id)))`;
    // SQLite may evaluate a row-bound MATCH before the correlated exclusion.
    // Skip old replies first, then open MATCH only for potential thread heads.
    const headFilter = q.textPage
      ? sql`CASE WHEN ${newestMatch} THEN ${listFilter(q)} ELSE 0 END`
      : sql`${newestMatch} AND ${listFilter(q)}`;
    const query = (fast: boolean) =>
      (materialize
        ? grouped
        : sql`
        WITH candidates AS NOT MATERIALIZED (SELECT ${sql.literal(SUMMARY_COLUMNS)} FROM messages m WHERE ${listFilter(fast ? unsearched : { ...q, rowBoundText: false })}),
        ${
          fast
            ? sql`recent AS MATERIALIZED (
          SELECT m.rowid FROM ${listSource(q)} WHERE CASE WHEN ${newestMatch} THEN ${listFilter(unsearched)} ELSE 0 END
          ORDER BY m.list_date DESC,m.id DESC LIMIT ${limit}
        ),`
            : sql.literal("")
        }
        flag_candidates AS NOT MATERIALIZED (SELECT m.account_id,m.thread_id,m.is_unread,m.is_starred FROM messages m WHERE ${listFilter(q)}),
        page AS MATERIALIZED (
          SELECT ${sql.literal(SUMMARY_COLUMNS)},
            json_array(
              EXISTS(SELECT 1 FROM flag_candidates v WHERE v.account_id=m.account_id AND v.thread_id=m.thread_id AND v.is_unread=1),
              EXISTS(SELECT 1 FROM flag_candidates v WHERE v.account_id=m.account_id AND v.thread_id=m.thread_id AND v.is_starred=1)
            ) AS flags_json
          FROM ${fast ? sql`messages m` : listSource(q)}
          WHERE ${accountScope(sql, q.accountIds)} AND ${fast ? sql`m.rowid IN (SELECT rowid FROM recent) AND ${listFilter(q)}` : headFilter}
            AND ${q.before === undefined ? sql.literal("1") : sql`(m.list_date < ${q.before} ${q.beforeId === undefined ? sql.literal("") : sql`OR (m.list_date = ${q.before} AND m.id < ${q.beforeId})`})`}
          ORDER BY m.list_date DESC,m.id DESC LIMIT ${limit}
        )
        SELECT c.*,
          json_extract(c.flags_json,'$[0]') AS any_unread,
          json_extract(c.flags_json,'$[1]') AS any_starred,
          (SELECT COUNT(*) FROM messages t WHERE t.account_id=c.account_id AND t.thread_id=c.thread_id) AS thread_count,
          (SELECT json_group_array(json_object('name',p.from_name,'address',p.from_addr))
            FROM (SELECT from_name,from_addr,MIN(date) AS first FROM messages t
              WHERE t.account_id=c.account_id AND t.thread_id=c.thread_id GROUP BY from_addr ORDER BY first) p) AS participants_json
        FROM page c ORDER BY c.date DESC,c.id DESC`
      ).pipe(Effect.map(decodeThreads), Effect.orDie);
    let rows = yield* query(optimistic);
    if (optimistic && rows.length < limit) rows = yield* query(false);
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

  const threadList = Effect.fn("Store.threadList")(function* (q: LocalQuery, limit: number) {
    if (!nonzeroProximity(q)) return yield* threadPage(q, limit);
    const fullPage = () => threadPage({ ...q, proximityPage: { kind: "exact" } }, limit);
    if (limit <= 0) return yield* fullPage();
    const window = proximityWindow(limit);
    // Unsearched heads are a superset of matching heads. Apply the caller's
    // cursor to exact heads, then fall back if this first window cannot fill it.
    const candidates = yield* threadPage(
      { ...unsearchedProximity(q), before: undefined, beforeId: undefined },
      window,
    );
    const [first, ...older] = candidates;
    if (!first) return [];
    const { before, beforeId } = q;
    if (
      before !== undefined &&
      candidates.every(
        (row) =>
          row.threadCount === 1 &&
          !(
            row.date < before ||
            (row.date === before &&
              beforeId !== undefined &&
              sqliteTextCompare(row.id, beforeId) < 0)
          ),
      )
    )
      return yield* fullPage();
    const tail = older.at(-1) ?? first;
    const ids = yield* all(Schema.Struct({ id: Schema.String }))(threadMessageIds(candidates));
    const messageIds = ids.map((row) => row.id);
    if (!(yield* mayMatchProximity(q, messageIds))) return yield* fullPage();
    const matches = yield* threadPage(
      { ...q, proximityPage: { kind: "exact", messageIds } },
      window,
    );
    if (candidates.length < window) return matches;
    if (
      matches.length === limit &&
      newestFirst(
        matches.reduce((_, row) => row),
        tail,
      ) <= 0
    )
      return matches;
    return yield* fullPage();
  });

  /** Conversation grouping off: each message in the view is its own row, newest first. */
  const messagePage = (q: LocalQuery, limit: number) =>
    sql`SELECT ${sql.literal(SUMMARY_COLUMNS)} FROM ${listSource(q)}
        WHERE ${listFilter(q)} ${q.before === undefined ? sql.literal("") : sql`AND (${sql.literal(EFFECTIVE_DATE)} < ${q.before} ${q.beforeId === undefined ? sql.literal("") : sql`OR (${sql.literal(EFFECTIVE_DATE)} = ${q.before} AND m.id < ${q.beforeId})`})`}
        ORDER BY date DESC, m.id DESC LIMIT ${limit}`.pipe(
      Effect.map(decodeSummaries),
      Effect.orDie,
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

  const messageList = Effect.fn("Store.messageList")(function* (q: LocalQuery, limit: number) {
    if (limit <= 0 || !nonzeroProximity(q)) return yield* messagePage(q, limit);
    const fullPage = () => messagePage({ ...q, proximityPage: { kind: "exact" } }, limit);
    const window = proximityWindow(limit);
    const candidates = yield* messagePage(unsearchedProximity(q), window);
    if (!candidates.length) return [];
    const messageIds = candidates.map((row) => row.id);
    if (!(yield* mayMatchProximity(q, messageIds))) return yield* fullPage();
    const matches = yield* messagePage(
      { ...q, proximityPage: { kind: "exact", messageIds } },
      limit,
    );
    if (matches.length === limit || candidates.length < window) return matches;
    return yield* fullPage();
  });

  const derivedRanking = (words: readonly string[], q: LocalQuery) => {
    const ready = (q.derivedWordIndexReady ?? false) && !usesSubstringSearch(q.search ?? "");
    return {
      ready,
      rankable:
        ready ||
        words.every((word) => Array.from(unquoteSearchValue(word.replace(/\*$/, ""))).length >= 3),
      index: sql.literal(ready ? "derived_words" : "derived_fts"),
    };
  };

  const loadBodies = Effect.fn("Store.loadSearchBodies")(function* ({
    q,
    readiness,
    highlights,
    threads,
    mailCandidates,
  }: SearchContext) {
    const bodyMatch = highlights
      .map(ftsSearchTerm)
      .filter((term) => term !== null)
      .join(" OR ");
    const bodyIndex = sql.literal(
      readiness.messages && !usesSubstringSearch(q.search ?? "")
        ? "messages_words"
        : "messages_fts",
    );
    const selectedIds = [
      ...new Set(
        threads.flatMap((thread) => [
          mailCandidates.get(keyOf(thread, q.flat))?.id ?? thread.id,
          ...(thread.derivedMatches ?? [])
            .filter((chunk) => chunk.source.kind === "body")
            .map((chunk) => chunk.messageId),
        ]),
      ),
    ];
    const bodyIds = sql`SELECT rowid FROM messages WHERE id IN (SELECT value FROM json_each(${JSON.stringify(selectedIds)}))`;
    // A rowid IN constraint restarts the FTS cursor (and BM25 corpus stats) per id.
    // The numeric expression keeps one MATCH cursor and filters its compact rowids.
    const rows = yield* all(
      SearchBodyRow,
    )(sql`WITH selected_ids(rowid) AS MATERIALIZED (${bodyIds}), ranks AS MATERIALIZED (
          SELECT rowid,bm25(${bodyIndex},4,0,0,1) AS relevance FROM ${bodyIndex}
          WHERE ${bodyIndex} MATCH ${bodyMatch}
          AND rowid >= (SELECT MIN(rowid) FROM selected_ids) AND rowid <= (SELECT MAX(rowid) FROM selected_ids)
          AND (rowid+0) IN (SELECT rowid FROM selected_ids)
        ) SELECT m.id,m.body_text,m.body_html,r.relevance FROM messages m LEFT JOIN ranks r ON r.rowid=m.rowid
        WHERE m.rowid IN (SELECT rowid FROM selected_ids)`);
    return new Map(rows.map((row) => [row.id, row]));
  });

  const attachMatches = Effect.fn("Store.attachSearchMatches")(function* (
    context: SearchContext,
    bodies: SearchBodies,
  ) {
    const { q, readiness, highlights, derivedRanks, mailCandidates, profile } = context;
    let threads = context.threads;
    const snippetCache = new Map<string, ReturnType<typeof searchSnippet>>();
    const snippetFor = (text: string, source: "mail" | "derived" = "mail") => {
      const mode = (source === "mail" ? readiness.messages : readiness.derived)
        ? "words"
        : "substring";
      const key = `${mode}:${text}`;
      return getOrSet(snippetCache, key, () =>
        searchStep(profile, "snippet extraction", () => searchSnippet(text, highlights, mode)),
      );
    };
    const phraseQuery = wordTokens(highlights.map(unquoteSearchValue).join(" ")).length > 1;
    const phraseCache = new Map<string, boolean>();
    const exactFor = (text: string) =>
      phraseQuery &&
      getOrSet(phraseCache, text, () =>
        searchStep(profile, "exact phrase check", () => exactSearchPhrase(text, highlights)),
      );
    const keys = threads.map((thread) => keyOf(thread, q.flat));
    // Complex expressions already select mixed body/attachment candidates. Fetch
    // their matching chunks in the same selected conversations, without widening scope.
    if (expressionMedia(q.search ?? "") || q.criteria?.proximity) {
      const { rankable, index: derivedIndex } = derivedRanking(highlights, q);
      const bodyMatch = highlights
        .map(ftsSearchTerm)
        .filter((term) => term !== null)
        .join(" OR ");
      const selectedIds = q.flat
        ? sql`SELECT value AS id FROM json_each(${JSON.stringify(keys)})`
        : threadMessageIds(threads);
      const selected = nonzeroProximity(q)
        ? yield* all(Schema.Struct({ id: Schema.String }))(selectedIds)
        : undefined;
      const matchRows = yield* all(
        DerivedSearchRow,
      )(sql`SELECT m.account_id,m.thread_id,d.provenance_json
          FROM ${rankable ? sql`${derivedIndex} JOIN derived_chunks d ON d.id=${derivedIndex}.rowid` : sql`derived_chunks d`}
          JOIN messages m ON m.id=d.message_id
          WHERE ${rankable ? sql`${derivedIndex} MATCH ${bodyMatch}` : sql.or(highlights.map((term) => textFilter(term, true, readiness.derived)))}
          ${selected ? sql.literal("") : sql`AND m.id IN (${selectedIds})`}
          AND ${listFilter(selected ? { ...q, proximityPage: { kind: "exact", messageIds: selected.map((row) => row.id) } } : q)} ORDER BY ${rankable ? sql`bm25(${derivedIndex})` : sql.literal("m.date DESC")},m.date DESC,d.id LIMIT 4096`);
      const grouped = new Map<string, DerivedChunk[]>();
      for (const [rank, row] of matchRows.entries()) {
        const key = rowKey(row, q.flat);
        if (!derivedRanks.has(key)) derivedRanks.set(key, rank);
        const chunks = getOrSet(grouped, key, () => []);
        if (chunks.length < 20 && snippetFor(row.provenance_json.text, "derived").highlights.length)
          chunks.push(row.provenance_json);
      }
      threads = threads.map((thread) => ({
        ...thread,
        derivedMatches: grouped.get(keyOf(thread, q.flat)) ?? [],
      }));
    }
    const visible = new Map<string, string>();
    const visibleBody = (id: string) => {
      const body = bodies.get(id);
      if (!body) return "";
      const key = JSON.stringify([body.body_text, body.body_html]);
      return getOrSet(visible, key, () => {
        const model = searchStep(profile, "visible body extraction", () =>
          messageModelText(body.body_text, body.body_html),
        );
        return model.flags.includes("budget-exceeded") ? "" : model.text;
      });
    };
    const exactMail = new Set<string>();
    const exactAttachments = new Set<string>();
    const annotated = searchStep(profile, "result annotation", () =>
      threads.map((thread) => {
        const matches: SearchMatch[] = [];
        const mailCandidate = mailCandidates.get(keyOf(thread, q.flat)) ?? thread;
        const subject = snippetFor(mailCandidate.subject);
        if (subject.highlights.length && !q.criteria?.attachmentText)
          matches.push({ source: "subject", messageId: mailCandidate.id, ...subject });
        const visibleText = visibleBody(mailCandidate.id);
        const body = snippetFor(visibleText);
        if (
          !q.criteria?.attachmentText &&
          (exactFor(mailCandidate.subject) || exactFor(visibleText))
        )
          exactMail.add(keyOf(thread, q.flat));
        if (body.highlights.length && !q.criteria?.attachmentText)
          matches.push({ source: "body", messageId: mailCandidate.id, ...body });
        const derivedMatches = (thread.derivedMatches ?? []).flatMap((chunk) => {
          const text =
            chunk.source.kind === "body"
              ? visibleBody(chunk.messageId)
              : /<\/?[a-z][^>]*>/i.test(chunk.text)
                ? visibleHtmlText(chunk.text).text
                : chunk.text;
          const snippet = snippetFor(text, "derived");
          if (!snippet.highlights.length) return [];
          if (chunk.source.kind !== "body" && exactFor(text))
            exactAttachments.add(keyOf(thread, q.flat));
          matches.push(
            chunk.source.kind === "body"
              ? { source: "body", messageId: chunk.messageId, ...snippet }
              : {
                  source: "attachment",
                  messageId: chunk.messageId,
                  attachmentName: attachmentFilename(chunk.source.name),
                  attachmentIndex: chunk.source.kind === "attachment" ? chunk.source.index : null,
                  ...snippet,
                },
          );
          return [{ ...chunk, text: snippet.snippet }];
        });
        return {
          ...thread,
          snippet: body.highlights.length || subject.highlights.length ? body.snippet : "",
          searchMatches: matches.slice(0, 20),
          ...(thread.derivedMatches ? { derivedMatches } : {}),
        };
      }),
    );
    return { threads: annotated, exactMail, exactAttachments } satisfies MatchedSearch;
  });

  const listThreads = Effect.fn("Store.listThreads")(function* (raw: ThreadQuery) {
    const profile = yield* SearchProfile;
    const endPreparation = profile?.begin("request preparation");
    const invalid = searchQueryError(raw);
    if (invalid) {
      endPreparation?.();
      return yield* invalid;
    }
    if (raw.search !== undefined && !raw.search.trim()) {
      endPreparation?.();
      return [];
    }
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
    const highlights = searchHighlightTerms(raw);
    const derivedRanks = new Map<string, number>();
    endPreparation?.();
    let threads =
      q.criteria?.attachmentText && terms.length && !mediaExpression
        ? []
        : yield* searchEffect(profile, "mail candidate selection", listing(q, limit));
    const mailCandidates = searchStep(
      profile,
      "mail candidate map",
      () => new Map(threads.map((thread) => [keyOf(thread, q.flat), thread])),
    );
    if (
      terms.length &&
      !hasSearchExpression(q.search ?? "") &&
      !searchWords(q.search ?? "").some((term) => term.startsWith("-"))
    ) {
      const endQueryPreparation = profile?.begin("attachment query preparation");
      const predicates = searchWords(q.search ?? "").map((term) =>
        textFilter(term, true, readiness.derived),
      );
      const words = searchWords(q.search ?? "");
      const { ready, rankable, index } = derivedRanking(words, q);
      const ftsMatch = words
        .map((word) =>
          ftsSearchTerm(
            ready ? word : quoteSearchValue(unquoteSearchValue(word.replace(/\*$/, ""))),
          ),
        )
        .join(" AND ");
      const { attachmentText: _scope, ...criteria } = q.criteria ?? {};
      // With a full window of visible subject hits, ordinary one-word OCR cannot outrank it.
      // Inspect attachment matches in those conversations without reading every matching mail.
      const scoped =
        mailCandidates.size >= limit &&
        highlights.length === 1 &&
        wordTokens(unquoteSearchValue(highlights[0] ?? "")).length === 1 &&
        [...mailCandidates.values()].every(
          (thread) =>
            searchSnippet(thread.subject, highlights, readiness.messages ? "words" : "substring")
              .highlights.length > 0,
        );
      const scope = q.flat
        ? sql`SELECT d.id FROM derived_chunks d WHERE d.message_id IN (SELECT value FROM json_each(${JSON.stringify([...mailCandidates.values()].map((thread) => thread.id))}))`
        : sql`SELECT d.id FROM (${threadMessageIds([...mailCandidates.values()])}) selected
            JOIN derived_chunks d ON d.message_id=selected.id`;
      endQueryPreparation?.();
      const endQuery = profile?.begin("attachment candidate selection");
      const decodeMatches = Schema.decodeUnknownSync(
        Schema.Array(
          Schema.Struct({
            ...DerivedSearchRow.fields,
            date: Schema.Number,
            is_unread: SummaryRow.fields.is_unread,
            is_starred: SummaryRow.fields.is_starred,
          }),
        ),
      );
      const matches =
        yield* sql`${scoped && rankable ? sql`WITH scoped_chunks(id) AS MATERIALIZED (${scope})` : sql.literal("")}
          SELECT m.account_id,m.thread_id,m.date,m.is_unread,m.is_starred,d.provenance_json FROM
          ${rankable ? sql`${index} JOIN derived_chunks d ON d.id=${index}.rowid` : sql`derived_chunks d`}
          JOIN messages m ON m.id=d.message_id
          WHERE ${listFilter({ ...q, search: "", criteria })} AND ${rankable ? sql`${index} MATCH ${ftsMatch}` : sql.and(predicates)}
          ${scoped && rankable ? sql`AND ${index}.rowid >= (SELECT MIN(id) FROM scoped_chunks) AND ${index}.rowid <= (SELECT MAX(id) FROM scoped_chunks) AND (${index}.rowid+0) IN (SELECT id FROM scoped_chunks)` : sql.literal("")}
          ${q.before === undefined ? sql.literal("") : sql`AND m.date < ${q.before}`}
          ORDER BY ${rankable ? sql`bm25(${index})` : sql.literal("m.date DESC")},m.date DESC,d.id LIMIT ${Math.min(Math.max(limit * 20, 200), 4096)}`.pipe(
          Effect.map(decodeMatches),
          Effect.orDie,
        );
      endQuery?.();
      const endGrouping = profile?.begin("attachment grouping");
      const grouped = new Map<string, DerivedChunk[]>();
      const ranks = new Map<string, number>();
      const representatives = new Map<string, { id: string; date: number }>();
      const flags = new Map<string, { isUnread: boolean; isStarred: boolean }>();
      for (const [rank, match] of matches.entries()) {
        const key = rowKey(match, q.flat);
        const group = grouped.get(key) ?? [];
        if (group.length < 20) group.push(match.provenance_json);
        grouped.set(key, group);
        if (!ranks.has(key)) ranks.set(key, rank);
        const previousFlags = flags.get(key);
        flags.set(key, {
          isUnread: (previousFlags?.isUnread ?? false) || match.is_unread,
          isStarred: (previousFlags?.isStarred ?? false) || match.is_starred,
        });
        const previous = representatives.get(key);
        if (
          !previous ||
          previous.date < match.date ||
          (previous.date === match.date &&
            sqliteTextCompare(previous.id, match.provenance_json.messageId) < 0)
        )
          representatives.set(key, { id: match.provenance_json.messageId, date: match.date });
      }
      // Fetch one representative per ranked conversation, not every page/chunk's mail.
      const knownIds: string[] = [];
      const unknownIds: string[] = [];
      for (const key of [...ranks.keys()].slice(0, Math.min(limit, 1024))) {
        const representative = representatives.get(key);
        if (representative)
          (mailCandidates.has(key) ? knownIds : unknownIds).push(representative.id);
      }
      // The mail route already loaded these conversations' counts and participants.
      // Fetch the attachment representative's own fields without collapsing them again.
      endGrouping?.();
      const known = knownIds.length
        ? yield* searchEffect(
            profile,
            "known attachment representatives",
            messageList({ ...q, search: "", criteria, messageIds: knownIds }, knownIds.length),
          )
        : [];
      const unknown = unknownIds.length
        ? yield* searchEffect(
            profile,
            "unknown attachment representatives",
            listing({ ...q, search: "", criteria, messageIds: unknownIds }, unknownIds.length),
          )
        : [];
      const endSummaries = profile?.begin("attachment summary ordering");
      const candidates = [
        ...known.map((thread) => {
          const mail = mailCandidates.get(keyOf(thread, q.flat));
          return mail
            ? { ...thread, threadCount: mail.threadCount, participants: mail.participants }
            : thread;
        }),
        ...unknown,
      ];
      const derived = candidates
        .map((thread) => ({
          ...thread,
          ...flags.get(keyOf(thread, q.flat)),
          derivedMatches: grouped.get(keyOf(thread, q.flat)) ?? [],
        }))
        .toSorted(
          (a, b) =>
            (ranks.get(keyOf(a, q.flat)) ?? Infinity) - (ranks.get(keyOf(b, q.flat)) ?? Infinity),
        );
      for (const [rank, thread] of derived.entries()) derivedRanks.set(keyOf(thread, q.flat), rank);
      endSummaries?.();
      threads = searchStep(profile, "initial fusion", () =>
        reciprocalRankFusion(threads, derived.slice(0, limit), q.flat).slice(0, limit * 2),
      );
    }
    // Only the bounded result window is materialized for visibility and provenance.
    if (highlights.length && threads.length) {
      const context = {
        q,
        readiness,
        highlights,
        threads,
        mailCandidates,
        derivedRanks,
        limit,
        profile,
      };
      const bodies = yield* searchEffect(profile, "body loading and BM25", loadBodies(context));
      const matched = yield* searchEffect(
        profile,
        "match preparation",
        attachMatches(context, bodies),
      );
      threads = searchStep(profile, "source ranking and fusion", () =>
        rankBySource(context, matched, bodies),
      );
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
    return candidates
      .map((thread) => ({ ...thread, derivedMatches: matched.get(keyOf(thread, q.flat)) ?? [] }))
      .toSorted(
        (a, b) =>
          (ranks.get(keyOf(a, q.flat)) ?? Infinity) - (ranks.get(keyOf(b, q.flat)) ?? Infinity),
      );
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
    const literalLabels = [
      ...where,
      sql`(b.label!='CATEGORY_PERSONAL' OR b.account_id NOT IN (SELECT id FROM accounts WHERE provider='outlook'))`,
    ];
    const rows = yield* all(Count)(
      conversations
        ? sql`SELECT key,SUM(n) AS n FROM (
            SELECT b.label AS key,b.account_id,COUNT(DISTINCT b.thread_id) AS n
            FROM message_badges b
            WHERE ${sql.and(literalLabels)} GROUP BY b.label,b.account_id
          ) GROUP BY key`
        : sql`SELECT b.label AS key,COUNT(*) AS n
            FROM message_badges b
            WHERE ${sql.and(literalLabels)} GROUP BY b.label`,
    );
    const result = counts(rows);
    // Unknown Outlook Inbox mail belongs to Focused. Count eligible messages
    // before grouping: a conversation may contain both Focused and Other mail.
    const focusedWhere = [
      ...where,
      sql`b.label='INBOX'`,
      sql`b.account_id IN (SELECT id FROM accounts WHERE provider='outlook')`,
      sql`NOT EXISTS(SELECT 1 FROM message_badges other WHERE other.label='CATEGORY_OTHER'
        AND other.account_id=b.account_id AND other.thread_id=b.thread_id AND other.message_id=b.message_id)`,
    ];
    const focused = yield* all(Count)(
      conversations
        ? sql`SELECT 'CATEGORY_PERSONAL' AS key,SUM(n) AS n FROM (
          SELECT COUNT(DISTINCT b.thread_id) AS n FROM message_badges b
          WHERE ${sql.and(focusedWhere)} GROUP BY b.account_id
        ) HAVING SUM(n)>0`
        : sql`SELECT 'CATEGORY_PERSONAL' AS key,COUNT(*) AS n FROM message_badges b
          WHERE ${sql.and(focusedWhere)} HAVING COUNT(*)>0`,
    );
    for (const row of focused) result[row.key] = (result[row.key] ?? 0) + row.n;
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

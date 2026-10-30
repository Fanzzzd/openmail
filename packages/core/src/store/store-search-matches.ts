import { Effect, Schema } from "effect";
import { type SqlClient } from "effect/sql";
import { attachmentFilename } from "../mime/attachment-filename.js";
import type { SearchMatch, ThreadSummary } from "../domain/message.js";
import {
  exactSearchPhrase,
  searchSnippet,
  mergeSearchRanges,
  searchTermRanges,
} from "../search/search-snippets.js";
import { searchEffect, searchStep, type SearchProfiler } from "../search/search-profile.js";
import { DerivedChunk } from "../ai/media.js";
import { ftsSearchTerm, usesSubstringSearch, wordTokens } from "../search/fts.js";
import { keyOf } from "../search/ranking.js";
import { unquoteSearchValue } from "../search/search-tokens.js";
import { all } from "./sql-rows.js";
import { expressionMedia, type LocalQuery, type makeQueryStore } from "./store-query.js";
import { DerivedSearchRow, SummaryRow } from "./store-rows.js";
import { type WordIndexState } from "./store-word-index.js";
import { visibleHtmlText } from "../visible-text/visible-text.js";
import type { HtmlText } from "../platform/html-text.js";

export const rowKey = (row: typeof DerivedSearchRow.Type, flat?: boolean) =>
  flat ? row.provenance_json.messageId : `${row.account_id}/${row.thread_id}`;

export function getOrSet<K, V>(memo: Map<K, V>, key: K, create: () => V): V {
  const previous = memo.get(key);
  if (previous !== undefined) return previous;
  const value = create();
  memo.set(key, value);
  return value;
}

/**
 * Results whose visible text is not stored yet (store-visible-text.ts) get it computed on the
 * HtmlText worker while the search waits, at most this many: about two screens of rows. The rest
 * show no body snippet until the background fill reaches them.
 */
export const SEARCH_VISIBLE_ROWS = 30;
/** Visible text computed for unstored results, kept by row and body version until it is stored. */
const COMPUTED_CACHE_SIZE = 500;

export const nonzeroProximity = (q: LocalQuery) =>
  (q.criteria?.proximity?.distance ?? 0) > 0 ||
  q.criteria?.excluded?.some((condition) => (condition.proximity?.distance ?? 0) > 0) ||
  /\bAROUND\s+0*[1-9]\d*\b/.test(q.search ?? "");

export const SearchBodyRow = Schema.Struct({
  id: Schema.String,
  row_id: Schema.Int,
  visible: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.String),
  body_text: Schema.String,
  body_html: Schema.String,
});

const SearchRelevanceRow = Schema.Struct({ id: Schema.String, relevance: Schema.Number });

/** Visible text by message id; undefined when it is not stored and was not computed. */
export type SearchBodies = ReadonlyMap<string, string | undefined>;

export type SearchContext = {
  profile: SearchProfiler | null;
  q: LocalQuery;
  readiness: WordIndexState;
  highlights: readonly string[];
  mailCandidates: ReadonlyMap<string, ThreadSummary>;
  derivedRanks: Map<string, number>;
  threads: readonly ThreadSummary[];
  limit: number;
};

export type MatchedSearch = {
  threads: ThreadSummary[];
  exactMail: ReadonlySet<string>;
  exactAttachments: ReadonlySet<string>;
};

/** The selected conversations' messages whose text a result shows, first rows first. */
const shownBodyIds = ({ q, threads, mailCandidates }: SearchContext) =>
  threads.map((thread) => [
    mailCandidates.get(keyOf(thread, q.flat))?.id ?? thread.id,
    ...(thread.derivedMatches ?? [])
      .filter((chunk) => chunk.source.kind === "body")
      .map((chunk) => chunk.messageId),
  ]);

/** Adds the match context a search result shows: snippets, highlight ranges, field and attachment matches, and source ranking. */
export const makeSearchMatches = ({
  sql,
  textFilter,
  listFilter,
  htmlText,
}: {
  sql: SqlClient.SqlClient;
  textFilter: ReturnType<typeof makeQueryStore>["textFilter"];
  listFilter: ReturnType<typeof makeQueryStore>["listFilter"];
  htmlText: HtmlText;
}) => {
  const computed = new Map<string, string>();
  const remember = (key: string, text: string) => {
    computed.set(key, text);
    if (computed.size > COMPUTED_CACHE_SIZE) {
      const oldest = computed.keys().next();
      if (!oldest.done) computed.delete(oldest.value);
    }
  };

  const threadMessageIds = (threads: readonly ThreadSummary[]) =>
    sql`SELECT m.id FROM json_each(${JSON.stringify(threads.map(({ accountId, threadId }) => ({ accountId, threadId })))}) k
      JOIN messages m ON m.account_id=json_extract(k.value,'$.accountId') AND m.thread_id=json_extract(k.value,'$.threadId')`;

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

  const selectedBodyIds = (context: SearchContext) => {
    const ids = [...new Set(shownBodyIds(context).flat())];
    return sql`SELECT rowid FROM messages WHERE id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`;
  };

  /**
   * The visible text of the selected messages. Stored text and plain-text bodies are read as
   * they are. An HTML body not stored yet is computed on the HtmlText worker, ahead of the
   * background fill, when it belongs to the first SEARCH_VISIBLE_ROWS results; the HTML is read
   * only for those rows.
   */
  const loadBodies = Effect.fn("Store.loadSearchBodies")(function* (context: SearchContext) {
    const urgent = new Set(shownBodyIds(context).slice(0, SEARCH_VISIBLE_ROWS).flat());
    const urgentIds = JSON.stringify([...urgent]);
    const rows = yield* all(SearchBodyRow)(
      sql`SELECT m.id,m.rowid AS row_id,v.text AS visible,p.version,
        CASE WHEN v.row_id IS NULL AND (p.row_id IS NULL OR m.id IN (SELECT value FROM json_each(${urgentIds})))
          THEN m.body_text ELSE '' END AS body_text,
        CASE WHEN v.row_id IS NULL AND m.id IN (SELECT value FROM json_each(${urgentIds}))
          THEN m.body_html ELSE '' END AS body_html
        FROM messages m LEFT JOIN message_visible_text v ON v.row_id=m.rowid
        LEFT JOIN message_visible_text_pending p ON p.row_id=m.rowid
        WHERE m.rowid IN (${selectedBodyIds(context)})`,
    );
    const texts = new Map<string, string | undefined>();
    const missing: (typeof SearchBodyRow.Type)[] = [];
    for (const row of rows) {
      const key = `${row.row_id}:${row.version}`;
      if (row.visible !== null) texts.set(row.id, row.visible);
      else if (computed.has(key)) texts.set(row.id, computed.get(key));
      else if (row.version !== null && !urgent.has(row.id)) texts.set(row.id, undefined);
      else if (!row.body_html.trim()) texts.set(row.id, row.body_text);
      else if (urgent.has(row.id)) missing.push(row);
      else texts.set(row.id, undefined);
    }
    const fresh = missing.length
      ? yield* searchEffect(
          context.profile,
          "visible body extraction",
          Effect.forEach(
            missing,
            (row) => htmlText.visibleText(row.body_text, row.body_html, { urgent: true }),
            { concurrency: "unbounded" },
          ),
        )
      : [];
    for (const [i, row] of missing.entries()) {
      const text = fresh[i] ?? "";
      texts.set(row.id, text);
      if (row.version !== null) remember(`${row.row_id}:${row.version}`, text);
    }
    return texts satisfies SearchBodies;
  });

  /**
   * BM25 of the selected messages' text, which orders mail against attachment matches. A prefix
   * that most mail contains expands to every word it starts, so this costs about 47 ms on 100k
   * messages; the caller runs it only when attachment matches need the order.
   */
  const loadRelevance = Effect.fn("Store.loadSearchRelevance")(function* (context: SearchContext) {
    const { q, readiness, highlights } = context;
    const bodyMatch = highlights
      .map(ftsSearchTerm)
      .filter((term) => term !== null)
      .join(" OR ");
    const bodyIndex = sql.literal(
      readiness.messages && !usesSubstringSearch(q.search ?? "")
        ? "messages_words"
        : "messages_fts",
    );
    // A rowid IN constraint restarts the FTS cursor (and BM25 corpus stats) per id.
    // The numeric expression keeps one MATCH cursor and filters its compact rowids.
    const rows = yield* all(
      SearchRelevanceRow,
    )(sql`WITH selected_ids(rowid) AS MATERIALIZED (${selectedBodyIds(context)}), ranks AS MATERIALIZED (
          SELECT rowid,bm25(${bodyIndex},4,0,0,1) AS relevance FROM ${bodyIndex}
          WHERE ${bodyIndex} MATCH ${bodyMatch}
          AND rowid >= (SELECT MIN(rowid) FROM selected_ids) AND rowid <= (SELECT MAX(rowid) FROM selected_ids)
          AND (rowid+0) IN (SELECT rowid FROM selected_ids)
        ) SELECT m.id,r.relevance FROM ranks r JOIN messages m ON m.rowid=r.rowid`);
    return new Map(rows.map((row) => [row.id, row.relevance]));
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
      // `+m.id` keeps the selected ids from driving the join: as a plain IN, SQLite probed
      // derived_chunks_message once per selected id for every matching chunk (13 s for `weekly
      // OR alpha` over 10k OCR chunks). The chunk's own rowid finds its message instead.
      const matchRows = yield* all(
        DerivedSearchRow,
      )(sql`SELECT m.account_id,m.thread_id,d.provenance_json
          FROM ${rankable ? sql`${derivedIndex} JOIN derived_chunks d ON d.id=${derivedIndex}.rowid` : sql`derived_chunks d`}
          JOIN messages m ON m.id=d.message_id
          WHERE ${rankable ? sql`${derivedIndex} MATCH ${bodyMatch}` : sql.or(highlights.map((term) => textFilter(term, true, readiness.derived)))}
          ${selected ? sql.literal("") : sql`AND +m.id IN (${selectedIds})`}
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
    const visibleBody = (id: string) => bodies.get(id);
    const exactMail = new Set<string>();
    const exactAttachments = new Set<string>();
    const annotated = searchStep(profile, "result annotation", () =>
      threads.map((thread) => {
        const matches: SearchMatch[] = [];
        const mailCandidate = mailCandidates.get(keyOf(thread, q.flat)) ?? thread;
        const subject = snippetFor(mailCandidate.subject);
        if (subject.highlights.length && !q.criteria?.attachmentText)
          matches.push({ source: "subject", messageId: mailCandidate.id, ...subject });
        // Not stored or computed yet: no body snippet or body match until the fill reaches it.
        const visibleText = visibleBody(mailCandidate.id);
        const body = snippetFor(visibleText ?? "");
        if (
          !q.criteria?.attachmentText &&
          (exactFor(mailCandidate.subject) || (visibleText !== undefined && exactFor(visibleText)))
        )
          exactMail.add(keyOf(thread, q.flat));
        if (body.highlights.length && !q.criteria?.attachmentText)
          matches.push({ source: "body", messageId: mailCandidate.id, ...body });
        const derivedMatches = (thread.derivedMatches ?? []).flatMap((chunk) => {
          const text =
            chunk.source.kind === "body"
              ? (visibleBody(chunk.messageId) ?? "")
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

  /**
   * Sender and file-name hits for the returned page only. They do not change
   * the ranking, so they skip the wider candidate window. `from:` values count
   * as sender hits; `filename:` values as file-name hits.
   */
  const pageFieldMatches = Effect.fn("Store.pageFieldMatches")(function* (
    q: LocalQuery,
    highlights: readonly string[],
    threads: readonly ThreadSummary[],
    mailCandidates: ReadonlyMap<string, ThreadSummary>,
    previews: ReadonlyMap<string, string>,
  ) {
    const from = q.criteria?.from;
    const filenameTerms = q.criteria?.filename ? [...highlights, q.criteria.filename] : highlights;
    const mailOf = (thread: ThreadSummary) => mailCandidates.get(keyOf(thread, q.flat)) ?? thread;
    const attachmentRows = filenameTerms.length
      ? yield* all(
          Schema.Struct({
            id: Schema.String,
            attachments_json: SummaryRow.fields.attachments_json,
          }),
        )(
          sql`SELECT id,attachments_json FROM messages WHERE id IN (SELECT value FROM json_each(${JSON.stringify(threads.map((thread) => mailOf(thread).id))}))`,
        )
      : [];
    const attachments = new Map(attachmentRows.map((row) => [row.id, row.attachments_json]));
    return threads.map((thread): ThreadSummary => {
      const mail = mailOf(thread);
      const matches: SearchMatch[] = [];
      if (!q.criteria?.attachmentText) {
        const text = (
          mail.from.name ? `${mail.from.name} <${mail.from.address}>` : mail.from.address
        )
          .replace(/\s+/g, " ")
          .trim();
        const ranges = mergeSearchRanges([
          ...searchTermRanges(text, highlights),
          ...(from ? searchTermRanges(text, [from], "substring") : []),
        ]);
        if (ranges.length)
          matches.push({ source: "sender", messageId: mail.id, snippet: text, highlights: ranges });
      }
      for (const [index, attachment] of (attachments.get(mail.id) ?? []).entries()) {
        const name = attachmentFilename(attachment.filename);
        const hit = searchSnippet(name, filenameTerms);
        if (hit.highlights.length)
          matches.push({
            source: "filename",
            messageId: mail.id,
            attachmentName: name,
            attachmentIndex: index,
            ...hit,
          });
      }
      if (!matches.length) return thread;
      // A row whose only text hit is its sender keeps the ordinary preview.
      let snippet = thread.snippet;
      if (!snippet && matches.some((match) => match.source === "sender"))
        snippet = previews.get(keyOf(thread, q.flat)) ?? "";
      return {
        ...thread,
        snippet,
        searchMatches: [...(thread.searchMatches ?? []), ...matches].slice(0, 20),
      };
    });
  });

  return {
    threadMessageIds,
    derivedRanking,
    loadBodies,
    loadRelevance,
    attachMatches,
    pageFieldMatches,
  };
};

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
import { searchStep, type SearchProfiler } from "../search/search-profile.js";
import { DerivedChunk } from "../ai/media.js";
import { ftsSearchTerm, usesSubstringSearch, wordTokens } from "../search/fts.js";
import { keyOf } from "../search/ranking.js";
import { unquoteSearchValue } from "../search/search-tokens.js";
import { all } from "./sql-rows.js";
import { expressionMedia, type LocalQuery, type makeQueryStore } from "./store-query.js";
import { DerivedSearchRow, SummaryRow } from "./store-rows.js";
import { type WordIndexState } from "./store-word-index.js";
import { messageModelText, visibleHtmlText } from "../visible-text/visible-text.js";

export const rowKey = (row: typeof DerivedSearchRow.Type, flat?: boolean) =>
  flat ? row.provenance_json.messageId : `${row.account_id}/${row.thread_id}`;

export function getOrSet<K, V>(memo: Map<K, V>, key: K, create: () => V): V {
  const previous = memo.get(key);
  if (previous !== undefined) return previous;
  const value = create();
  memo.set(key, value);
  return value;
}

/** FNV-1a over UTF-16 code units: a cheap content key for a message body. */
const bodyHash = (text: string) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(36);
};

/** Visible text of this many message bodies stays cached between searches. */
const VISIBLE_CACHE_SIZE = 500;

export const nonzeroProximity = (q: LocalQuery) =>
  (q.criteria?.proximity?.distance ?? 0) > 0 ||
  q.criteria?.excluded?.some((condition) => (condition.proximity?.distance ?? 0) > 0) ||
  /\bAROUND\s+0*[1-9]\d*\b/.test(q.search ?? "");

export const SearchBodyRow = Schema.Struct({
  id: Schema.String,
  body_text: Schema.String,
  body_html: Schema.String,
});

const SearchRelevanceRow = Schema.Struct({ id: Schema.String, relevance: Schema.Number });

export type SearchBodies = ReadonlyMap<string, typeof SearchBodyRow.Type>;

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

/** Adds the match context a search result shows: snippets, highlight ranges, field and attachment matches, and source ranking. */
export const makeSearchMatches = ({
  sql,
  textFilter,
  listFilter,
}: {
  sql: SqlClient.SqlClient;
  textFilter: ReturnType<typeof makeQueryStore>["textFilter"];
  listFilter: ReturnType<typeof makeQueryStore>["listFilter"];
}) => {
  // Visible text takes tens of milliseconds per HTML body (CSS parsing, hidden-text rules). A
  // common word's 200 results spent 3.7 s of main-process time on a real 20k-message database,
  // again on every refresh of the open search and on each change while it showed. Keyed by the
  // body's content, so a body fetched or edited again is read again; oldest entries leave first.
  const visibleCache = new Map<string, string>();
  const cachedVisible = (key: string, create: () => string) => {
    const hit = visibleCache.get(key);
    if (hit !== undefined) {
      visibleCache.delete(key);
      visibleCache.set(key, hit);
      return hit;
    }
    const value = create();
    visibleCache.set(key, value);
    if (visibleCache.size > VISIBLE_CACHE_SIZE) {
      const oldest = visibleCache.keys().next();
      if (!oldest.done) visibleCache.delete(oldest.value);
    }
    return value;
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

  /** The selected conversations' messages whose text a result shows. */
  const selectedBodyIds = ({ q, threads, mailCandidates }: SearchContext) => {
    const ids = [
      ...new Set(
        threads.flatMap((thread) => [
          mailCandidates.get(keyOf(thread, q.flat))?.id ?? thread.id,
          ...(thread.derivedMatches ?? [])
            .filter((chunk) => chunk.source.kind === "body")
            .map((chunk) => chunk.messageId),
        ]),
      ),
    ];
    return sql`SELECT rowid FROM messages WHERE id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`;
  };

  const loadBodies = Effect.fn("Store.loadSearchBodies")(function* (context: SearchContext) {
    const rows = yield* all(SearchBodyRow)(
      sql`SELECT m.id,m.body_text,m.body_html FROM messages m WHERE m.rowid IN (${selectedBodyIds(context)})`,
    );
    return new Map(rows.map((row) => [row.id, row]));
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
    const visibleBody = (id: string) => {
      const body = bodies.get(id);
      if (!body) return "";
      const key = `${body.body_text.length}:${bodyHash(body.body_text)}:${body.body_html.length}:${bodyHash(body.body_html)}`;
      return cachedVisible(key, () => {
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

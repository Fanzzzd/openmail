import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { operatorTextValues } from "../db/operator-text.js";
import { BACKFILL_SEARCH_FLAGS } from "../db/search-flags.js";
import { bigramText } from "../search/search-bigrams.js";
import { all, run } from "./sql-rows.js";

/** Pending rows one bigram batch reads at most. */
export const BIGRAM_BATCH_ROWS = 200;
/**
 * Token characters one bigram batch writes before it stops: about 32,000 CJK characters, since
 * each one becomes a two-character token and a space. 200 rows of 3 KB CJK text held the
 * connection for up to 663 ms; this keeps a batch near 100 ms.
 */
export const BIGRAM_BATCH_TOKENS = 96_000;

const Progress = Schema.Struct({
  kind: Schema.Literals(["messages", "derived"]),
  cursor: Schema.Int,
  end_rowid: Schema.Int,
  ready: Schema.BooleanFromBit,
});
export interface WordIndexState {
  readonly messages: boolean;
  readonly derived: boolean;
}

/** Each committed rowid range is resumable. Triggers track concurrent writes so a row is indexed once. */
export function makeWordIndexStore(sql: SqlClient.SqlClient) {
  const progress = all(Progress)(sql`SELECT * FROM search_word_index ORDER BY kind`);
  const wordIndexReady = progress.pipe(
    Effect.map((rows): WordIndexState => ({
      messages: rows.some((row) => row.kind === "messages" && row.ready),
      derived: rows.some((row) => row.kind === "derived" && row.ready),
    })),
  );
  // Each step reads before it opens a write transaction: BEGIN IMMEDIATE takes the write lock
  // even when nothing is pending, and waits for another process that holds it.
  const backfillWordIndex = (requested = 200) =>
    Effect.gen(function* () {
      if ((yield* progress).every((row) => row.ready)) return { processed: 0, ready: true };
      return yield* backfillWordIndexBatch(requested);
    });
  const backfillWordIndexBatch = (requested: number) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const batchSize = Math.min(Math.max(Math.floor(requested), 1), 500);
          const pending = (yield* progress).find((row) => !row.ready);
          if (!pending) return { processed: 0, ready: true };
          const rows = yield* all(Schema.Struct({ row_id: Schema.Int }))(
            pending.kind === "messages"
              ? sql`SELECT rowid AS row_id FROM messages WHERE rowid>${pending.cursor} AND rowid<=${pending.end_rowid} ORDER BY rowid LIMIT ${batchSize}`
              : sql`SELECT id AS row_id FROM derived_chunks WHERE id>${pending.cursor} AND id<=${pending.end_rowid} ORDER BY id LIMIT ${batchSize}`,
          );
          const end = rows.at(-1)?.row_id ?? pending.end_rowid;
          // Rows stored before soft hyphens were dropped lose them here. The update triggers
          // reindex those rows in every search index, this one included.
          if (pending.kind === "messages") {
            yield* run(sql`UPDATE messages SET subject=replace(subject,char(173),''),body_text=replace(body_text,char(173),'')
        WHERE rowid>${pending.cursor} AND rowid<=${end} AND (instr(subject,char(173))>0 OR instr(body_text,char(173))>0)`);
            yield* run(sql`INSERT INTO messages_words(rowid,subject,from_name,from_addr,body_text)
        SELECT m.rowid,m.subject,m.from_name,m.from_addr,m.body_text FROM messages m WHERE m.rowid>${pending.cursor} AND m.rowid<=${end} AND NOT EXISTS(SELECT 1 FROM search_word_rows r WHERE r.kind='messages' AND r.row_id=m.rowid)`);
            yield* run(
              sql`INSERT OR IGNORE INTO search_word_rows(kind,row_id) SELECT 'messages',rowid FROM messages WHERE rowid>${pending.cursor} AND rowid<=${end}`,
            );
          } else {
            yield* run(sql`UPDATE derived_chunks SET text=replace(text,char(173),'')
        WHERE id>${pending.cursor} AND id<=${end} AND instr(text,char(173))>0`);
            yield* run(sql`INSERT INTO derived_words(rowid,text)
        SELECT d.id,d.text FROM derived_chunks d WHERE d.id>${pending.cursor} AND d.id<=${end} AND NOT EXISTS(SELECT 1 FROM search_word_rows r WHERE r.kind='derived' AND r.row_id=d.id)`);
            yield* run(
              sql`INSERT OR IGNORE INTO search_word_rows(kind,row_id) SELECT 'derived',id FROM derived_chunks WHERE id>${pending.cursor} AND id<=${end}`,
            );
          }
          yield* run(
            sql`UPDATE search_word_index SET cursor=${end},ready=${end >= pending.end_rowid ? 1 : 0} WHERE kind=${pending.kind}`,
          );
          const state = yield* wordIndexReady;
          return { processed: rows.length, ready: state.messages && state.derived };
        }),
      )
      .pipe(Effect.orDie);
  /** Rows from before migration 45 get their has: operator flags in small committed batches. */
  const backfillSearchFlags = (requested = 500) =>
    Effect.gen(function* () {
      const pending = yield* all(Schema.Struct({ row_id: Schema.Int }))(
        sql`SELECT row_id FROM message_search_meta INDEXED BY message_search_meta_flags_pending WHERE search_flags IS NULL LIMIT 1`,
      );
      if (pending.length === 0) return { processed: 0, ready: true };
      return yield* backfillSearchFlagsBatch(requested);
    });
  const backfillSearchFlagsBatch = (requested: number) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const batchSize = Math.min(Math.max(Math.floor(requested), 1), 2000);
          const rows = yield* all(Schema.Struct({ row_id: Schema.Int }))(
            sql`SELECT row_id FROM message_search_meta INDEXED BY message_search_meta_flags_pending WHERE search_flags IS NULL ORDER BY row_id LIMIT ${batchSize}`,
          );
          const last = rows.at(-1)?.row_id;
          if (last === undefined) return { processed: 0, ready: true };
          yield* run(
            sql`${sql.literal(BACKFILL_SEARCH_FLAGS)} WHERE search_flags IS NULL AND row_id<=${last}`,
          );
          return { processed: rows.length, ready: rows.length < batchSize };
        }),
      )
      .pipe(Effect.orDie);
  const PendingMessage = Schema.Struct({
    row_id: Schema.Int,
    subject: Schema.NullOr(Schema.String),
    from_name: Schema.NullOr(Schema.String),
    from_addr: Schema.NullOr(Schema.String),
    body_text: Schema.NullOr(Schema.String),
  });
  const PendingChunk = Schema.Struct({ row_id: Schema.Int, text: Schema.NullOr(Schema.String) });
  /**
   * Writes bigram tokens for rows the triggers queued: new, changed or every
   * row from before migration 48. A queued row stays searchable through LIKE.
   */
  const indexBigrams = (requested = BIGRAM_BATCH_ROWS) =>
    Effect.gen(function* () {
      const pending = yield* all(Schema.Struct({ row_id: Schema.Int }))(
        sql`SELECT p.row_id FROM search_bigram_pending p WHERE CASE p.kind
          WHEN 'messages' THEN EXISTS(SELECT 1 FROM messages m WHERE m.rowid=p.row_id)
          ELSE EXISTS(SELECT 1 FROM derived_chunks d WHERE d.id=p.row_id) END LIMIT 1`,
      );
      if (pending.length === 0) return { processed: 0, ready: true };
      return yield* indexBigramsBatch(requested);
    });
  const indexBigramsBatch = (requested: number) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const batchSize = Math.min(Math.max(Math.floor(requested), 1), 1000);
          const messages = yield* all(PendingMessage)(
            sql`SELECT p.row_id,m.subject,m.from_name,m.from_addr,m.body_text FROM search_bigram_pending p JOIN messages m ON m.rowid=p.row_id WHERE p.kind='messages' ORDER BY p.row_id LIMIT ${batchSize}`,
          );
          const chunks =
            messages.length < batchSize
              ? yield* all(PendingChunk)(
                  sql`SELECT p.row_id,d.text FROM search_bigram_pending p JOIN derived_chunks d ON d.id=p.row_id WHERE p.kind='derived' ORDER BY p.row_id LIMIT ${batchSize - messages.length}`,
                )
              : [];
          // Rows of long CJK text take milliseconds each to tokenize and insert, and the
          // transaction holds the shared connection. Stop once the batch has written about
          // BIGRAM_BATCH_TOKENS characters of tokens; the rest stay queued.
          let written = 0;
          let cut = false;
          const indexed: (typeof messages)[number][] = [];
          for (const row of messages) {
            if (written >= BIGRAM_BATCH_TOKENS) {
              cut = true;
              break;
            }
            indexed.push(row);
            const columns = [row.subject, row.from_name, row.from_addr, row.body_text].map(
              bigramText,
            );
            written += columns.reduce((sum, text) => sum + text.length, 0);
            yield* run(sql`DELETE FROM messages_bigrams WHERE rowid=${row.row_id}`);
            if (columns.some(Boolean))
              yield* run(
                sql`INSERT INTO messages_bigrams(rowid,subject,from_name,from_addr,body_text) VALUES(${row.row_id},${columns[0] ?? ""},${columns[1] ?? ""},${columns[2] ?? ""},${columns[3] ?? ""})`,
              );
          }
          const indexedChunks: (typeof chunks)[number][] = [];
          for (const row of chunks) {
            if (cut || written >= BIGRAM_BATCH_TOKENS) {
              cut = true;
              break;
            }
            indexedChunks.push(row);
            const text = bigramText(row.text);
            written += text.length;
            yield* run(sql`DELETE FROM derived_bigrams WHERE rowid=${row.row_id}`);
            if (text)
              yield* run(
                sql`INSERT INTO derived_bigrams(rowid,text) VALUES(${row.row_id},${text})`,
              );
          }
          const done = [
            ...indexed.map((row) => ["messages", row.row_id] as const),
            ...indexedChunks.map((row) => ["derived", row.row_id] as const),
          ];
          if (done.length)
            yield* run(
              sql`DELETE FROM search_bigram_pending WHERE (kind,row_id) IN (SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(${JSON.stringify(done)}))`,
            );
          return { processed: done.length, ready: !cut && done.length < batchSize };
        }),
      )
      .pipe(Effect.orDie);
  const OperatorTextProgress = Schema.Struct({
    cursor: Schema.Int,
    end_rowid: Schema.Int,
    ready: Schema.BooleanFromBit,
  });
  const operatorTextProgress = all(OperatorTextProgress)(
    sql`SELECT cursor,end_rowid,ready FROM message_operator_text_backfill`,
  );
  /** True once every message from before migration 57 has its message_operator_text row. */
  const operatorTextReady = operatorTextProgress.pipe(
    Effect.map((rows) => rows.every((row) => row.ready)),
  );
  /**
   * Writes message_operator_text for messages stored before migration 57, in committed rowid
   * ranges. Rows inserted or changed since then have theirs from the triggers; rewriting one
   * gives the same text.
   */
  const backfillOperatorText = (requested = 200) =>
    Effect.gen(function* () {
      if (yield* operatorTextReady) return { processed: 0, ready: true };
      return yield* backfillOperatorTextBatch(requested);
    });
  const backfillOperatorTextBatch = (requested: number) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const batchSize = Math.min(Math.max(Math.floor(requested), 1), 2000);
          const pending = (yield* operatorTextProgress).find((row) => !row.ready);
          if (!pending) return { processed: 0, ready: true };
          const rows = yield* all(Schema.Struct({ row_id: Schema.Int }))(
            sql`SELECT rowid AS row_id FROM messages WHERE rowid>${pending.cursor} AND rowid<=${pending.end_rowid} ORDER BY rowid LIMIT ${batchSize}`,
          );
          const end = rows.at(-1)?.row_id ?? pending.end_rowid;
          yield* run(sql`INSERT OR REPLACE INTO message_operator_text(row_id,to_text,cc_text,file_text,list_id_text,list_post_text)
            SELECT m.rowid,${sql.literal(operatorTextValues("m"))}
            FROM messages m WHERE m.rowid>${pending.cursor} AND m.rowid<=${end}`);
          const ready = end >= pending.end_rowid;
          yield* run(
            sql`UPDATE message_operator_text_backfill SET cursor=${end},ready=${ready ? 1 : 0}`,
          );
          return { processed: rows.length, ready };
        }),
      )
      .pipe(Effect.orDie);
  return {
    wordIndexReady,
    backfillWordIndex,
    backfillSearchFlags,
    indexBigrams,
    operatorTextReady,
    backfillOperatorText,
  };
}

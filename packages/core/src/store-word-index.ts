import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { BACKFILL_SEARCH_FLAGS } from "./db.js";
import { all, run } from "./sql-rows.js";

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
  const backfillWordIndex = (requested = 200) =>
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
          if (pending.kind === "messages") {
            yield* run(sql`INSERT INTO messages_words(rowid,subject,from_name,from_addr,body_text)
        SELECT m.rowid,m.subject,m.from_name,m.from_addr,m.body_text FROM messages m WHERE m.rowid>${pending.cursor} AND m.rowid<=${end} AND NOT EXISTS(SELECT 1 FROM search_word_rows r WHERE r.kind='messages' AND r.row_id=m.rowid)`);
            yield* run(
              sql`INSERT OR IGNORE INTO search_word_rows(kind,row_id) SELECT 'messages',rowid FROM messages WHERE rowid>${pending.cursor} AND rowid<=${end}`,
            );
          } else {
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
  return { wordIndexReady, backfillWordIndex, backfillSearchFlags };
}

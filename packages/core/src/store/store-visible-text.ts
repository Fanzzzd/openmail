import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import type { DatabaseBusy } from "../domain/errors.js";
import type { HtmlText } from "../platform/html-text.js";
import { all, run } from "./sql-rows.js";

/**
 * Bodies one fill step computes before it writes. A body takes 10-30 ms on the worker, so a step
 * holds the write lock only for its short write, about once every half second.
 */
export const VISIBLE_TEXT_BATCH = 20;

const PendingBody = Schema.Struct({
  row_id: Schema.Int,
  version: Schema.String,
  body_text: Schema.String,
  body_html: Schema.String,
});

export interface VisibleTextRow {
  readonly row_id: number;
  readonly version: string;
  readonly text: string;
}

/**
 * Search's visible text per message (migration 58). Triggers queue new and changed HTML bodies;
 * `fill` computes queued ones on the HtmlText worker and stores them. A body that changed while
 * its text was computed has a newer version in the queue, so `save` skips it and it stays queued.
 */
export function makeVisibleTextStore(
  sql: SqlClient.SqlClient,
  htmlText: HtmlText,
  briefLockWait: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | DatabaseBusy, R>,
) {
  const save = (rows: readonly VisibleTextRow[]) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const json = JSON.stringify(rows.map((row) => [row.row_id, row.version, row.text]));
          yield* run(sql`INSERT OR REPLACE INTO message_visible_text(row_id,text)
            SELECT p.row_id,json_extract(j.value,'$[2]') FROM json_each(${json}) j
            JOIN message_visible_text_pending p ON p.row_id=json_extract(j.value,'$[0]') AND p.version=json_extract(j.value,'$[1]')`);
          yield* run(sql`DELETE FROM message_visible_text_pending WHERE (row_id,version) IN
            (SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(${json}))`);
        }),
      )
      .pipe(Effect.orDie);

  /**
   * Computes and stores up to `requested` queued bodies, newest first: new mail is what a search
   * is most likely to show. Reads and computes without holding the connection; only the write
   * takes the lock, and waits for another process's lock briefly.
   */
  const fill = (requested = VISIBLE_TEXT_BATCH) =>
    Effect.gen(function* () {
      const limit = Math.min(Math.max(Math.floor(requested), 1), 200);
      // Keep the bounded queue as the outer loop, including when it is empty. Without CROSS
      // JOIN SQLite sometimes walked every messages row: 0.3-1.2 s on the 100k fixture.
      const rows = yield* all(PendingBody)(
        sql`SELECT p.row_id,p.version,m.body_text,m.body_html FROM message_visible_text_pending p
          CROSS JOIN messages m ON m.rowid=p.row_id ORDER BY p.row_id DESC LIMIT ${limit}`,
      ).pipe(Effect.orDie);
      if (rows.length === 0) return { processed: 0, ready: true };
      const texts = yield* Effect.forEach(
        rows,
        (row) => htmlText.visibleText(row.body_text, row.body_html),
        { concurrency: 2 },
      );
      yield* briefLockWait(
        save(
          rows.map((row, i) => ({
            row_id: row.row_id,
            version: row.version,
            text: texts[i] ?? "",
          })),
        ),
      );
      // A body may have changed or arrived while the worker was computing. Only stop when
      // the queue is empty now, not merely when the earlier read returned a short batch.
      const pending = yield* all(Schema.Struct({ row_id: Schema.Int }))(
        sql`SELECT row_id FROM message_visible_text_pending LIMIT 1`,
      ).pipe(Effect.orDie);
      return { processed: rows.length, ready: pending.length === 0 };
    });

  const pendingCount = all(Schema.Struct({ n: Schema.Int }))(
    sql`SELECT COUNT(*) AS n FROM message_visible_text_pending`,
  ).pipe(
    Effect.orDie,
    Effect.map((rows) => rows[0]?.n ?? 0),
  );

  return { fillVisibleText: fill, visibleTextPending: pendingCount };
}

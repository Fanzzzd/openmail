import { categoryKey } from "../domain/categories.js";
import { Clock, Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { MailOp, UndoHistoryEntry, UNDO_HISTORY_TTL_MS } from "../domain/domain.js";
import { all, first, run } from "../sql-rows.js";

export const UndoChange = Schema.Struct({ id: Schema.String, op: MailOp });
export const UndoState = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  labels: Schema.Array(Schema.String),
  isUnread: Schema.Boolean,
  isStarred: Schema.Boolean,
});
export const UndoJournal = Schema.Struct({
  changes: Schema.Array(UndoChange),
  expected: Schema.Array(UndoState),
  localExpected: Schema.Array(UndoState),
  localChanges: Schema.optionalKey(Schema.Array(UndoChange)),
});
export type UndoJournal = typeof UndoJournal.Type;
export const undoStateKey = (
  state: Pick<typeof UndoState.Type, "labels" | "isUnread" | "isStarred">,
) =>
  JSON.stringify([
    state.labels
      .filter((label) => !["UNREAD", "STARRED", "SNOOZED"].includes(label))
      .map((label) =>
        label.startsWith("category:") ? `category:${categoryKey(label.slice(9))}` : label,
      )
      .toSorted(),
    state.isUnread,
    state.isStarred,
  ]);

export function makeUndoStore(sql: SqlClient.SqlClient) {
  return {
    undoHistory: Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      return yield* all(UndoHistoryEntry)(
        sql`SELECT id AS undoId,created_at AS createdAt FROM undo_batches WHERE created_at>=${now - UNDO_HISTORY_TTL_MS} ORDER BY rowid DESC LIMIT 50`,
      );
    }),
    undoJournal: (id: string) =>
      first(
        Schema.Struct({ payload: Schema.fromJsonString(UndoJournal), createdAt: Schema.Number }),
      )(sql`SELECT payload,created_at AS createdAt FROM undo_batches WHERE id=${id}`).pipe(
        Effect.map((row) =>
          row._tag === "Some"
            ? { ...row.value.payload, createdAt: row.value.createdAt }
            : undefined,
        ),
      ),
    saveUndoJournal: (id: string, journal: UndoJournal) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            // Schema encoding drops any incidental fields from callers at this storage boundary.
            const payload = yield* Schema.encodeEffect(Schema.fromJsonString(UndoJournal))(journal);
            const now = yield* Clock.currentTimeMillis;
            yield* run(
              sql`INSERT INTO undo_batches(id,payload,created_at) VALUES(${id},${payload},${now})`,
            );
            yield* run(
              sql`DELETE FROM undo_batches WHERE rowid NOT IN (SELECT rowid FROM undo_batches ORDER BY rowid DESC LIMIT 50)`,
            );
          }),
        )
        .pipe(Effect.orDie),
    deleteUndoJournal: (id: string) => run(sql`DELETE FROM undo_batches WHERE id=${id}`),
  };
}

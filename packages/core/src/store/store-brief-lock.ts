import { Cause, Effect, Option, Schema } from "effect";
import { type SqlClient } from "effect/sql";
import { isSqlError } from "effect/sql/SqlError";
import { DatabaseBusy } from "../domain/errors.js";
import { first } from "./sql-rows.js";

/** How long a write under `briefLockWait` waits for another process's write lock. */
export const BRIEF_BUSY_TIMEOUT_MS = 200;
const BusyTimeout = Schema.Struct({ timeout: Schema.Number });

/**
 * Runs `effect` waiting at most BRIEF_BUSY_TIMEOUT_MS for another process's write lock, not the
 * connection's 5 s busy timeout. node:sqlite waits synchronously, so a 5 s wait froze the event
 * loop and every request of that process with it. The connection is reserved while its timeout
 * is lowered, so no other statement runs with the short one. A lock timeout, failed or died,
 * becomes DatabaseBusy.
 */
export const makeBriefLockWait = (sql: SqlClient.SqlClient) => {
  const reserve = Effect.gen(function* () {
    const conn = yield* Effect.orDie(sql.reserve);
    const timeout = yield* first(BusyTimeout)(
      conn.executeUnprepared("PRAGMA busy_timeout", [], undefined),
    );
    const previous = Option.match(timeout, { onNone: () => 5000, onSome: (row) => row.timeout });
    yield* Effect.orDie(
      conn.executeUnprepared(`PRAGMA busy_timeout = ${BRIEF_BUSY_TIMEOUT_MS}`, [], undefined),
    );
    return { conn, previous };
  });
  return <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | DatabaseBusy, R> =>
    Effect.scoped(
      Effect.flatMap(reserve, ({ conn, previous }) =>
        effect.pipe(
          // Statements run on the reserved connection. Depth -1 makes the next withTransaction
          // the outermost one, so it begins and commits on this connection.
          Effect.provideService(sql.transactionService, [conn, -1]),
          Effect.ensuring(
            Effect.orDie(
              conn.executeUnprepared(`PRAGMA busy_timeout = ${previous}`, [], undefined),
            ),
          ),
        ),
      ),
    ).pipe(
      Effect.catchCause((cause): Effect.Effect<never, E | DatabaseBusy> => {
        if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
        const error = Cause.squash(cause);
        return isSqlError(error) && error.reason._tag === "LockTimeoutError"
          ? Effect.fail(
              new DatabaseBusy({ message: "Another process is writing to the local database." }),
            )
          : Effect.failCause(cause);
      }),
    );
};

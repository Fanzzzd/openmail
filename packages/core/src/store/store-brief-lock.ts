import { Cause, Effect, Option, Schema } from "effect";
import { type SqlClient } from "effect/sql";
import { isSqlError } from "effect/sql/SqlError";
import { DatabaseBusy } from "../domain/errors.js";
import { first } from "./sql-rows.js";

/** A defect from a statement that waited the whole busy timeout for the write lock. */
export const isLockTimeout = (defect: unknown): boolean =>
  isSqlError(defect) && defect.reason._tag === "LockTimeoutError";

/** How long a write under `briefLockWait` waits for another process's write lock. */
export const BRIEF_BUSY_TIMEOUT_MS = 200;
const BusyTimeout = Schema.Struct({ timeout: Schema.Number });

/**
 * Runs `effect` waiting at most `timeoutMs` (BRIEF_BUSY_TIMEOUT_MS) for another process's write lock, not the
 * connection's 5 s busy timeout. node:sqlite waits synchronously, so a 5 s wait froze the event
 * loop and every request of that process with it. The connection is reserved while its timeout
 * is lowered, so no other statement runs with the short one. A lock timeout, failed or died,
 * becomes DatabaseBusy.
 *
 * Inside an open transaction `effect` runs as it is, on the transaction's connection and with its
 * busy timeout. The transaction holds the only connection, so reserving it would wait forever.
 */
export const makeBriefLockWait = (
  sql: SqlClient.SqlClient,
  timeoutMs: number = BRIEF_BUSY_TIMEOUT_MS,
) => {
  const reserve = Effect.gen(function* () {
    const conn = yield* Effect.orDie(sql.reserve);
    const timeout = yield* first(BusyTimeout)(
      conn.executeUnprepared("PRAGMA busy_timeout", [], undefined),
    );
    const previous = Option.match(timeout, { onNone: () => 5000, onSome: (row) => row.timeout });
    yield* Effect.orDie(
      conn.executeUnprepared(`PRAGMA busy_timeout = ${timeoutMs}`, [], undefined),
    );
    return { conn, previous };
  });
  const brief = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | DatabaseBusy, R> =>
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
        return isLockTimeout(error)
          ? Effect.fail(
              new DatabaseBusy({ message: "Another process is writing to the local database." }),
            )
          : Effect.failCause(cause);
      }),
    );
  return <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | DatabaseBusy, R> =>
    Effect.flatMap(Effect.serviceOption(sql.transactionService), (open) =>
      Option.isSome(open) ? effect : brief(effect),
    );
};

/**
 * Takes the write lock and gives it back at once, waiting at most BRIEF_BUSY_TIMEOUT_MS for it.
 * Fails with DatabaseBusy while another process holds it. Inside a transaction, which already
 * has the lock or waits with its own timeout, it does nothing.
 */
export const makeWriteLockProbe = (sql: SqlClient.SqlClient): Effect.Effect<void, DatabaseBusy> => {
  const take = Effect.acquireRelease(Effect.orDie(sql.unsafe("BEGIN IMMEDIATE")), () =>
    Effect.orDie(sql.unsafe("ROLLBACK")),
  );
  const probe = makeBriefLockWait(sql)(Effect.scoped(take));
  return Effect.flatMap(Effect.serviceOption(sql.transactionService), (open) =>
    Option.isSome(open) ? Effect.void : Effect.asVoid(probe),
  );
};

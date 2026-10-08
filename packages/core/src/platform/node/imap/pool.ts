import { Effect, Exit, Option, Scope } from "effect";
import type { Account } from "../../../domain.js";
import { imapSettingsKey } from "../../../imap-settings.js";
import { keyedLock } from "../../../provider-http.js";
import { Secrets, type ProviderAdapter } from "../../../services.js";
import type { HtmlText } from "../../html-text.js";
import { call, openImap, password, settingsOf, type Session } from "./session.js";
export const makeImapPool = (
  open: typeof openImap,
  secrets: Secrets["Service"],
  htmlText: HtmlText,
) => {
  const session = (account: Account) =>
    Effect.gen(function* () {
      const settings = yield* settingsOf(account);
      const pass = yield* password(secrets, account);
      const s: Session = { ...(yield* open(account.id, settings, pass)), htmlText };
      return { s, settings, pass };
    });

  return Effect.gen(function* () {
    const owner = yield* Effect.serviceOption(Scope.Scope);

    const pools = new Map<string, { scope: Scope.Closeable; session: Session; key: string }>();

    const lockFor = keyedLock(1);

    if (Option.isSome(owner))
      yield* Scope.addFinalizer(
        owner.value,
        Effect.suspend(() =>
          Effect.forEach(
            pools.values(),
            (pool) =>
              Effect.sync(() => pool.session.client.close()).pipe(
                Effect.andThen(Scope.close(pool.scope, Exit.void)),
              ),
            {
              discard: true,
            },
          ),
        ),
      );

    const pushSession = <A, E>(account: Account, work: (s: Session) => Effect.Effect<A, E>) => {
      const lock = lockFor(account.id);
      let active: ReturnType<typeof pools.get>;
      return Effect.gen(function* () {
        if (Option.isNone(owner))
          return yield* session(account).pipe(
            Effect.flatMap(({ s }) => work(s)),
            Effect.scoped,
          );
        const settings = yield* settingsOf(account);
        const key = imapSettingsKey(settings);
        let pool = pools.get(account.id);
        active = pool;
        if (pool?.key === key && pool.session.client.usable) {
          const alive = yield* call(pool.session, (client) => client.noop()).pipe(
            Effect.timeout("5 seconds"),
            Effect.result,
          );
          if (alive._tag === "Failure") {
            const stale = pool;
            yield* Effect.sync(() => stale.session.client.close());
            yield* Scope.close(stale.scope, Exit.void);
            pools.delete(account.id);
            pool = undefined;
          }
        }
        if (!pool || pool.key !== key || !pool.session.client.usable) {
          if (pool) {
            const stale = pool;
            yield* Effect.sync(() => stale.session.client.close());
            yield* Scope.close(stale.scope, Exit.void);
          }
          const scope = yield* Scope.make();
          const opened = yield* session(account).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.onError(() => Scope.close(scope, Exit.void)),
          );
          pool = { scope, session: opened.s, key };
          pools.set(account.id, pool);
        }
        active = pool;
        return yield* work(pool.session);
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            if (!active) return;
            const interrupted = active;
            if (pools.get(account.id) === interrupted) pools.delete(account.id);
            yield* Effect.sync(() => interrupted.session.client.close());
            yield* Scope.close(interrupted.scope, Exit.void);
          }),
        ),
        lock.withPermits(1),
      );
    };

    const closeSessions: NonNullable<ProviderAdapter["closeSessions"]> = (id) =>
      Effect.forEach(
        id ? [id] : [...pools.keys()],
        (accountId) =>
          Effect.gen(function* () {
            const pool = pools.get(accountId);
            if (pool) {
              pools.delete(accountId);
              yield* Effect.sync(() => pool.session.client.close());
              yield* Scope.close(pool.scope, Exit.void);
            }
          }).pipe(lockFor(accountId).withPermits(1)),
        { discard: true },
      );
    return { session, pushSession, closeSessions };
  });
};
export type ImapPool = Effect.Success<ReturnType<typeof makeImapPool>>;

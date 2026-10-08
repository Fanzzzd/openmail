import { Clock, Context, Effect, Option, Random, Schema } from "effect";
import { jittered } from "./backoff.js";
import { ProviderError } from "./errors.js";

export const BackgroundRead = Context.Reference<boolean>("openmail/BackgroundRead", {
  defaultValue: () => false,
});
const NetworkFailure = Schema.Struct({
  status: Schema.optionalKey(Schema.Number),
  deferred: Schema.optionalKey(Schema.Boolean),
});

export function makeProviderConnectivity() {
  const accounts = new Map<string, { failures: number; due: number }>();
  const check = (accountId: string) =>
    Effect.gen(function* () {
      const remaining = (accounts.get(accountId)?.due ?? 0) - (yield* Clock.currentTimeMillis);
      if (remaining > 0)
        yield* new ProviderError({
          message: "Network unavailable; retry deferred",
          status: 0,
          deferred: true,
          retryAfter: String(remaining / 1000),
        });
    });
  const failed = (accountId: string, error: unknown) =>
    Effect.gen(function* () {
      const failure = Option.getOrElse(
        Schema.decodeUnknownOption(NetworkFailure)(error),
        (): typeof NetworkFailure.Type => ({}),
      );
      const now = yield* Clock.currentTimeMillis;
      const previous = accounts.get(accountId);
      if (failure.status !== 0 || failure.deferred || (previous?.due ?? 0) > now) return;
      const failures = (previous?.failures ?? 0) + 1;
      accounts.set(accountId, {
        failures,
        due:
          now +
          jittered(Math.min(300_000, 5000 * 2 ** Math.min(failures - 1, 6)), yield* Random.next),
      });
    });
  return {
    run: <A, E, R>(accountId: string, effect: Effect.Effect<A, E, R>, background = true) =>
      (background ? check(accountId) : Effect.void).pipe(
        Effect.andThen(
          effect.pipe(
            Effect.tap(() => Effect.sync(() => accounts.delete(accountId))),
            Effect.tapError((error) => failed(accountId, error)),
          ),
        ),
      ),
    reset: Effect.sync(() => accounts.clear()),
  };
}

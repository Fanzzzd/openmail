import type { PerformError } from "./mailbox.js";
import { Clock, Effect, Schema } from "effect";
import type { ApiError } from "./provider-http.js";
import { AuthError, ProviderError, SendUncertain } from "./errors.js";

/** A negative result requires successful lookups unless the caller is confirming an uncertain send. */
export const pollDelivery = <E, R>(
  lookup: Effect.Effect<boolean, E, R>,
  options: {
    readonly delays: readonly number[];
    readonly timeout: number;
    readonly ignoreErrors?: boolean;
  },
) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    for (const delay of options.delays) {
      if (delay)
        yield* Effect.sleep(
          Math.min(
            delay,
            Math.max(0, options.timeout - ((yield* Clock.currentTimeMillis) - started)),
          ),
        );
      const remaining = Math.max(
        1000,
        options.timeout - ((yield* Clock.currentTimeMillis) - started),
      );
      const result = yield* lookup.pipe(Effect.timeout(remaining), Effect.result);
      if (result._tag === "Success") {
        if (result.success) return true;
      } else if (!options.ignoreErrors) return yield* Effect.fail(result.failure);
    }
    return false;
  });

/** Only re-check delivery. The submission itself is never repeated. */
export const confirmDelivery = <E, R>(lookup: Effect.Effect<boolean, E, R>) =>
  pollDelivery(lookup, {
    delays: [0, 1000, 2000, 4000, 8000, 15000],
    timeout: 30000,
    ignoreErrors: true,
  }).pipe(
    Effect.catch(() => Effect.succeed(false)),
    Effect.flatMap((found) =>
      found
        ? Effect.void
        : Effect.fail(
            new SendUncertain({
              message: "This message may have been sent. Check Sent before sending it again.",
            }),
          ),
    ),
  );

export function isDefiniteSendFailure(error: PerformError): boolean {
  // Adapters convert unconfirmed submissions to SendUncertain. Other errors
  // describe a rejected submission or preparation that failed before sending.
  return error._tag !== "SendUncertain";
}

/** Submit once, then only look for delivery after an ambiguous transport result. */
export const deliverOrConfirm = <A, E, R, E2, R2>(
  submission: Effect.Effect<A, E, R>,
  lookup: Effect.Effect<boolean, E2, R2>,
  uncertain: (error: E) => boolean,
) =>
  submission.pipe(Effect.catchIf(uncertain, () => confirmDelivery(lookup).pipe(Effect.as(null))));

/**
 * A per-user rate limit: 429, or the 403 Gmail and Google APIs send for rateLimitExceeded,
 * userRateLimitExceeded and the per-minute query cost quota. A daily quota is not one.
 */
export const isRateLimited = (status: number, body: string) =>
  status === 429 ||
  (status === 403 && /rate_?limit_?exceeded|totalQueryCostPerMinutePerUser/i.test(body));

/** Maps a failed call to what the op queue does next: sign in again, drop
 * the op, or retry later. Meaningful read 404s are handled by the caller. */
export const providerReadFailure =
  (provider: string) =>
  (accountId: string) =>
  (error: ApiError | AuthError | ProviderError): AuthError | ProviderError => {
    if (error._tag !== "ApiError") return error;
    const message = `${provider} API ${error.status}: ${error.body}`;
    if (error.status === 401) return new AuthError({ accountId, message });
    return new ProviderError({
      message,
      status: error.status,
      ...(error.requestNotSent
        ? { reason: "connection" }
        : isRateLimited(error.status, error.body)
          ? { reason: "quota" }
          : {}),
      ...(error.deferred ? { deferred: true } : {}),
      ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}),
    });
  };

export const providerDecode =
  (name: string) =>
  <A>(schema: Schema.Decoder<A>) =>
  (json: unknown): Effect.Effect<A, ProviderError> =>
    Schema.decodeUnknownEffect(schema)(json).pipe(
      Effect.mapError(
        (error) => new ProviderError({ message: `Unexpected ${name} response: ${error.message}` }),
      ),
    );

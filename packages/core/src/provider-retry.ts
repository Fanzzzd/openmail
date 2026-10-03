import { Effect, Schedule } from "effect";
import type { HttpClientRequest } from "effect/http";

export function isProviderSend(request: HttpClientRequest.HttpClientRequest): boolean {
  return (
    request.method === "POST" &&
    /\/(?:sendMail|messages\/send|messages\/[^/]+\/send)$/.test(new URL(request.url).pathname)
  );
}

/** A transport may disappear before delivering a response. Only GET can replay that request. */
export function retryProviderRequest<
  A,
  E extends { readonly _tag: string; readonly status?: number | undefined },
  R,
>(
  effect: Effect.Effect<A, E, R>,
  request: HttpClientRequest.HttpClientRequest,
  isTransient: (error: E) => boolean,
) {
  if (isProviderSend(request)) return effect;
  const responseRetries = effect.pipe(
    Effect.retry({
      schedule: Schedule.exponential("500 millis"),
      times: 4,
      while: (error) => error.status !== 0 && isTransient(error),
    }),
  );
  return request.method === "GET"
    ? responseRetries.pipe(
        Effect.retry({
          schedule: Schedule.spaced("500 millis"),
          times: 1,
          while: (error) => error.status === 0,
        }),
      )
    : responseRetries;
}

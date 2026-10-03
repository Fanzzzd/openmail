import { Clock, Effect } from "effect";
import type { HttpClientRequest } from "effect/http";

/** Retry-After may be delta seconds or an HTTP date. */
export function retryAfterMillis(value: string | undefined, now: number): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

export function retryProvider<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  transient: (error: E) => boolean,
  enabled = true,
): Effect.Effect<A, E, R> {
  return Effect.gen(function* () {
    let waited = 0;
    for (let attempt = 0; ; attempt++) {
      const result = yield* Effect.result(effect);
      if (result._tag === "Success") return result.success;
      if (!enabled || attempt >= 4 || !transient(result.failure))
        return yield* Effect.fail(result.failure);
      const now = yield* Clock.currentTimeMillis;
      const wait = retryAfterMillis(
        typeof result.failure === "object" &&
          result.failure !== null &&
          "retryAfter" in result.failure &&
          typeof result.failure.retryAfter === "string"
          ? result.failure.retryAfter
          : undefined,
        now,
      );
      const delay = Math.max(500 * 2 ** attempt, wait);
      if (waited + delay > 60000) return yield* Effect.fail(result.failure);
      waited += delay;
      yield* Effect.sleep(delay);
    }
  });
}

export function isProviderSend(request: HttpClientRequest.HttpClientRequest): boolean {
  return (
    request.method === "POST" &&
    /\/(?:sendMail|messages\/send|messages\/[^/]+\/send)$/.test(new URL(request.url).pathname)
  );
}

export function retryProviderRequest<
  A,
  E extends { readonly _tag: string; readonly status?: number },
  R,
>(
  effect: Effect.Effect<A, E, R>,
  request: HttpClientRequest.HttpClientRequest,
  transient: (error: E) => boolean,
) {
  if (
    isProviderSend(request) ||
    (request.method === "POST" &&
      /\/(?:createReply|createReplyAll|createForward)$/.test(new URL(request.url).pathname))
  )
    return effect;
  return Effect.suspend(() => {
    let transports = 0;
    return retryProvider(effect, (error) =>
      error.status === 0 ? request.method === "GET" && transports++ < 1 : transient(error),
    );
  });
}

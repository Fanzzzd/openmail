import { Clock, Effect } from "effect";
import type { HttpClientRequest } from "effect/http";
import { ProviderError } from "./errors.js";

/**
 * Token refresh holds the adapter's refresh lock, which every request waits on. A stalled
 * token endpoint fails as offline (status 0), never as an expired sign-in.
 */
export const tokenTimeout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.timeoutOrElse(effect, {
    duration: "60 seconds",
    orElse: () =>
      Effect.fail(new ProviderError({ message: "Token endpoint timed out", status: 0 })),
  });

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
  const url = new URL(request.url);
  // Only explicitly idempotent POST actions can be replayed. Creates and
  // calendar responses may already have succeeded when their response is lost.
  const nonIdempotent =
    (request.method === "POST" && !/\/(?:modify|batchModify|trash|untrash)$/.test(url.pathname)) ||
    (request.method === "PATCH" && url.searchParams.get("sendUpdates") === "all");
  return Effect.suspend(() => {
    let transports = 0;
    return retryProvider(effect, (error) =>
      nonIdempotent
        ? error.status === 429
        : error.status === 0
          ? request.method === "GET" && transports++ < 1
          : transient(error),
    );
  });
}

export function uncertainWrite(error: {
  readonly status?: number | undefined;
  readonly requestNotSent?: boolean | undefined;
}): boolean {
  return (
    (error.status === 0 && !error.requestNotSent) ||
    (error.status !== undefined && error.status >= 500)
  );
}

/** Only errors that establish failure before connecting are definite failures. */
export function requestNotSent(cause: unknown): boolean {
  let current = cause;
  for (let depth = 0; depth < 6; depth++) {
    if (typeof current !== "object" || current === null) return false;
    if (
      "code" in current &&
      typeof current.code === "string" &&
      [
        "ENOTFOUND",
        "EAI_AGAIN",
        "ECONNREFUSED",
        "ENETUNREACH",
        "EHOSTUNREACH",
        "UND_ERR_CONNECT_TIMEOUT",
      ].includes(current.code)
    )
      return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

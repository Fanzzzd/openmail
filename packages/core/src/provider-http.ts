import { Clock, Data, Effect, Option, Semaphore } from "effect";
import { HttpClientRequest, type HttpClient } from "effect/http";
import { AuthError, ProviderError } from "./errors.js";
import type { OAuth, Secrets } from "./services.js";
import {
  isProviderSend,
  requestNotSent,
  retryAfterMillis,
  retryProviderRequest,
} from "./provider-retry.js";

/** A non-2xx response, or a transport failure as status 0, before it becomes a ProviderFailure. */
export class ApiError extends Data.TaggedError("ApiError")<{
  status: number;
  body: string;
  retryAfter?: string;
  deferred?: boolean;
  requestNotSent?: boolean;
}> {}

/** Lazily allocate an independent semaphore for each account. */
export function keyedLock(permits: number) {
  const locks = new Map<string, Semaphore.Semaphore>();
  return (key: string) => {
    let lock = locks.get(key);
    if (!lock) {
      lock = Semaphore.makeUnsafe(permits);
      locks.set(key, lock);
    }
    return lock;
  };
}

interface ProviderHttpOptions {
  http: HttpClient.HttpClient;
  secrets: Secrets["Service"];
  tokenLabel: string;
  refresh: (accountId: string, refreshToken: string) => ReturnType<OAuth["Service"]["refresh"]>;
  throttleReads: boolean;
  prepareRequest: (
    request: HttpClientRequest.HttpClientRequest,
  ) => HttpClientRequest.HttpClientRequest;
  parseResponse: (
    text: string,
    contentType: string | undefined,
    request: HttpClientRequest.HttpClientRequest,
  ) => unknown;
  isTransient: (error: ApiError) => boolean;
}

/** Access tokens are cached in memory; refresh tokens remain in Secrets. */
export const makeProviderHttp = (options: ProviderHttpOptions) =>
  Effect.gen(function* () {
    const { http, secrets } = options;
    const tokens = new Map<string, { token: string; expiresAt: number }>();
    const refreshLock = yield* Semaphore.make(1);
    const accessToken = (accountId: string): Effect.Effect<string, AuthError | ProviderError> =>
      refreshLock.withPermits(1)(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const cached = tokens.get(accountId);
          if (cached && cached.expiresAt > now + 60_000) return cached.token;
          const refreshToken = yield* secrets.get(accountId);
          if (Option.isNone(refreshToken)) {
            return yield* new AuthError({
              accountId,
              message: `No ${options.tokenLabel} refresh token; sign in again`,
            });
          }
          const res = yield* options.refresh(accountId, refreshToken.value);
          tokens.set(accountId, { token: res.accessToken, expiresAt: now + res.expiresIn * 1000 });
          return res.accessToken;
        }),
      );

    const readRetryAt = new Map<string, number>();
    const checkReadDeadline = (accountId: string, sending = false) =>
      Effect.gen(function* () {
        const remaining = (readRetryAt.get(accountId) ?? 0) - (yield* Clock.currentTimeMillis);
        if (options.throttleReads && !sending && remaining > 0)
          yield* new ApiError({
            status: 429,
            body: "Account reads deferred",
            deferred: true,
            retryAfter: String(remaining / 1000),
          });
      });
    const throttleReads = (
      accountId: string,
      status: number,
      retryAfter: string | undefined,
      sending = false,
    ) =>
      Effect.gen(function* () {
        if (!options.throttleReads || sending || !retryAfter || (status !== 429 && status < 500))
          return;
        const now = yield* Clock.currentTimeMillis;
        readRetryAt.set(
          accountId,
          Math.max(readRetryAt.get(accountId) ?? 0, now + retryAfterMillis(retryAfter, now)),
        );
      });

    /** Sends one request with retries; resolves to the parsed JSON body, or null for 202/204. */
    const execute = (
      token: string,
      request: HttpClientRequest.HttpClientRequest,
      accountId?: string,
      sending = false,
    ) =>
      retryProviderRequest(
        Effect.gen(function* () {
          if (accountId !== undefined) yield* checkReadDeadline(accountId, sending);
          const res = yield* http.execute(
            options.prepareRequest(HttpClientRequest.bearerToken(request, token)),
          );
          if (accountId !== undefined)
            yield* throttleReads(accountId, res.status, res.headers["retry-after"], sending);
          const text = yield* res.text;
          if (res.status < 200 || res.status >= 300) {
            return yield* new ApiError({
              status: res.status,
              body: text,
              deferred:
                retryAfterMillis(res.headers["retry-after"], yield* Clock.currentTimeMillis) >
                60000,
              ...(res.headers["retry-after"] ? { retryAfter: res.headers["retry-after"] } : {}),
            });
          }
          if (!text) return null;
          return yield* Effect.try({
            try: (): unknown => options.parseResponse(text, res.headers["content-type"], request),
            catch: () => new ApiError({ status: res.status, body: "response is not JSON" }),
          });
        }).pipe(
          Effect.catchTag("HttpClientError", (e) =>
            Effect.fail(
              new ApiError({
                status: 0,
                body: e.message,
                requestNotSent: requestNotSent(e.reason.cause),
              }),
            ),
          ),
        ),
        request,
        options.isTransient,
      );

    const retryUnauthorized = <A, E, R>(
      accountId: string,
      request: HttpClientRequest.HttpClientRequest,
      attempt: Effect.Effect<A, E, R>,
      retry: () => Effect.Effect<A, E, R>,
    ) =>
      attempt.pipe(
        Effect.catchIf(
          (error) => error instanceof ApiError && error.status === 401 && !isProviderSend(request),
          () =>
            Effect.sync(() => tokens.delete(accountId)).pipe(Effect.andThen(Effect.suspend(retry))),
        ),
      );
    const authorized = (
      accountId: string,
      request: HttpClientRequest.HttpClientRequest,
      sending = false,
    ) =>
      retryUnauthorized(
        accountId,
        request,
        Effect.gen(function* () {
          yield* checkReadDeadline(accountId, sending);
          return yield* accessToken(accountId);
        }).pipe(Effect.flatMap((token) => execute(token, request, accountId, sending))),
        () =>
          accessToken(accountId).pipe(
            Effect.flatMap((token) => execute(token, request, accountId, sending)),
          ),
      );
    const invalidateRejectedToken = (
      accountId: string,
      error: ApiError | AuthError | ProviderError,
    ) =>
      error._tag === "ApiError" && error.status === 401
        ? Effect.sync(() => tokens.delete(accountId))
        : Effect.void;
    return {
      tokens,
      accessToken,
      execute,
      authorized,
      invalidateRejectedToken,
      retryUnauthorized,
      readRetryAt,
      checkReadDeadline,
      throttleReads,
    };
  });

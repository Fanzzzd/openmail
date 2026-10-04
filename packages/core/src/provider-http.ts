import { Clock, Data, Effect, Option, Semaphore, Stream } from "effect";
import {
  HttpClientRequest,
  type HttpClient,
  type HttpClientError,
  type HttpClientResponse,
} from "effect/http";
import { MEDIA_RAW_TOO_LARGE } from "./attachments.js";
import { AuthError, PermanentError, ProviderError } from "./errors.js";
import { Buffer } from "./platform/bytes.js";
import { BackgroundRead, makeProviderConnectivity } from "./provider-connectivity.js";
import { makeOptionalPermissions } from "./provider-diagnostics.js";
import {
  isProviderSend,
  requestNotSent,
  retryAfterMillis,
  retryProviderRequest,
} from "./provider-retry.js";
import type { OAuth, Secrets } from "./services.js";

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
  concurrency: number;
  serializeSend: boolean;
  sending: (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<boolean>;
  background: (request: HttpClientRequest.HttpClientRequest) => boolean;
  permits: (request: HttpClientRequest.HttpClientRequest) => number;
  logFailure: (
    accountId: string,
    request: HttpClientRequest.HttpClientRequest,
    error: ApiError | AuthError | ProviderError | PermanentError,
    body: "json" | "bytes",
  ) => Effect.Effect<void>;
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
    // Refresh is serialized because Graph rotates refresh tokens. Parallel
    // refreshes would race to save the replacement in the keychain.
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

    const connectivity = makeProviderConnectivity();
    const permissions = makeOptionalPermissions<ApiError | AuthError | ProviderError>();
    const requestLock = keyedLock(options.concurrency);
    const sendLock = keyedLock(1);
    const responseFailure = (
      res: HttpClientResponse.HttpClientResponse,
      body: string,
      deferred: boolean,
    ) =>
      Effect.gen(function* () {
        return yield* new ApiError({
          status: res.status,
          body,
          ...(deferred
            ? {
                deferred:
                  retryAfterMillis(res.headers["retry-after"], yield* Clock.currentTimeMillis) >
                  60000,
              }
            : {}),
          ...(res.headers["retry-after"] ? { retryAfter: res.headers["retry-after"] } : {}),
        });
      });
    const transport = <A, E extends ApiError | PermanentError | HttpClientError.HttpClientError>(
      token: string,
      request: HttpClientRequest.HttpClientRequest,
      reader: (res: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, E>,
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
          return yield* reader(res);
        }).pipe(
          Effect.catchTag("HttpClientError", (error) =>
            Effect.fail(
              new ApiError({
                status: 0,
                body: error.message,
                requestNotSent: requestNotSent(error.reason.cause),
              }),
            ),
          ),
        ),
        request,
        (error) => error instanceof ApiError && options.isTransient(error),
      );
    const execute = (
      token: string,
      request: HttpClientRequest.HttpClientRequest,
      accountId?: string,
      sending = false,
    ) =>
      transport(
        token,
        request,
        (res) =>
          Effect.gen(function* () {
            const text = yield* res.text;
            if (res.status < 200 || res.status >= 300)
              return yield* responseFailure(res, text, true);
            if (!text) return null;
            return yield* Effect.try({
              try: (): unknown => options.parseResponse(text, res.headers["content-type"], request),
              catch: () => new ApiError({ status: res.status, body: "response is not JSON" }),
            });
          }),
        accountId,
        sending,
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
    const api = (accountId: string, request: HttpClientRequest.HttpClientRequest) =>
      Effect.gen(function* () {
        const sending = yield* options.sending(request);
        const background = yield* BackgroundRead;
        const guarded = connectivity.run(
          accountId,
          permissions.run(
            accountId,
            request,
            authorized(accountId, request, sending).pipe(
              Effect.tapError((error) => options.logFailure(accountId, request, error, "json")),
              Effect.tapError((error) => invalidateRejectedToken(accountId, error)),
            ),
          ),
          background && !sending && options.background(request),
        );
        if (sending && !options.serializeSend) return yield* guarded;
        return yield* (sending ? sendLock(accountId) : requestLock(accountId)).withPermits(
          options.permits(request),
        )(guarded);
      });
    /** Read MIME or attachment bytes with the existing streaming limit and retry policy. */
    const readBytes = (
      accountId: string,
      request: HttpClientRequest.HttpClientRequest,
      maxBytes?: number,
    ) => {
      const attempt = Effect.flatMap(BackgroundRead, (background) =>
        connectivity.run(
          accountId,
          accessToken(accountId).pipe(
            Effect.flatMap((token) =>
              transport(
                token,
                request,
                (res) =>
                  Effect.gen(function* () {
                    if (res.status < 200 || res.status >= 300)
                      return yield* responseFailure(res, yield* res.text, false);
                    if (maxBytes === undefined) return new Uint8Array(yield* res.arrayBuffer);
                    if (Number(res.headers["content-length"]) > maxBytes)
                      return yield* new PermanentError({ message: MEDIA_RAW_TOO_LARGE });
                    const parts: Uint8Array[] = [];
                    let total = 0;
                    yield* res.stream.pipe(
                      Stream.runForEach((part) =>
                        Effect.gen(function* () {
                          total += part.length;
                          if (total > maxBytes)
                            return yield* new PermanentError({ message: MEDIA_RAW_TOO_LARGE });
                          parts.push(part);
                          return yield* Effect.void;
                        }),
                      ),
                    );
                    return new Uint8Array(Buffer.concat(parts));
                  }),
                accountId,
              ).pipe(requestLock(accountId).withPermits(1)),
            ),
          ),
          background,
        ),
      );
      return retryUnauthorized(accountId, request, attempt, () => attempt).pipe(
        Effect.tapError((error) => options.logFailure(accountId, request, error, "bytes")),
      );
    };
    const deferReads = (accountId: string, delayMs: number) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        readRetryAt.set(accountId, Math.max(readRetryAt.get(accountId) ?? 0, now + delayMs));
      });
    const clearTokens = () => {
      tokens.clear();
      permissions.clear();
    };
    return { api, execute, readBytes, deferReads, clearTokens, connectivity };
  });

import { Clock, Data, Effect, Option, Semaphore, Stream } from "effect";
import {
  HttpClientError,
  HttpClientRequest,
  type HttpClient,
  type HttpClientResponse,
} from "effect/http";
import { MEDIA_RAW_TOO_LARGE } from "./attachments.js";
import { AuthError, PermanentError, ProviderError } from "./errors.js";
import { Buffer } from "./platform/bytes.js";
import { TextDecoder } from "./platform/text-decoder.js";
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

/**
 * A proxy can accept the connection and then go silent. Response headers and each body
 * chunk must arrive within this window, or the attempt fails like a dropped connection.
 */
const STALL_TIMEOUT_MS = 60_000;
/** Bodies on a fetch without readable streams can only be bounded as a whole. */
const WHOLE_BODY_TIMEOUT_MS = 300_000;

/** Time to move `bytes` at 20 KiB/s, the slowest link a transfer is allowed. */
export const transferAllowance = (bytes: number) => Math.ceil(bytes / (20 * 1024)) * 1000;

/**
 * fetch does not report when the request body is sent, so the header wait also covers the
 * upload: a 25 MB send on a slow link must not end as SendUncertain.
 */
const headerTimeout = (request: HttpClientRequest.HttpClientRequest) =>
  STALL_TIMEOUT_MS +
  transferAllowance(request.body._tag === "Uint8Array" ? request.body.body.byteLength : 0);

const stalled = () =>
  new ApiError({ status: 0, body: "The server stopped responding; the request timed out" });
const withinStall = <A, E, R>(effect: Effect.Effect<A, E, R>, duration: number) =>
  Effect.timeoutOrElse(effect, { duration, orElse: () => Effect.fail(stalled()) });
/**
 * Passes each body chunk to `onChunk` and fails when none arrives for the stall window.
 * An empty body, or a fetch without readable streams (React Native), is read whole: at least
 * five minutes, longer when Content-Length says the body needs it at 20 KiB/s.
 */
const readBody = <E, R>(
  res: HttpClientResponse.HttpClientResponse,
  onChunk: (part: Uint8Array) => Effect.Effect<void, E, R>,
) =>
  Effect.gen(function* () {
    let last = yield* Clock.currentTimeMillis;
    // One timer per window instead of one per chunk.
    const watchdog = Effect.gen(function* () {
      for (;;) {
        const idle = (yield* Clock.currentTimeMillis) - last;
        if (idle >= STALL_TIMEOUT_MS) return yield* stalled();
        yield* Effect.sleep(STALL_TIMEOUT_MS - idle);
      }
    });
    yield* res.stream.pipe(
      Stream.runForEach((part) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) => {
            last = now;
            return onChunk(part);
          }),
        ),
      ),
      Effect.raceFirst(watchdog),
      Effect.catchIf(
        (error) =>
          error instanceof HttpClientError.HttpClientError &&
          error.reason._tag === "EmptyBodyError",
        () =>
          withinStall(
            res.arrayBuffer.pipe(Effect.flatMap((bytes) => onChunk(new Uint8Array(bytes)))),
            Math.max(
              WHOLE_BODY_TIMEOUT_MS,
              STALL_TIMEOUT_MS + transferAllowance(Number(res.headers["content-length"]) || 0),
            ),
          ),
      ),
    );
  });
const bodyText = (res: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function* () {
    const parts: Uint8Array[] = [];
    yield* readBody(res, (part) => Effect.sync(() => parts.push(part)));
    return new TextDecoder().decode(Buffer.concat(parts));
  });

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
          const prepared = options.prepareRequest(HttpClientRequest.bearerToken(request, token));
          const res = yield* withinStall(http.execute(prepared), headerTimeout(prepared));
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
            const text = yield* bodyText(res);
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
    /** Consume a byte response under the account's auth, concurrency and retry policy. */
    const readContent = <A>(
      accountId: string,
      request: HttpClientRequest.HttpClientRequest,
      consume: (
        res: HttpClientResponse.HttpClientResponse,
      ) => Effect.Effect<A, ApiError | PermanentError | HttpClientError.HttpClientError>,
    ) => {
      const attempt = Effect.gen(function* () {
        const background = yield* BackgroundRead;
        const sending = yield* options.sending(request);
        return yield* connectivity.run(
          accountId,
          accessToken(accountId).pipe(
            Effect.flatMap((token) =>
              transport(
                token,
                request,
                (res) =>
                  Effect.gen(function* () {
                    if (res.status < 200 || res.status >= 300)
                      return yield* responseFailure(res, yield* bodyText(res), false);
                    return yield* consume(res);
                  }),
                accountId,
                sending,
              ).pipe((sending ? sendLock(accountId) : requestLock(accountId)).withPermits(1)),
            ),
          ),
          background && !sending,
        );
      });
      return retryUnauthorized(accountId, request, attempt, () => attempt).pipe(
        Effect.tapError((error) => options.logFailure(accountId, request, error, "bytes")),
      );
    };
    /** Read MIME or attachment bytes with the existing streaming limit and retry policy. */
    const readBytes = (
      accountId: string,
      request: HttpClientRequest.HttpClientRequest,
      maxBytes?: number,
    ) =>
      readContent(accountId, request, (res) =>
        Effect.gen(function* () {
          if (Number(res.headers["content-length"]) > (maxBytes ?? Infinity))
            return yield* new PermanentError({ message: MEDIA_RAW_TOO_LARGE });
          const parts: Uint8Array[] = [];
          let total = 0;
          const add = (part: Uint8Array) =>
            Effect.gen(function* () {
              total += part.length;
              if (maxBytes !== undefined && total > maxBytes)
                return yield* new PermanentError({ message: MEDIA_RAW_TOO_LARGE });
              parts.push(part);
              return yield* Effect.void;
            });
          yield* readBody(res, add);
          return new Uint8Array(Buffer.concat(parts));
        }),
      );
    const matchesBytes = (
      accountId: string,
      request: HttpClientRequest.HttpClientRequest,
      size: number,
      range: (start: number, length: number) => Uint8Array,
    ) =>
      readContent(accountId, request, (res) =>
        Effect.gen(function* () {
          const state = { offset: 0, equal: true };
          yield* readBody(res, (part) =>
            Effect.sync(() => {
              if (state.offset + part.length > size) state.equal = false;
              if (state.equal) {
                for (let start = 0; state.equal && start < part.length; start += 64 * 1024) {
                  const slice = part.subarray(start, start + 64 * 1024);
                  const expected = range(state.offset + start, slice.length);
                  state.equal = slice.every((byte, i) => expected[i] === byte);
                }
              }
              state.offset += part.length;
            }),
          );
          return state.equal && state.offset === size;
        }),
      );
    const deferReads = (accountId: string, delayMs: number) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        readRetryAt.set(accountId, Math.max(readRetryAt.get(accountId) ?? 0, now + delayMs));
      });
    const clearTokens = () => {
      tokens.clear();
      permissions.clear();
    };
    return { api, execute, readBytes, matchesBytes, deferReads, clearTokens, connectivity };
  });

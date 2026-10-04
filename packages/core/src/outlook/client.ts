import { Effect, Option, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { MEDIA_RAW_TOO_LARGE } from "../attachments.js";
import type { Account } from "../domain.js";
import {
  AuthError,
  ClientNotConfigured,
  InvalidInput,
  PermanentError,
  ProviderError,
} from "../errors.js";
import { type DeleteFolder } from "../folder-actions.js";
import { OPTIONAL_SCOPES } from "../optional-services.js";
import { Buffer } from "../platform/bytes.js";
import { MailCodec } from "../platform/mail-codec.js";
import { BackgroundRead, makeProviderConnectivity } from "../provider-connectivity.js";
import {
  graphSearchErrorCode,
  logProviderFailure,
  makeOptionalPermissions,
} from "../provider-diagnostics.js";
import { ApiError, keyedLock, makeProviderHttp } from "../provider-http.js";
import { graphPages } from "../provider-pages.js";
import { requestNotSent, retryProviderRequest } from "../provider-retry.js";
import { AppConfig, type Connected, type ConnectInput, OAuth, Secrets } from "../services.js";
import {
  AUTH_URL,
  CONCURRENCY,
  decode,
  DELTA_PREFER,
  DeltaPage,
  GRAPH,
  isTransient,
  Me,
  nextPage,
  PREFER,
  readFailure,
  SCOPES,
  SearchRequest,
  SendRequest,
  TOKEN_URL,
  WithId,
} from "./graph.js";

export const makeGraphClient = Effect.gen(function* () {
  const codec = yield* MailCodec;

  const http = yield* HttpClient.HttpClient;

  const oauth = yield* OAuth;

  const config = yield* AppConfig;

  const secrets = yield* Secrets;

  const connectivity = makeProviderConnectivity();

  const {
    tokens,
    execute,
    authorized,
    invalidateRejectedToken,
    retryUnauthorized,
    accessToken,
    readRetryAt,
    checkReadDeadline,
    throttleReads,
  } = yield* makeProviderHttp({
    http,
    secrets,
    tokenLabel: "Microsoft",
    refresh: (accountId, refreshToken) =>
      Effect.gen(function* () {
        const { microsoft } = yield* config.read;
        if (!microsoft)
          return yield* new ProviderError({
            message: "No Microsoft OAuth client configured",
            reason: "configuration",
          });
        const res = yield* oauth
          .refresh(accountId, { tokenUrl: TOKEN_URL, clientId: microsoft.clientId, refreshToken })
          .pipe(
            Effect.tapError((error) =>
              logProviderFailure("outlook", accountId, HttpClientRequest.post(TOKEN_URL), error),
            ),
          );
        if (Option.isSome(res.refreshToken)) yield* secrets.set(accountId, res.refreshToken.value);
        return res;
      }),
    throttleReads: true,
    prepareRequest: (request) =>
      HttpClientRequest.setHeader(request, "prefer", request.headers.prefer ?? PREFER.prefer),
    parseResponse: (text) => JSON.parse(text),
    isTransient,
  });

  const requestLock = keyedLock(CONCURRENCY);

  const sendLock = keyedLock(1);

  const permissions = makeOptionalPermissions<ApiError | AuthError | ProviderError>();

  const api = (accountId: string, request: HttpClientRequest.HttpClientRequest) =>
    Effect.gen(function* () {
      const sending = yield* SendRequest;
      const background = yield* BackgroundRead;
      const searching = yield* SearchRequest;
      return yield* permissions
        .run(
          accountId,
          request,
          authorized(accountId, request, sending).pipe(
            Effect.tapError((e) =>
              logProviderFailure(
                "outlook",
                accountId,
                request,
                e,
                searching
                  ? {
                      operation: "search",
                      errorCode: graphSearchErrorCode(e._tag === "ApiError" ? e.body : ""),
                    }
                  : undefined,
              ),
            ),
            Effect.tapError((e) => invalidateRejectedToken(accountId, e)),
          ),
        )
        .pipe(
          (requestEffect) =>
            connectivity.run(
              accountId,
              requestEffect,
              background &&
                !sending &&
                (request.method === "GET" || new URL(request.url).pathname.endsWith("/$batch")),
            ),
          (sending ? sendLock(accountId) : requestLock(accountId)).withPermits(
            new URL(request.url).pathname.endsWith("/$batch") ? CONCURRENCY : 1,
          ),
        );
    });

  const headersDenied = new Set<string>();

  /** `path` is a path under GRAPH, or a full https URL (delta and next links are absolute). */
  const get = <A>(
    accountId: string,
    schema: Schema.Decoder<A>,
    path: string,
    prefer = PREFER.prefer,
  ) =>
    Effect.suspend(() => {
      const url = new URL(path.startsWith("https://") ? path : `${GRAPH}${path}`);
      const makeRequest = () =>
        HttpClientRequest.get(url.toString()).pipe(HttpClientRequest.setHeader("prefer", prefer));
      const selection = url.searchParams.get("$select");
      const hasHeaders = selection?.split(",").includes("internetMessageHeaders") ?? false;
      const withoutHeaders = () => {
        url.searchParams.set(
          "$select",
          (selection ?? "")
            .split(",")
            .filter((field) => field !== "internetMessageHeaders")
            .join(","),
        );
        return makeRequest();
      };
      return api(
        accountId,
        hasHeaders && headersDenied.has(accountId) ? withoutHeaders() : makeRequest(),
      ).pipe(
        Effect.catchIf(
          (error) =>
            hasHeaders &&
            !headersDenied.has(accountId) &&
            error._tag === "ApiError" &&
            error.status === 403,
          () => {
            // Retry the same mail read without the optional header field. A mail denial still fails.
            const request = withoutHeaders();
            return api(accountId, request).pipe(
              Effect.tap(() => Effect.sync(() => headersDenied.add(accountId))),
            );
          },
        ),
        Effect.flatMap(decode(schema)),
      );
    });

  const getDelta = (accountId: string, path: string) =>
    Effect.suspend(() => {
      const url = new URL(path.startsWith("https://") ? path : `${GRAPH}${path}`);
      // Old bookmarks can retain a round cap. Delta page size belongs in Prefer.
      if (url.searchParams.has("$top")) url.searchParams.delete("$top");
      return get(accountId, DeltaPage, url.toString(), DELTA_PREFER);
    });

  const write = (
    accountId: string,
    method: "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ) => {
    const make = {
      POST: HttpClientRequest.post,
      PATCH: HttpClientRequest.patch,
      DELETE: HttpClientRequest.delete,
    }[method];
    const request = make(`${GRAPH}${path}`);
    return api(
      accountId,
      body === undefined ? request : HttpClientRequest.bodyJsonUnsafe(request, body),
    );
  };

  const deleteFolderIds = (account: Account, folder: DeleteFolder) =>
    Effect.gen(function* () {
      const root = yield* get(
        account.id,
        WithId,
        `/me/mailFolders/${folder === "trash" ? "deleteditems" : "junkemail"}?$select=id`,
      );
      const ids = new Set<string>();
      const pending = [root.id];
      const Page = Schema.Struct({
        value: Schema.Array(WithId),
        "@odata.nextLink": Schema.optionalKey(Schema.String),
      });
      while (pending.length) {
        const id = pending.shift();
        if (id === undefined) break;
        if (ids.has(id) || ids.size >= 1000)
          return yield* new PermanentError({
            message: "Deleted folder hierarchy repeated or exceeds 1,000 folders.",
          });
        ids.add(id);
        const base = `/me/mailFolders/${encodeURIComponent(id)}/childFolders`;
        let path: string | null = `${base}?includeHiddenFolders=true&$select=id&$top=100`;
        const seen = new Set<string>();
        for (const loadPage of graphPages(
          path,
          (pagePath) =>
            Effect.gen(function* () {
              if (seen.has(pagePath))
                return yield* new PermanentError({
                  message: "Deleted folder pagination repeated a page.",
                });
              seen.add(pagePath);

              return yield* get(account.id, Page, pagePath);
            }),
          () => path,
        )) {
          const children: typeof Page.Type = yield* loadPage;

          pending.push(...children.value.map((child) => child.id));
          const next = children["@odata.nextLink"];
          path = next
            ? yield* nextPage(
                next,
                base,
                undefined,
                () => new PermanentError({ message: "Invalid deleted folder pagination link." }),
              )
            : null;
        }
      }
      return ids;
    });

  /** A GET whose body is not JSON (a message's MIME source). */
  const getBytesAttempt = (accountId: string, path: string, maxBytes?: number) =>
    Effect.flatMap(BackgroundRead, (background) =>
      connectivity.run(
        accountId,
        accessToken(accountId).pipe(
          Effect.flatMap((token) =>
            retryProviderRequest(
              Effect.gen(function* () {
                yield* checkReadDeadline(accountId);
                const res = yield* http.execute(
                  HttpClientRequest.get(`${GRAPH}${path}`).pipe(
                    HttpClientRequest.bearerToken(token),
                    HttpClientRequest.setHeaders(PREFER),
                  ),
                );
                yield* throttleReads(accountId, res.status, res.headers["retry-after"]);
                if (res.status < 200 || res.status >= 300) {
                  return yield* new ApiError({
                    status: res.status,
                    body: yield* res.text,
                    ...(res.headers["retry-after"]
                      ? { retryAfter: res.headers["retry-after"] }
                      : {}),
                  });
                }
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
              HttpClientRequest.get(`${GRAPH}${path}`),
              (error) => error._tag === "ApiError" && isTransient(error),
            ).pipe(requestLock(accountId).withPermits(1)),
          ),
        ),
        background,
      ),
    );

  const getBytes = (accountId: string, path: string, maxBytes?: number) =>
    retryUnauthorized(
      accountId,
      HttpClientRequest.get(`${GRAPH}${path}`),
      getBytesAttempt(accountId, path, maxBytes),
      () => getBytesAttempt(accountId, path, maxBytes),
    ).pipe(
      Effect.tapError((error) =>
        logProviderFailure("outlook", accountId, HttpClientRequest.get(`${GRAPH}${path}`), error),
      ),
    );

  const connect = Effect.fn("Outlook.connect")(function* (
    input: ConnectInput,
  ): Effect.fn.Return<Connected, AuthError | ProviderError | ClientNotConfigured | InvalidInput> {
    if (input.provider !== "outlook") {
      return yield* new InvalidInput({
        message: `Outlook cannot connect a ${input.provider} account`,
      });
    }
    const { microsoft } = yield* config.read;
    if (!microsoft) return yield* new ClientNotConfigured({ provider: "outlook" });
    const res = yield* oauth.authorize({
      authUrl: AUTH_URL,
      tokenUrl: TOKEN_URL,
      clientId: microsoft.clientId,
      scopes: [
        ...new Set([
          ...SCOPES,
          ...(input.grantedScopes ?? []),
          ...(input.feature ? OPTIONAL_SCOPES.outlook[input.feature] : []),
        ]),
      ],
      // Azure's portal only accepts an http `localhost` loopback redirect, so the
      // URI says localhost even though the server binds 127.0.0.1.
      redirectHost: "localhost",
      ...(input.loginHint ? { extraParams: { login_hint: input.loginHint } } : {}),
    });
    if (Option.isNone(res.refreshToken)) {
      return yield* new AuthError({
        accountId: "",
        message: "Microsoft did not return a refresh token",
      });
    }
    const me = yield* execute(
      res.accessToken,
      HttpClientRequest.get(`${GRAPH}/me?$select=mail,userPrincipalName`),
    ).pipe(
      Effect.tapError((error) =>
        logProviderFailure(
          "outlook",
          input.loginHint ?? "",
          HttpClientRequest.get(`${GRAPH}/me`),
          error,
        ),
      ),
      Effect.flatMap(decode(Me)),
      Effect.mapError(readFailure("")),
    );
    // A new sign-in may carry new scopes; cached tokens from the old grant
    // would keep failing until they expire.
    tokens.clear();
    permissions.clear();
    yield* connectivity.reset;
    headersDenied.clear();
    return {
      email: me.mail ?? me.userPrincipalName,
      secret: res.refreshToken.value,
      scopes: res.scopes ?? [],
    };
  });
  return {
    codec,
    connectivity,
    readRetryAt,
    api,
    get,
    getDelta,
    write,
    deleteFolderIds,
    getBytes,
    connect,
  };
});
export type GraphClient = Effect.Success<typeof makeGraphClient>;

import { Effect, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { Account } from "../domain.js";
import {
  AuthError,
  ClientNotConfigured,
  InvalidInput,
  PermanentError,
  ProviderError,
} from "../errors.js";
import { type DeleteFolder } from "../folder-actions.js";
import { effectiveClients, refreshWithIssuer } from "../oauth-clients.js";
import { OPTIONAL_SCOPES } from "../optional-services.js";
import { MailCodec } from "../platform/mail-codec.js";
import { Buffer } from "../platform/bytes.js";
import { graphSearchErrorCode, logProviderFailure } from "../provider-diagnostics.js";
import { makeProviderHttp, ApiError } from "../provider-http.js";
import { graphPages } from "../provider-pages.js";
import {
  AppConfig,
  type Connected,
  type ConnectInput,
  OAuth,
  OAuthIssuers,
  Secrets,
} from "../services.js";
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
  REQUEST_LIMIT,
  TOKEN_URL,
  WithId,
} from "./graph.js";

export const makeOutlookClient = Effect.gen(function* () {
  const codec = yield* MailCodec;

  const http = yield* HttpClient.HttpClient;

  const oauth = yield* OAuth;

  const config = yield* AppConfig;
  const issuers = yield* OAuthIssuers;

  const secrets = yield* Secrets;

  const {
    api,
    execute,
    readBytes,
    matchesBytes,
    deferReads,
    clearTokens,
    connectivity,
    keepAlive,
  } = yield* makeProviderHttp({
    http,
    secrets,
    concurrency: CONCURRENCY,
    serializeSend: true,
    sending: () => SendRequest,
    background: (request) =>
      request.method === "GET" || new URL(request.url).pathname.endsWith("/$batch"),
    permits: (request) => (new URL(request.url).pathname.endsWith("/$batch") ? CONCURRENCY : 1),
    logFailure: (accountId, request, error, body) =>
      Effect.flatMap(SearchRequest, (searching) =>
        logProviderFailure(
          "outlook",
          accountId,
          request,
          error,
          body === "json" && searching
            ? {
                operation: "search",
                errorCode: graphSearchErrorCode(error._tag === "ApiError" ? error.body : ""),
              }
            : undefined,
        ),
      ),
    tokenLabel: "Microsoft",
    refresh: (accountId, refreshToken) =>
      refreshWithIssuer(
        { config, issuers },
        { name: "Microsoft", pick: (clients) => clients.microsoft },
        accountId,
        (microsoft) =>
          oauth
            .refresh(accountId, {
              tokenUrl: TOKEN_URL,
              clientId: microsoft.clientId,
              refreshToken,
            })
            .pipe(
              Effect.tapError((error) =>
                logProviderFailure("outlook", accountId, HttpClientRequest.post(TOKEN_URL), error),
              ),
            ),
      ),
    throttleReads: true,
    prepareRequest: (request) =>
      HttpClientRequest.setHeader(request, "prefer", request.headers.prefer ?? PREFER.prefer),
    parseResponse: (text) => JSON.parse(text),
    isTransient,
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
  ): Effect.Effect<unknown, ApiError | AuthError | ProviderError> => {
    const make = {
      POST: HttpClientRequest.post,
      PATCH: HttpClientRequest.patch,
      DELETE: HttpClientRequest.delete,
    }[method];
    const request = make(`${GRAPH}${path}`);
    if (body !== undefined && Buffer.byteLength(JSON.stringify(body)) > REQUEST_LIMIT)
      return Effect.fail(
        new ApiError({
          status: 413,
          body: JSON.stringify({
            error: { message: "Outlook message requests cannot exceed 4 MB" },
          }),
        }),
      );
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

  const getBytes = (accountId: string, path: string, maxBytes?: number) =>
    readBytes(accountId, HttpClientRequest.get(`${GRAPH}${path}`), maxBytes);

  const connect = Effect.fn("Outlook.connect")(function* (
    input: ConnectInput,
  ): Effect.fn.Return<Connected, AuthError | ProviderError | ClientNotConfigured | InvalidInput> {
    if (input.provider !== "outlook") {
      return yield* new InvalidInput({
        message: `Outlook cannot connect a ${input.provider} account`,
      });
    }
    const { microsoft } = effectiveClients(yield* config.sources);
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
    clearTokens();
    yield* connectivity.reset;
    headersDenied.clear();
    return {
      email: me.mail ?? me.userPrincipalName,
      secret: res.refreshToken.value,
      clientId: microsoft.clientId,
      scopes: res.scopes ?? [],
    };
  });
  return {
    codec,
    connectivity,
    keepAlive,
    deferReads,
    api,
    get,
    getDelta,
    write,
    deleteFolderIds,
    getBytes,
    matchesAttachment: (
      accountId: string,
      path: string,
      size: number,
      range: (start: number, length: number) => Uint8Array,
    ) => matchesBytes(accountId, HttpClientRequest.get(`${GRAPH}${path}`), size, range),
    connect,
  };
});
export type OutlookClient = Effect.Success<typeof makeOutlookClient>;

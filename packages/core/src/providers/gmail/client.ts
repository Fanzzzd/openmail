import { Effect, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { refreshWithIssuer } from "../oauth-clients.js";
import { Buffer } from "../../platform/bytes.js";
import { PlatformCrypto } from "../../platform/crypto.js";
import { MailCodec } from "../../platform/mail-codec.js";
import { decodedBody, hasSignedContainer } from "../../platform/mime-compat.js";
import { parseGmailBatch } from "../provider-batch.js";
import { logProviderFailure } from "../provider-diagnostics.js";
import { makeProviderHttp } from "../provider-http.js";
import { isProviderSend } from "../provider-retry.js";

import { buildMime as unboundBuildMime } from "../../compose/compose.js";
import type { IncomingMessage } from "../../domain/message.js";
import { Label } from "../../domain/account.js";
import { ProviderError } from "../../domain/errors.js";
import { AppConfig, OAuthIssuers, OAuth, Secrets } from "../../platform/auth.js";

import { finishWith, HtmlText } from "../../platform/html-text.js";
import {
  CONCURRENCY,
  TOKEN_URL,
  isTransient,
  API,
  LabelList,
  GmailMessage,
  RawMessage,
  decode,
} from "./api.js";
import { gmailBody } from "./parse.js";

/** The Gmail HTTP client for one adapter: OAuth refresh, JSON requests and the reads every part of the adapter shares. */
export const makeGmailClient = Effect.gen(function* () {
  const codec = yield* MailCodec;
  const crypto = yield* PlatformCrypto;
  const htmlText = yield* HtmlText;
  const buildMime = (...args: Parameters<typeof unboundBuildMime>) =>
    unboundBuildMime(...args).pipe(Effect.provideService(MailCodec, codec));
  const http = yield* HttpClient.HttpClient;
  const oauth = yield* OAuth;
  const config = yield* AppConfig;
  const issuers = yield* OAuthIssuers;
  const secrets = yield* Secrets;

  const { api, execute, clearTokens, connectivity, keepAlive } = yield* makeProviderHttp({
    http,
    secrets,
    concurrency: CONCURRENCY,
    serializeSend: false,
    sending: (request) => Effect.succeed(isProviderSend(request)),
    background: (request) => request.method === "GET" || request.url.includes("/batch/gmail/"),
    permits: () => 1,
    logFailure: (accountId, request, error) =>
      logProviderFailure("gmail", accountId, request, error),
    tokenLabel: "Google",
    refresh: (accountId, refreshToken) =>
      refreshWithIssuer(
        { config, issuers },
        { name: "Google", pick: (clients) => clients.google, testingMode: true },
        accountId,
        (google) =>
          oauth
            .refresh(accountId, {
              tokenUrl: TOKEN_URL,
              clientId: google.clientId,
              clientSecret: google.clientSecret,
              refreshToken,
            })
            .pipe(
              Effect.tapError((error) =>
                logProviderFailure("gmail", accountId, HttpClientRequest.post(TOKEN_URL), error),
              ),
            ),
      ),
    throttleReads: false,
    prepareRequest: (request) => request,
    parseResponse: (text, contentType, request) =>
      request.url.includes("/batch/gmail/") ? parseGmailBatch(text, contentType) : JSON.parse(text),
    isTransient,
  });
  const get = <A>(
    accountId: string,
    schema: Schema.Decoder<A>,
    path: string,
    urlParams?: Record<string, string | readonly string[]>,
  ) =>
    api(accountId, HttpClientRequest.get(`${API}${path}`, urlParams ? { urlParams } : {})).pipe(
      Effect.flatMap((json) =>
        decode(schema)(json).pipe(
          Effect.mapError((e) => new ProviderError({ message: `${e.message} (${path})` })),
        ),
      ),
    );

  const post = (accountId: string, path: string, body?: unknown) =>
    api(
      accountId,
      body === undefined
        ? HttpClientRequest.post(`${API}${path}`)
        : HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post(`${API}${path}`), body),
    );

  const put = (accountId: string, path: string, body: unknown) =>
    api(accountId, HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.put(`${API}${path}`), body));

  const del = (accountId: string, path: string) =>
    api(accountId, HttpClientRequest.delete(`${API}${path}`));

  /** User-created labels. System labels (INBOX, CATEGORY_*) map to fixed mailboxes instead. */
  const fetchUserLabels = (accountId: string) =>
    get(accountId, LabelList, "/labels").pipe(
      Effect.map(({ labels = [] }): Omit<Label, "accountId">[] =>
        labels
          .filter((l) => l.type === "user")
          .map((l) => ({
            id: l.id,
            name: l.name,
            color: l.color?.backgroundColor ?? null,
            ...(l.labelListVisibility ? { labelListVisibility: l.labelListVisibility } : {}),
            ...(l.messageListVisibility ? { messageListVisibility: l.messageListVisibility } : {}),
          })),
      ),
    );

  /** None when the message was deleted between listing and fetching. */
  const fetchMessage = (accountId: string, id: string) =>
    get(accountId, GmailMessage, `/messages/${encodeURIComponent(id)}`, { format: "full" }).pipe(
      Effect.flatMap((raw) =>
        Effect.flatMap(finishWith(htmlText, gmailBody(raw)), (message) => {
          if (!hasSignedContainer(message, raw.payload.mimeType))
            return Effect.succeed(Option.some(message));
          return get(accountId, RawMessage, `/messages/${encodeURIComponent(id)}`, {
            format: "raw",
          }).pipe(
            Effect.flatMap((source) =>
              Effect.tryPromise({
                try: () => codec.parse(Buffer.from(source.raw, "base64")),
                catch: () => new ProviderError({ message: "Cannot parse signed MIME" }),
              }),
            ),
            Effect.flatMap((parsed) => finishWith(htmlText, decodedBody(message, parsed))),
            Effect.map(Option.some),
            Effect.catch(() => Effect.succeed(Option.some(message))),
          );
        }),
      ),
      Effect.catchIf(
        (e) => e._tag === "ApiError" && e.status === 404,
        () => Effect.succeed(Option.none<IncomingMessage>()),
      ),
    );

  return {
    codec,
    crypto,
    htmlText,
    buildMime,
    http,
    oauth,
    config,
    issuers,
    secrets,
    api,
    execute,
    clearTokens,
    connectivity,
    keepAlive,
    get,
    post,
    put,
    del,
    fetchUserLabels,
    fetchMessage,
  };
});
export type GmailClient = Effect.Success<typeof makeGmailClient>;

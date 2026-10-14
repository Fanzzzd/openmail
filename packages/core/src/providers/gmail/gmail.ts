import { Effect, Option, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { FOLDER_BATCH_LIMIT, GMAIL_PERMANENT_DELETE_SCOPE } from "../../domain/folder-actions.js";
import { OPTIONAL_SCOPES, isOptionalService } from "../optional-services.js";
import { effectiveClients } from "../oauth-clients.js";
import { MailCodec } from "../../platform/mail-codec.js";
import { PlatformHost } from "../../platform/host.js";
import { BackgroundRead } from "../provider-connectivity.js";
import { logProviderFailure } from "../provider-diagnostics.js";
import { featureRequest } from "../provider-features.js";

import {
  AuthError,
  ClientNotConfigured,
  InvalidInput,
  PermanentError,
  ProviderError,
} from "../../domain/errors.js";
import { AppConfig, OAuthIssuers, OAuth, Secrets } from "../../platform/auth.js";
import type { ConnectInput, Connected, ProviderAdapter } from "../adapter.js";

import { makeGmailFeatures } from "./gmail-features.js";
import { makeGmailSettings } from "./gmail-settings.js";
import { makeProviderCalendar } from "../../calendar/provider-calendar.js";
import {
  AUTH_URL,
  REVOKE_URL,
  TOKEN_URL,
  SCOPES,
  API,
  readFailure,
  DraftList,
  MessageList,
  writeFailure,
  is404,
  CONCURRENCY,
  decode,
  Profile,
} from "./api.js";
import { makeGmailClient } from "./client.js";
import { makeGmailLabels, gmailDelta } from "./labels.js";
import { makeGmailPull } from "./pull.js";
import { makeGmailSend } from "./send.js";

export const makeGmail: Effect.Effect<
  ProviderAdapter,
  never,
  HttpClient.HttpClient | OAuth | AppConfig | OAuthIssuers | Secrets | MailCodec
> = Effect.gen(function* () {
  const client = yield* makeGmailClient;
  const host = yield* PlatformHost;
  const http = yield* HttpClient.HttpClient;
  const secrets = yield* Secrets;
  const {
    oauth,
    config,
    api,
    execute,
    clearTokens,
    connectivity,
    keepAlive,
    get,
    post,
    put,
    del,
    fetchMessage,
  } = client;
  const {
    pull,
    fetchRaw,
    fetchAttachment,
    search,
    backfill,
    verifyResetCandidates,
    fetchCachedHeaders,
    folderStatus,
  } = makeGmailPull(client);
  const { push, changeLabel } = makeGmailLabels(client);
  const { send, saveDraft, deleteDraft } = makeGmailSend(client);

  const connect = Effect.fn("Gmail.connect")(function* (
    input: ConnectInput,
  ): Effect.fn.Return<Connected, AuthError | ProviderError | ClientNotConfigured | InvalidInput> {
    if (input.provider !== "gmail") {
      return yield* new InvalidInput({
        message: `Gmail cannot connect a ${input.provider} account`,
      });
    }
    const { google } = effectiveClients(yield* config.sources);
    if (!google) return yield* new ClientNotConfigured({ provider: "gmail" });
    const res = yield* oauth.authorize({
      authUrl: AUTH_URL,
      tokenUrl: TOKEN_URL,
      clientId: google.clientId,
      clientSecret: google.clientSecret,
      scopes: [
        ...new Set([
          ...SCOPES,
          ...(input.grantedScopes ?? []),
          ...(input.feature === "permanentDelete"
            ? [GMAIL_PERMANENT_DELETE_SCOPE]
            : isOptionalService(input.feature)
              ? OPTIONAL_SCOPES.gmail[input.feature]
              : []),
        ]),
      ],
      // offline + consent: Google only returns a refresh token on explicit consent.
      extraParams: {
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        ...(input.loginHint ? { login_hint: input.loginHint } : {}),
      },
    });
    if (Option.isNone(res.refreshToken)) {
      return yield* new AuthError({
        accountId: "",
        message: "Google did not return a refresh token",
      });
    }
    const profile = yield* execute(res.accessToken, HttpClientRequest.get(`${API}/profile`)).pipe(
      Effect.tapError((error) =>
        logProviderFailure(
          "gmail",
          input.loginHint ?? "",
          HttpClientRequest.get(`${API}/profile`),
          error,
        ),
      ),
      Effect.flatMap(decode(Profile)),
      Effect.mapError(readFailure("")),
    );
    // A new sign-in may carry new scopes; cached tokens from the old grant
    // would keep failing until they expire.
    clearTokens();
    yield* connectivity.reset;
    settings.clearMissingScopes(`gmail:${profile.emailAddress.toLowerCase()}`);
    return {
      email: profile.emailAddress,
      secret: res.refreshToken.value,
      clientId: google.clientId,
      scopes: res.scopes ?? [],
    };
  });

  const settings = makeGmailSettings(get, (id, method, path, body) => {
    if (method === "POST") return post(id, path, body);
    if (method === "DELETE") return del(id, path);
    return put(id, path, body);
  });
  /** Google's revocation endpoint takes the refresh token as a form field and answers 200. */
  const revokeGrant = (accountId: string) =>
    Effect.gen(function* () {
      const token = yield* secrets.get(accountId);
      if (Option.isNone(token)) return;
      const response = yield* http
        .execute(
          HttpClientRequest.post(REVOKE_URL).pipe(
            HttpClientRequest.bodyUrlParams({ token: token.value }),
          ),
        )
        .pipe(
          Effect.timeout("5 seconds"),
          // Fixed text: a transport error could echo the request, which carries the token.
          Effect.mapError(
            () => new ProviderError({ message: "Google token revocation did not complete" }),
          ),
        );
      if (response.status !== 200)
        yield* new ProviderError({
          message: "Google did not revoke the token",
          status: response.status,
        });
    });

  return {
    resetConnectivity: () => connectivity.reset,
    keepAlive,
    revokeGrant,
    fetchCachedHeaders: (account, ids) =>
      fetchCachedHeaders(account, ids).pipe(Effect.provideService(BackgroundRead, true)),
    folderStatus,
    backfill: (...args) => backfill(...args).pipe(Effect.provideService(BackgroundRead, true)),
    draftMessageIds: (account) =>
      get(account.id, DraftList, "/drafts", { maxResults: "500" }).pipe(
        Effect.map((page) => (page.drafts ?? []).map((draft) => draft.message.id)),
        Effect.mapError(readFailure(account.id)),
        Effect.provideService(BackgroundRead, true),
      ),
    verifyResetCandidates: (account, candidates) =>
      verifyResetCandidates(account, candidates).pipe(Effect.provideService(BackgroundRead, true)),
    fetchMessage: (account, id) =>
      fetchMessage(account.id, id).pipe(
        Effect.mapError(readFailure(account.id)),
        Effect.flatMap((m) =>
          Option.isSome(m)
            ? Effect.succeed(m.value)
            : Effect.fail(new PermanentError({ message: `Message ${id} is gone` })),
        ),
      ),
    ...settings,
    ...makeProviderCalendar(
      "gmail",
      (id, schema, url) => api(id, HttpClientRequest.get(url)).pipe(Effect.flatMap(decode(schema))),
      (id, url, body) =>
        api(id, HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post(url), body)),
      host.timeZone,
    ),
    ...makeGmailFeatures(
      (id, schema, url) => api(id, HttpClientRequest.get(url)).pipe(Effect.flatMap(decode(schema))),
      (id, url, body) =>
        api(id, HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.patch(url), body)),
    ),
    listFolderMessages: (account, folder, cursor, options) =>
      Effect.gen(function* () {
        const labels: Record<string, string> = {
          inbox: "INBOX",
          important: "IMPORTANT",
          starred: "STARRED",
          sent: "SENT",
          drafts: "DRAFT",
          spam: "SPAM",
          trash: "TRASH",
        };
        const labelIds = [
          ...new Set(
            [
              labels[folder.mailbox],
              folder.label,
              ...(options?.unreadOnly ? ["UNREAD"] : []),
            ].filter((label) => label !== undefined),
          ),
        ];
        const page = yield* get(account.id, MessageList, "/messages", {
          maxResults: String(FOLDER_BATCH_LIMIT),
          includeSpamTrash: "true",
          ...(labelIds.length ? { labelIds } : {}),
          ...(folder.mailbox === "all" ? { q: "-in:trash -in:spam" } : {}),
          ...(cursor ? { pageToken: cursor } : {}),
        });
        return { ids: (page.messages ?? []).map((m) => m.id), next: page.nextPageToken ?? null };
      }).pipe(Effect.mapError(writeFailure(account.id))),
    markReadBatch: (account, ids) =>
      post(account.id, "/messages/batchModify", {
        ids,
        addLabelIds: [],
        removeLabelIds: ["UNREAD"],
      }).pipe(Effect.asVoid, Effect.mapError(writeFailure(account.id))),
    checkPermanentDelete: (_account, folder) =>
      Effect.succeed([folder === "trash" ? "TRASH" : "SPAM"]),
    permanentlyDelete: (account, ids, folder) =>
      ids.length > FOLDER_BATCH_LIMIT
        ? Effect.fail(
            new PermanentError({ message: "Permanent delete batch exceeds 100 messages." }),
          )
        : featureRequest(
            account,
            "permanentDelete",
            Effect.gen(function* () {
              const DeleteMetadata = Schema.Struct({
                labelIds: Schema.optionalKey(Schema.Array(Schema.String)),
              });
              const checked = yield* Effect.forEach(
                ids,
                (id) =>
                  get(account.id, DeleteMetadata, `/messages/${encodeURIComponent(id)}`, {
                    format: "minimal",
                    fields: "labelIds",
                  }).pipe(
                    Effect.catchIf(is404, () =>
                      Effect.succeed<typeof DeleteMetadata.Type>({ labelIds: [] }),
                    ),
                    Effect.map((metadata) =>
                      metadata.labelIds?.includes(folder === "trash" ? "TRASH" : "SPAM")
                        ? id
                        : null,
                    ),
                  ),
                { concurrency: CONCURRENCY },
              );
              const verified = checked.filter((id) => id !== null);
              if (verified.length)
                yield* post(account.id, "/messages/batchDelete", { ids: verified });
              return { kind: "complete", ids: verified } as const;
            }),
          ),
    search,
    changeLabel,
    connect,
    pull: (...args) => pull(...args).pipe(Stream.provideService(BackgroundRead, true)),
    push,
    pushBatch: (account, ids, op) => {
      if (op.kind === "trash" || op.kind === "inbox" || op.kind === "move")
        return Effect.forEach(ids, (id) => push(account, id, op), { discard: true });
      const { add, remove } = gmailDelta(op);
      return post(account.id, "/messages/batchModify", {
        ids,
        addLabelIds: add,
        removeLabelIds: remove,
      }).pipe(Effect.asVoid, Effect.mapError(writeFailure(account.id)));
    },
    send,
    saveDraft,
    getDraftOrganization: (account, id) =>
      get(
        account.id,
        Schema.Struct({ labelIds: Schema.optionalKey(Schema.Array(Schema.String)) }),
        `/messages/${encodeURIComponent(id)}`,
        { format: "minimal" },
      ).pipe(
        Effect.map((message) => ({
          labels: (message.labelIds ?? []).filter((label) => label.startsWith("Label_")),
          starred: message.labelIds?.includes("STARRED") ?? false,
        })),
        Effect.mapError(writeFailure(account.id)),
      ),
    deleteDraft,
    fetchRaw,
    fetchAttachment,
  } satisfies ProviderAdapter;
});

import { BASE_SCOPES, OPTIONAL_SCOPES } from "./optional-services.js";
import { logProviderFailure, makeOptionalPermissions } from "./provider-diagnostics.js";
import { confirmDelivery } from "./provider-send.js";
import { messageSecurity } from "./message-security.js";
import { retryProviderRequest, isProviderSend, retryAfterMillis } from "./provider-retry.js";
import { PlatformCrypto } from "./platform/crypto.js";
import { hasSignedContainer, withDecodedBody, withUuAttachments } from "./platform/mime-compat.js";
import { MailCodec } from "./platform/mail-codec.js";
import { Buffer } from "./platform/bytes.js";
import { FOLDER_BATCH_LIMIT, GMAIL_PERMANENT_DELETE_SCOPE } from "./folder-actions.js";
import { featureRequest } from "./provider-features.js";
import { Clock, Data, Effect, Option, Schema, Semaphore, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { type AttachmentRef, pickAttachment, MEDIA_RAW_TOO_LARGE } from "./attachments.js";
import { buildMime as unboundBuildMime, type Threading } from "./compose.js";
import { GMAIL_MIME_LIMIT } from "./attachment-policy.js";
import { Label } from "./domain.js";
import type {
  Account,
  Attachment,
  DraftRemote,
  IncomingMessage,
  MailOp,
  OutgoingMessage,
} from "./domain.js";
import {
  AuthError,
  ClientNotConfigured,
  InvalidInput,
  PermanentError,
  ProviderError,
  type ProviderFailure,
} from "./errors.js";
import { charsetOf, decodeHeader, decodeUtf8First, htmlToText, parseAddressList } from "./mime.js";
import {
  AppConfig,
  type Change,
  type ConnectInput,
  type Connected,
  type DraftPush,
  OAuth,
  type ProviderAdapter,
  Secrets,
} from "./services.js";

import { gmailSearch, searchIncludesSpecialFolders } from "./search.js";
import { makeProviderCalendar } from "./provider-calendar.js";
import { makeGmailFeatures } from "./gmail-features.js";
import { makeGmailSettings } from "./gmail-settings.js";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
// Permanent deletion is an optional incremental grant, never requested at account add time.
// Accounts added under the old read-only scope get a 403 on their first write
// and are asked to sign in again.
const SCOPES = BASE_SCOPES.gmail;

/** First sync pulls this window, spam and trash included; older mail arrives later through backfill. */
const INITIAL_QUERY = "newer_than:90d";
const INITIAL_LIMIT = 2000;
const CONCURRENCY = 8;

// Provider JSON. Only the fields openmail reads; extra fields are ignored.

const Header = Schema.Struct({ name: Schema.String, value: Schema.String });
type Header = typeof Header.Type;

export interface GmailPart {
  readonly mimeType: string;
  readonly filename?: string;
  readonly headers?: readonly Header[];
  readonly body: { readonly data?: string; readonly attachmentId?: string; readonly size: number };
  readonly parts?: readonly GmailPart[];
}

const GmailPart: Schema.Codec<GmailPart> = Schema.Struct({
  mimeType: Schema.String,
  filename: Schema.optionalKey(Schema.String),
  headers: Schema.optionalKey(Schema.Array(Header)),
  body: Schema.Struct({
    data: Schema.optionalKey(Schema.String),
    attachmentId: Schema.optionalKey(Schema.String),
    size: Schema.Number,
  }),
  parts: Schema.optionalKey(Schema.Array(Schema.suspend((): Schema.Codec<GmailPart> => GmailPart))),
});

const GmailMessage = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  labelIds: Schema.optionalKey(Schema.Array(Schema.String)),
  snippet: Schema.optionalKey(Schema.String),
  internalDate: Schema.String,
  sizeEstimate: Schema.optionalKey(Schema.Number),
  payload: GmailPart,
});
export type GmailMessage = typeof GmailMessage.Type;

const MessageRef = Schema.Struct({ message: Schema.Struct({ id: Schema.String }) });
const MessageRefs = Schema.optionalKey(Schema.Array(MessageRef));

const HistoryPage = Schema.Struct({
  history: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        messagesAdded: MessageRefs,
        messagesDeleted: MessageRefs,
        labelsAdded: MessageRefs,
        labelsRemoved: MessageRefs,
      }),
    ),
  ),
  historyId: Schema.String,
  nextPageToken: Schema.optionalKey(Schema.String),
});

const MessageList = Schema.Struct({
  messages: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.String }))),
  nextPageToken: Schema.optionalKey(Schema.String),
});

const LabelList = Schema.Struct({
  labels: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        type: Schema.optionalKey(Schema.String),
        labelListVisibility: Label.fields.labelListVisibility,
        messageListVisibility: Label.fields.messageListVisibility,
        color: Schema.optionalKey(
          Schema.Struct({ backgroundColor: Schema.optionalKey(Schema.String) }),
        ),
      }),
    ),
  ),
});

const Profile = Schema.Struct({ emailAddress: Schema.String, historyId: Schema.String });

const Metadata = Schema.Struct({
  payload: Schema.Struct({ headers: Schema.optionalKey(Schema.Array(Header)) }),
});

const GmailDraft = Schema.Struct({
  id: Schema.String,
  message: Schema.Struct({ id: Schema.String }),
});

const DraftList = Schema.Struct({
  drafts: Schema.optionalKey(Schema.Array(GmailDraft)),
  nextPageToken: Schema.optionalKey(Schema.String),
});

const RawMessage = Schema.Struct({ raw: Schema.String });
const AttachmentBody = Schema.Struct({ data: Schema.String });

/** A non-2xx response, or a transport failure as status 0, before it becomes a ProviderFailure. */
class ApiError extends Data.TaggedError("ApiError")<{
  status: number;
  body: string;
  retryAfter?: string;
  deferred?: boolean;
}> {}

// 429 and 5xx are quota and transient errors. Gmail also reports per-user
// quota as 403 rateLimitExceeded, which clears the same way.
const isTransient = (e: ApiError) =>
  e.status === 0 ||
  e.status === 429 ||
  e.status >= 500 ||
  (e.status === 403 && /rateLimitExceeded/i.test(e.body));

const is404 = (e: { _tag: string }) => e instanceof ApiError && e.status === 404;

/**
 * Maps a failed call to what the op queue does next: sign in again, drop the
 * op, or retry later. On reads a 404 that matters (stale history, deleted
 * message) is caught before this; any other is worth retrying later.
 */
const readFailure =
  (accountId: string) =>
  (e: ApiError | AuthError | ProviderError): AuthError | ProviderError => {
    if (e._tag !== "ApiError") return e;
    const message = `Gmail API ${e.status}: ${e.body}`;
    if (e.status === 401) {
      return new AuthError({ accountId, message });
    }
    return new ProviderError({
      message,
      status: e.status,
      ...(e.deferred ? { deferred: true } : {}),
    });
  };

/** Writes Gmail will never accept (bad label id, message gone) are dropped. */
const writeFailure =
  (accountId: string) =>
  (e: ApiError | ProviderFailure): ProviderFailure =>
    e._tag === "ApiError" && (e.status === 400 || e.status === 404)
      ? new PermanentError({ message: `Gmail API ${e.status}: ${e.body}` })
      : e._tag === "PermanentError"
        ? e
        : readFailure(accountId)(e);

const decode =
  <A>(schema: Schema.Decoder<A>) =>
  (json: unknown): Effect.Effect<A, ProviderError> =>
    Schema.decodeUnknownEffect(schema)(json).pipe(
      Effect.mapError(
        (e) => new ProviderError({ message: `Unexpected Gmail response: ${e.message}` }),
      ),
    );

export const makeGmail: Effect.Effect<
  ProviderAdapter,
  never,
  HttpClient.HttpClient | OAuth | AppConfig | Secrets | MailCodec
> = Effect.gen(function* () {
  const codec = yield* MailCodec;
  const crypto = yield* PlatformCrypto;
  const buildMime = (...args: Parameters<typeof unboundBuildMime>) =>
    unboundBuildMime(...args).pipe(Effect.provideService(MailCodec, codec));
  const http = yield* HttpClient.HttpClient;
  const oauth = yield* OAuth;
  const config = yield* AppConfig;
  const secrets = yield* Secrets;

  // Access tokens last an hour. One refresh at a time, so a sync that starts
  // eight fetches at once refreshes once.
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
            message: "No Google refresh token; sign in again",
          });
        }
        const { google } = yield* config.read;
        if (!google) {
          return yield* new ProviderError({
            message: "No Google OAuth client configured",
            reason: "configuration",
          });
        }
        const res = yield* oauth
          .refresh(accountId, {
            tokenUrl: TOKEN_URL,
            clientId: google.clientId,
            clientSecret: google.clientSecret,
            refreshToken: refreshToken.value,
          })
          .pipe(
            Effect.tapError((error) =>
              logProviderFailure("gmail", accountId, HttpClientRequest.post(TOKEN_URL), error),
            ),
          );
        tokens.set(accountId, { token: res.accessToken, expiresAt: now + res.expiresIn * 1000 });
        return res.accessToken;
      }),
    );

  /** Sends one request with retries; resolves to the parsed JSON body, or null when empty. */
  const execute = (token: string, request: HttpClientRequest.HttpClientRequest) =>
    retryProviderRequest(
      Effect.gen(function* () {
        const res = yield* http.execute(HttpClientRequest.bearerToken(request, token));
        const text = yield* res.text;
        if (res.status < 200 || res.status >= 300) {
          return yield* new ApiError({
            status: res.status,
            body: text,
            deferred:
              retryAfterMillis(res.headers["retry-after"], yield* Clock.currentTimeMillis) > 60000,
            ...(res.headers["retry-after"] ? { retryAfter: res.headers["retry-after"] } : {}),
          });
        }
        if (!text) return null;
        return yield* Effect.try({
          try: (): unknown => JSON.parse(text),
          catch: () => new ApiError({ status: res.status, body: "response is not JSON" }),
        });
      }).pipe(
        Effect.catchTag("HttpClientError", (e) =>
          Effect.fail(new ApiError({ status: 0, body: e.message })),
        ),
      ),
      request,
      isTransient,
    );

  const permissions = makeOptionalPermissions<ApiError | AuthError | ProviderError>();
  const api = (accountId: string, request: HttpClientRequest.HttpClientRequest) =>
    permissions.run(
      accountId,
      request,
      accessToken(accountId).pipe(
        Effect.flatMap((token) => execute(token, request)),
        // The provider can reject an access token before it expires. Drop it,
        // refresh, and retry once; only a failed refresh means signing in again.
        Effect.catchIf(
          (e) => e._tag === "ApiError" && e.status === 401 && !isProviderSend(request),
          () =>
            Effect.sync(() => tokens.delete(accountId)).pipe(
              Effect.andThen(accessToken(accountId)),
              Effect.flatMap((token) => execute(token, request)),
            ),
        ),
        Effect.tapError((e) => logProviderFailure("gmail", accountId, request, e)),
        Effect.tapError((e) =>
          e._tag === "ApiError" && e.status === 401
            ? Effect.sync(() => tokens.delete(accountId))
            : Effect.void,
        ),
      ),
    );

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

  const connect = Effect.fn("Gmail.connect")(function* (
    input: ConnectInput,
  ): Effect.fn.Return<Connected, AuthError | ProviderError | ClientNotConfigured | InvalidInput> {
    if (input.provider !== "gmail") {
      return yield* new InvalidInput({
        message: `Gmail cannot connect a ${input.provider} account`,
      });
    }
    const { google } = yield* config.read;
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
            : input.feature
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
    tokens.clear();
    permissions.clear();
    settings.clearMissingScopes(`gmail:${profile.emailAddress.toLowerCase()}`);
    return {
      email: profile.emailAddress,
      secret: res.refreshToken.value,
      scopes: res.scopes ?? [],
    };
  });

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

  /** None when the cursor is too old (Gmail keeps about a week), forcing a full sync. */
  const readHistory = Effect.fnUntraced(
    function* (accountId: string, cursor: string, scope?: "inbox") {
      const changed = new Set<string>();
      const added = new Set<string>();
      const deleted = new Set<string>();
      let pageToken: string | undefined;
      let latest = cursor;
      do {
        const page = yield* get(accountId, HistoryPage, "/history", {
          startHistoryId: cursor,
          ...(scope ? { labelId: "INBOX" } : {}),
          maxResults: "500",
          ...(pageToken ? { pageToken } : {}),
        });
        for (const h of page.history ?? []) {
          for (const e of h.messagesAdded ?? []) added.add(e.message.id);
          for (const e of [
            ...(h.messagesAdded ?? []),
            ...(h.labelsAdded ?? []),
            ...(h.labelsRemoved ?? []),
          ]) {
            changed.add(e.message.id);
          }
          for (const e of h.messagesDeleted ?? []) deleted.add(e.message.id);
        }
        latest = page.historyId;
        pageToken = page.nextPageToken;
      } while (pageToken);
      for (const id of deleted) changed.delete(id);
      return Option.some({
        changedIds: [...changed],
        addedIds: added,
        deletedIds: [...deleted],
        cursor: latest,
      });
    },
    Effect.catchIf(
      (e) => e._tag === "ApiError" && e.status === 404,
      () => Effect.succeed(Option.none()),
    ),
  );

  const fullSyncPlan = Effect.fnUntraced(function* (
    accountId: string,
    scope?: "inbox",
    recovering = false,
  ) {
    const since = (yield* Clock.currentTimeMillis) - 90 * 86400000;
    // Take the cursor before listing so nothing that arrives mid-sync is lost;
    // the next incremental run re-fetches any overlap idempotently.
    const { historyId } = yield* get(accountId, Profile, "/profile");
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const page = yield* get(accountId, MessageList, "/messages", {
        q: scope ? `in:inbox ${INITIAL_QUERY}` : INITIAL_QUERY,
        includeSpamTrash: "true",
        maxResults: "500",
        ...(pageToken ? { pageToken } : {}),
      });
      ids.push(...(page.messages ?? []).map((m) => m.id));
      pageToken = page.nextPageToken;
    } while (pageToken && ids.length < (recovering ? Infinity : INITIAL_LIMIT));
    return {
      changedIds: recovering ? ids : ids.slice(0, INITIAL_LIMIT),
      addedIds: new Set(ids),
      since,
      deletedIds: [] as string[],
      cursor: historyId,
    };
  });

  /** None when the message was deleted between listing and fetching. */
  const fetchMessage = (accountId: string, id: string) =>
    get(accountId, GmailMessage, `/messages/${encodeURIComponent(id)}`, { format: "full" }).pipe(
      Effect.flatMap((raw) => {
        const message = parseGmailMessage(raw);
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
          Effect.map((parsed) => Option.some(withDecodedBody(message, parsed))),
          Effect.catch(() => Effect.succeed(Option.some(message))),
        );
      }),
      Effect.catchIf(
        (e) => e._tag === "ApiError" && e.status === 404,
        () => Effect.succeed(Option.none<IncomingMessage>()),
      ),
    );

  const pull = (
    account: Account,
    cursor: Option.Option<string>,
    scope?: "inbox",
    incrementalOnly = false,
  ): Stream.Stream<Change, ProviderFailure> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const labels = scope ? [] : yield* fetchUserLabels(account.id);
        const incremental = Option.isSome(cursor)
          ? yield* readHistory(account.id, cursor.value, scope)
          : Option.none();
        if (incrementalOnly && Option.isNone(incremental))
          return yield* new ProviderError({
            message: "Foreground sync required to renew the cursor",
          });
        const full = Option.isNone(incremental)
          ? yield* fullSyncPlan(account.id, scope, Option.isSome(cursor))
          : undefined;
        const plan = Option.isSome(incremental) ? incremental.value : full!;
        const total = plan.changedIds.length;

        const fetched = Stream.fromIterable(plan.changedIds).pipe(
          Stream.mapEffect(
            (id, i) =>
              (plan.addedIds.has(id)
                ? fetchMessage(account.id, id).pipe(
                    Effect.map((m): Change =>
                      Option.isSome(m)
                        ? { _tag: "Upsert", message: m.value }
                        : { _tag: "Delete", providerId: id },
                    ),
                  )
                : get(
                    account.id,
                    Schema.Struct({ id: Schema.String, labelIds: Schema.Array(Schema.String) }),
                    `/messages/${encodeURIComponent(id)}`,
                    { format: "minimal", fields: "id,labelIds" },
                  ).pipe(
                    Effect.map((m): Change => ({
                      _tag: "MessageLabels",
                      providerId: m.id,
                      labels: m.labelIds,
                    })),
                    Effect.catchIf(is404, () =>
                      Effect.succeed<Change>({ _tag: "Delete", providerId: id }),
                    ),
                  )
              ).pipe(
                Effect.map((change): Change[] => [
                  change,
                  { _tag: "Progress", fetched: i + 1, total },
                ]),
              ),
            { concurrency: CONCURRENCY },
          ),
          Stream.flattenIterable,
        );
        const deletes = plan.deletedIds.map((providerId): Change => ({
          _tag: "Delete",
          providerId,
        }));
        // The history cursor only covers the whole batch, so it goes last.
        const head: Change = { _tag: "Labels", labels };
        const tail: Change = { _tag: "Cursor", cursor: plan.cursor };
        return Stream.fromIterable(scope ? [] : [head]).pipe(
          Stream.concat(fetched),
          Stream.concat(Stream.fromIterable(deletes)),
          Stream.concat(
            Stream.fromIterable(
              !scope && Option.isSome(cursor) && Option.isNone(incremental) && full
                ? [{ _tag: "Reset" as const, keep: plan.changedIds, since: full.since }]
                : [],
            ),
          ),
          Stream.concat(Stream.succeed(tail)),
        );
      }).pipe(Effect.withSpan("Gmail.pull")),
    ).pipe(Stream.mapError(readFailure(account.id)));

  const push = Effect.fn("Gmail.push")(
    function* (account: Account, providerId: string, op: MailOp) {
      if (op.kind === "categories" || op.kind === "copy")
        yield* new PermanentError({
          message: "This organization action is unavailable for Gmail.",
        });
      const path = `/messages/${encodeURIComponent(providerId)}`;
      if (op.kind === "trash") {
        yield* post(account.id, `${path}/trash`);
        return;
      }
      if (op.kind === "inbox") {
        // Untrash restores the labels the message had before trashing; the
        // modify below then makes sure it lands in the inbox.
        yield* post(account.id, `${path}/untrash`);
      }
      if (op.kind === "move" && op.labelId !== "TRASH") {
        const current = yield* get(
          account.id,
          Schema.Struct({ labelIds: Schema.optionalKey(Schema.Array(Schema.String)) }),
          `${path}?format=minimal`,
        );
        if (current.labelIds?.includes("TRASH")) yield* post(account.id, `${path}/untrash`);
      }
      const { add, remove } = gmailDelta(op);
      yield* post(account.id, `${path}/modify`, { addLabelIds: add, removeLabelIds: remove });
    },
    (effect, account) => Effect.mapError(effect, writeFailure(account.id)),
  );

  const fetchThreading = (accountId: string, providerId: string) =>
    get(
      accountId,
      Metadata,
      // Repeated metadataHeaders params; urlParams would need an array form.
      `/messages/${encodeURIComponent(providerId)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`,
    ).pipe(
      Effect.map(({ payload }): Threading => {
        const header = (name: string) =>
          payload.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
        return { messageId: header("Message-ID"), references: header("References") };
      }),
    );

  const send = Effect.fn("Gmail.send")(
    function* (
      account: Account,
      message: OutgoingMessage,
      original: Option.Option<{ providerId: string; threadId: string }>,
    ) {
      let threading: Threading = {};
      let threadId: string | undefined;
      if (Option.isSome(original)) {
        threading = yield* fetchThreading(account.id, original.value.providerId);
        // Forwards start a new thread; replies stay in the original one.
        if (message.mode !== "forward") threadId = original.value.threadId;
      }
      const traceId = crypto.randomUUID();
      const messageId = `<${traceId}@openmail.local>`;
      const started = yield* Clock.currentTimeMillis;
      const raw = yield* buildMime(
        message.from ?? { name: "", address: account.email },
        message,
        threading,
        { messageId, openmailId: traceId },
      );
      if (raw.byteLength > GMAIL_MIME_LIMIT)
        yield* new PermanentError({
          message:
            "Gmail MIME message exceeds 25 MB. Remove attachments or shorten the body before sending.",
        });
      yield* post(account.id, "/messages/send", {
        raw: raw.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
        ...(threadId ? { threadId } : {}),
      }).pipe(
        Effect.catchIf(
          (error) => error._tag === "ApiError" && (error.status === 0 || error.status >= 500),
          () =>
            confirmDelivery(
              Effect.gen(function* () {
                const found = yield* get(account.id, MessageList, "/messages", {
                  q: `in:sent rfc822msgid:${messageId}`,
                  maxResults: "1",
                });
                if (found.messages?.length) return true;
                // Gmail documents raw MIME and rfc822msgid searches, not preservation of a client ID.
                const recent = yield* get(account.id, MessageList, "/messages", {
                  q: `in:sent after:${Math.floor(started / 1000) - 60} subject:${JSON.stringify(message.subject)}`,
                  maxResults: "20",
                });
                for (const candidate of recent.messages ?? []) {
                  const metadata = yield* get(
                    account.id,
                    Metadata,
                    `/messages/${encodeURIComponent(candidate.id)}?format=metadata&metadataHeaders=X-OpenMail-Id`,
                  );
                  if (
                    metadata.payload.headers?.some(
                      (header) =>
                        header.name.toLowerCase() === "x-openmail-id" && header.value === traceId,
                    )
                  )
                    return true;
                }
                return false;
              }),
            ),
        ),
      );
    },
    (effect, account) =>
      Effect.mapError(effect, (error) =>
        error._tag === "SendUncertain" ? error : writeFailure(account.id)(error),
      ),
  );

  /**
   * The draft id behind a draft message. Gmail keeps the draft id stable but
   * gives the message a new id on every save; a draft that came in through a
   * pull is only known by its message id.
   */
  const findDraftId = Effect.fnUntraced(function* (accountId: string, messageId: string) {
    let pageToken: string | undefined;
    do {
      const page = yield* get(accountId, DraftList, "/drafts", {
        maxResults: "500",
        ...(pageToken ? { pageToken } : {}),
      });
      const found = page.drafts?.find((d) => d.message.id === messageId);
      if (found) return Option.some(found.id);
      pageToken = page.nextPageToken;
    } while (pageToken);
    return Option.none<string>();
  });

  const draftIdOf = (accountId: string, remote: DraftRemote | null) =>
    remote?.draftId
      ? Effect.succeed(Option.some(remote.draftId))
      : remote?.messageId
        ? findDraftId(accountId, remote.messageId)
        : Effect.succeed(Option.none<string>());

  const saveDraft = Effect.fn("Gmail.saveDraft")(
    function* (account: Account, draft: DraftPush) {
      const { message, original } = draft;
      let threading: Threading = {};
      let threadId: string | undefined;
      if (Option.isSome(original)) {
        threading = yield* fetchThreading(account.id, original.value.providerId);
        if (message.mode !== "forward") threadId = original.value.threadId;
      }
      const raw = yield* buildMime(
        message.from ?? { name: "", address: account.email },
        message,
        threading,
        { draft: true },
      );
      if (raw.byteLength > GMAIL_MIME_LIMIT)
        return yield* new PermanentError({
          message:
            "Gmail MIME message exceeds 25 MB. Remove attachments or shorten the body before sending.",
        });
      const body = {
        message: {
          raw: raw.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
          ...(threadId ? { threadId } : {}),
        },
      };
      const create = post(account.id, "/drafts", body);
      const existing = yield* draftIdOf(account.id, draft.remote);
      const current = Option.isSome(existing)
        ? yield* get(account.id, GmailDraft, `/drafts/${encodeURIComponent(existing.value)}`).pipe(
            Effect.map(Option.some),
            Effect.catchIf(is404, () => Effect.succeed(Option.none())),
          )
        : Option.none();
      const conflict =
        Option.isSome(current) &&
        !!draft.remote?.messageId &&
        current.value.message.id !== draft.remote.messageId;
      const saved = yield* (
        Option.isSome(existing) && !conflict
          ? // Deleted in another client meanwhile: the person is still writing it.
            put(account.id, `/drafts/${encodeURIComponent(existing.value)}`, body).pipe(
              Effect.catchIf(is404, () => create),
            )
          : create
      ).pipe(Effect.flatMap(decode(GmailDraft)));
      return {
        draftId: saved.id,
        messageId: saved.message.id,
        ...(conflict ? { conflict: true } : {}),
      } satisfies DraftRemote;
    },
    (effect, account) => Effect.mapError(effect, writeFailure(account.id)),
  );

  const deleteDraft = Effect.fn("Gmail.deleteDraft")(
    function* (account: Account, remote: DraftRemote) {
      const id = yield* draftIdOf(account.id, remote);
      if (Option.isNone(id)) return;
      yield* del(account.id, `/drafts/${encodeURIComponent(id.value)}`).pipe(
        Effect.catchIf(is404, () => Effect.void),
      );
    },
    (effect, account) => Effect.mapError(effect, writeFailure(account.id)),
  );

  const fetchRaw = Effect.fn("Gmail.fetchRaw")(
    function* (account: Account, providerId: string, maxBytes?: number) {
      if (maxBytes !== undefined) {
        const metadata = yield* get(
          account.id,
          Schema.Struct({ sizeEstimate: Schema.Number }),
          `/messages/${encodeURIComponent(providerId)}`,
          { format: "minimal", fields: "sizeEstimate" },
        );
        if (metadata.sizeEstimate > maxBytes || metadata.sizeEstimate <= 0)
          return yield* new PermanentError({ message: MEDIA_RAW_TOO_LARGE });
      }
      const { raw } = yield* get(
        account.id,
        RawMessage,
        `/messages/${encodeURIComponent(providerId)}`,
        {
          format: "raw",
        },
      );
      if (maxBytes !== undefined && (raw.length * 3) / 4 > maxBytes + 3)
        return yield* new PermanentError({ message: MEDIA_RAW_TOO_LARGE });
      return new Uint8Array(Buffer.from(raw, "base64"));
    },
    (effect, account) => Effect.mapError(effect, writeFailure(account.id)),
  );

  const fetchAttachment = Effect.fn("Gmail.fetchAttachment")(
    function* (account: Account, providerId: string, ref: AttachmentRef) {
      const message = yield* get(
        account.id,
        GmailMessage,
        `/messages/${encodeURIComponent(providerId)}`,
        {
          format: "full",
        },
      );
      const part = pickAttachment(attachmentParts(message.payload), (p) => p.filename ?? "", ref);
      if (!part) {
        const bytes = yield* fetchRaw(account, providerId);
        const parsed = yield* Effect.tryPromise({
          try: () => codec.parse(bytes),
          catch: () => new ProviderError({ message: "Cannot parse attachment MIME" }),
        });
        const rawAttachment = pickAttachment(
          parsed.attachments.filter((candidate) => !candidate.related),
          (candidate) => candidate.filename ?? "attachment",
          ref,
        );
        if (rawAttachment) return new Uint8Array(rawAttachment.content);
        return yield* new PermanentError({ message: `No attachment ${ref.filename}` });
      }
      // Small parts come inline; bigger ones through the attachments endpoint.
      const data = part.body.data
        ? part.body.data
        : part.body.attachmentId
          ? (yield* get(
              account.id,
              AttachmentBody,
              `/messages/${encodeURIComponent(providerId)}/attachments/${encodeURIComponent(part.body.attachmentId)}`,
            )).data
          : "";
      return new Uint8Array(Buffer.from(data, "base64"));
    },
    (effect, account) => Effect.mapError(effect, writeFailure(account.id)),
  );

  const settings = makeGmailSettings(get, (id, method, path, body) => {
    if (method === "POST") return post(id, path, body);
    if (method === "DELETE") return del(id, path);
    return put(id, path, body);
  });
  const search: ProviderAdapter["search"] = (account, query) =>
    Effect.gen(function* () {
      const labels = yield* fetchUserLabels(account.id);
      const limit = Math.max(1, Math.min(query.limit ?? 200, 1000));
      const messages: IncomingMessage[] = [];
      let pageToken: string | undefined;
      do {
        const page = yield* get(account.id, MessageList, "/messages", {
          q: gmailSearch(query, labels),
          ...(searchIncludesSpecialFolders(query) ? { includeSpamTrash: "true" } : {}),
          maxResults: String(Math.min(500, limit - messages.length)),
          ...(pageToken ? { pageToken } : {}),
        });
        const fetched = yield* Effect.forEach(
          page.messages ?? [],
          (m) => fetchMessage(account.id, m.id),
          { concurrency: CONCURRENCY },
        );
        for (const message of fetched) if (Option.isSome(message)) messages.push(message.value);
        pageToken = page.nextPageToken;
      } while (pageToken && messages.length < limit);
      return { messages, truncated: pageToken !== undefined };
    }).pipe(Effect.mapError(writeFailure(account.id)));
  const changeLabel: ProviderAdapter["changeLabel"] = (account, change) =>
    Effect.gen(function* () {
      if (change.kind === "create") {
        const current = yield* fetchUserLabels(account.id);
        const parent = current.find((l) => l.id === change.parentId)?.name;
        yield* post(account.id, "/labels", {
          name: parent ? `${parent}/${change.name}` : change.name,
          labelListVisibility: "labelShow",
          messageListVisibility: "show",
        });
      } else if (change.kind === "delete")
        yield* del(account.id, `/labels/${encodeURIComponent(change.id)}`);
      else if (change.kind === "parent") {
        const labels = yield* fetchUserLabels(account.id);
        const old = labels.find((l) => l.id === change.id);
        const parent = labels.find((l) => l.id === change.parentId);
        if (old) {
          const name = `${parent ? `${parent.name}/` : ""}${old.name.split("/").at(-1)}`;
          const moving = labels.filter(
            (candidate) => candidate.id === old.id || candidate.name.startsWith(`${old.name}/`),
          );
          const planned = moving.map((label) => ({
            label,
            name: name + label.name.slice(old.name.length),
          }));
          const otherNames = new Set(
            labels
              .filter((label) => !moving.some((item) => item.id === label.id))
              .map((label) => label.name.toLowerCase()),
          );
          if (planned.some((item) => otherNames.has(item.name.toLowerCase())))
            return yield* new ApiError({
              status: 400,
              body: "A label with the destination name already exists",
            });
          const patchName = (id: string, labelName: string) =>
            api(
              account.id,
              HttpClientRequest.bodyJsonUnsafe(
                HttpClientRequest.patch(`${API}/labels/${encodeURIComponent(id)}`),
                { name: labelName },
              ),
            );
          const renamed: typeof moving = [];
          for (const item of planned) {
            const result = yield* patchName(item.label.id, item.name).pipe(Effect.result);
            if (result._tag === "Failure") {
              let rollbackFailed = false;
              for (const previous of renamed.toReversed()) {
                const rollback = yield* patchName(previous.id, previous.name).pipe(Effect.result);
                rollbackFailed ||= rollback._tag === "Failure";
              }
              if (rollbackFailed)
                return yield* new ApiError({
                  status: 500,
                  body: "Moving the label failed and rollback was incomplete. Reload the labels before trying again.",
                });
              return yield* result.failure;
            }
            renamed.push(item.label);
          }
        }
      } else {
        const body =
          change.kind === "visibility"
            ? {
                labelListVisibility: change.labelListVisibility,
                messageListVisibility: change.messageListVisibility,
              }
            : change.kind === "rename"
              ? { name: change.name }
              : { color: { backgroundColor: change.color ?? "#ffffff", textColor: "#000000" } };
        yield* api(
          account.id,
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.patch(`${API}/labels/${encodeURIComponent(change.id)}`),
            body,
          ),
        );
      }
      return yield* fetchUserLabels(account.id);
    }).pipe(Effect.mapError(writeFailure(account.id)));

  const backfill: ProviderAdapter["backfill"] = (account, state, select) =>
    Effect.gen(function* () {
      const page = yield* get(account.id, MessageList, "/messages", {
        q: `before:${Math.ceil(state.before / 1000)}`,
        includeSpamTrash: "true",
        maxResults: "50",
        ...(state.cursor ? { pageToken: state.cursor } : {}),
      });
      const listed = (page.messages ?? []).map((m) => m.id);
      const ids = select ? yield* select(listed) : listed;
      const messages = yield* Effect.forEach(ids, (id) => fetchMessage(account.id, id), {
        concurrency: 2,
      });
      return {
        messages: messages.flatMap((m) => (Option.isSome(m) ? [m.value] : [])),
        cursor: page.nextPageToken ?? null,
        scanned: (page.messages ?? []).length,
      };
    }).pipe(Effect.mapError(readFailure(account.id)));

  return {
    backfill,
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
    pull,
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

export function gmailDelta(op: MailOp): { add: string[]; remove: string[] } {
  switch (op.kind) {
    case "read":
      return op.value ? { add: [], remove: ["UNREAD"] } : { add: ["UNREAD"], remove: [] };
    case "star":
      return op.value ? { add: ["STARRED"], remove: [] } : { add: [], remove: ["STARRED"] };
    case "important":
      return op.value ? { add: ["IMPORTANT"], remove: [] } : { add: [], remove: ["IMPORTANT"] };
    case "archive":
      return { add: [], remove: ["INBOX"] };
    case "inbox":
      return { add: ["INBOX"], remove: ["SPAM"] };
    case "trash":
      return { add: ["TRASH"], remove: [] };
    case "spam":
      return { add: ["SPAM"], remove: ["INBOX"] };
    case "move":
      return {
        add: [op.labelId],
        remove: [
          ...new Set([
            ...(op.removeLabelId && op.removeLabelId !== op.labelId && op.removeLabelId !== "TRASH"
              ? [op.removeLabelId]
              : []),
            ...(op.labelId !== "SPAM" ? ["SPAM"] : []),
          ]),
        ],
      };
    case "label":
      return op.value ? { add: [op.labelId], remove: [] } : { add: [], remove: [op.labelId] };
    case "categories":
    case "copy":
      return { add: [], remove: [] };
    default: {
      const exhaustive: never = op;
      return exhaustive;
    }
  }
}

/** Parts with a filename, in the order `parseGmailMessage` lists them as attachments. */
export function attachmentParts(payload: GmailPart): GmailPart[] {
  const out: GmailPart[] = [];
  const walk = (part: GmailPart) => {
    if (part.filename) out.push(part);
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  return out;
}

export function parseGmailMessage(raw: GmailMessage): IncomingMessage {
  const headers = new Map(
    (raw.payload.headers ?? []).map((h) => [h.name.toLowerCase(), h.value] as const),
  );
  let text = "";
  let html = "";
  const attachments: Attachment[] = [];
  const calendarParts: GmailPart[] = [];
  const walk = (part: GmailPart) => {
    if (part.mimeType === "text/calendar" || /\.ics$/i.test(part.filename ?? ""))
      calendarParts.push(part);
    if (part.filename) {
      attachments.push({ filename: part.filename, mimeType: part.mimeType, size: part.body.size });
    } else if (part.body.data) {
      const partHeaders = new Map(
        (part.headers ?? []).map((h) => [h.name.toLowerCase(), h.value] as const),
      );
      // Gmail's API hands text parts over already converted to UTF-8, while
      // the part header keeps the sender's charset (gb2312 from Outlook,
      // for example). Decoding by the header would garble them.
      const decoded = decodeUtf8First(
        Buffer.from(part.body.data, "base64"),
        charsetOf(partHeaders.get("content-type")),
      );
      if (part.mimeType === "text/plain" && !text) text = decoded;
      else if (part.mimeType === "text/html" && !html) html = decoded;
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(raw.payload);

  const labels = raw.labelIds ?? [];
  const from = parseAddressList(headers.get("from"))[0] ?? { name: "", address: "" };
  return withUuAttachments({
    providerId: raw.id,
    threadId: raw.threadId,
    subject: decodeHeader(headers.get("subject") ?? ""),
    from,
    to: parseAddressList(headers.get("to")),
    cc: parseAddressList(headers.get("cc")),
    bcc: parseAddressList(headers.get("bcc")),
    headers: (raw.payload.headers ?? []).map((h) => ({
      name: h.name.toLowerCase(),
      value: h.value,
    })),
    ...(headers.get("message-id") ? { rfcMessageId: headers.get("message-id") } : {}),
    ...(raw.sizeEstimate !== undefined ? { size: raw.sizeEstimate } : {}),
    replyTo: parseAddressList(headers.get("reply-to")),
    date: Number(raw.internalDate),
    snippet: decodeEntities(raw.snippet ?? ""),
    bodyText: text || htmlToText(html),
    bodyHtml: html,
    security: messageSecurity(raw.payload.headers ?? [], "gmail"),
    ...(calendarParts.length ? { hasCalendar: true } : {}),
    labels,
    attachments,
    isUnread: labels.includes("UNREAD"),
    isStarred: labels.includes("STARRED"),
  });
}

// Gmail's snippet is HTML-escaped.
function decodeEntities(s: string): string {
  return s
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

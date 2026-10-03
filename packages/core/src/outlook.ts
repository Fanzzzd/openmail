import { BASE_SCOPES, OPTIONAL_SCOPES } from "./optional-services.js";
import { logProviderFailure, makeOptionalPermissions } from "./provider-diagnostics.js";
import { confirmDelivery } from "./provider-send.js";
import { cleanDisplayName, messageSecurity } from "./message-security.js";
import { retryProviderRequest, isProviderSend, retryAfterMillis } from "./provider-retry.js";
import { PlatformCrypto } from "./platform/crypto.js";
import {
  hasSignedContainer,
  withDecodedBody,
  withUuAttachments,
  MAX_MIME_BYTES,
} from "./platform/mime-compat.js";
import { MailCodec } from "./platform/mail-codec.js";
import { Buffer } from "./platform/bytes.js";
import { categoryKey, mergeCategoryNames } from "./categories.js";
import { composeTransportHtml } from "./compose-body.js";
import {
  FOLDER_BATCH_LIMIT,
  type DeleteFolder,
  type PermanentDeleteBatch,
} from "./folder-actions.js";
import { Clock, Data, Effect, Option, Queue, Schema, Semaphore, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { attachmentProblem, attachmentProblemMessage } from "./attachment-policy.js";

import { type AttachmentRef, pickAttachment, MEDIA_RAW_TOO_LARGE } from "./attachments.js";
import type {
  Account,
  Address,
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
import { buildMime as unboundBuildMime } from "./compose.js";
import { MarkdownDraftSource, markdownDraftSource } from "./markdown-draft.js";
import { htmlDocument, htmlToText } from "./mime.js";
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

import { graphSearch, matchesSearch, parseSearchQuery, searchMailboxLabel } from "./search.js";
import { makeProviderCalendar } from "./provider-calendar.js";
import { makeOutlookFeatures } from "./outlook-features.js";
import { makeOutlookSettings } from "./outlook-settings.js";

// `consumers` scopes sign-in to personal Microsoft accounts (outlook.com,
// hotmail, live). Work/school accounts need a tenant admin to consent to the
// app first, which openmail deliberately does not work around.
const TENANT = "consumers";
const AUTH_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`;
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
const GRAPH = "https://graph.microsoft.com/v1.0";
// offline_access is what makes Graph return a refresh token. Accounts added
// under the old Mail.Read scope get a 403 on their first write and are asked
// to sign in again.
const SCOPES = BASE_SCOPES.outlook;
// Immutable ids survive moves between folders, so a message archived here
// keeps its local row and any queued op still finds it.
const PREFER = { prefer: 'IdType="ImmutableId"' };
/** Cursor key recording that stored ids are immutable. Older cursors trigger a clean resync. */
const ID_TYPE_KEY = "__idType";

// Folders synced, and the mailbox label each maps to. A Graph message lives in
// exactly one folder, so its id is unique and needs no cross-folder dedup.
/** Well-known folders synced under a fixed label. Other system folders (outbox and so on) are skipped. */
const WELL_KNOWN: readonly { name: string; label: string }[] = [
  { name: "inbox", label: "INBOX" },
  { name: "sentitems", label: "SENT" },
  { name: "drafts", label: "DRAFT" },
  { name: "junkemail", label: "SPAM" },
  { name: "deleteditems", label: "TRASH" },
  { name: "archive", label: "ARCHIVE" },
];
const SKIPPED = [
  "outbox",
  "conversationhistory",
  "syncissues",
  "conflicts",
  "localfailures",
  "serverfailures",
  "scheduled",
  "clutter",
  "searchfolders",
];

const SELECT =
  "id,conversationId,subject,bodyPreview,body,from,toRecipients,ccRecipients,replyTo," +
  "receivedDateTime,sentDateTime,isRead,isDraft,hasAttachments,flag,importance,webLink,categories,internetMessageId,bccRecipients";
// Header selection is supported on ordinary message GETs, not requested from delta.
const MESSAGE_SELECT = `${SELECT},internetMessageHeaders`;
const PAGE_SIZE = 50;
const CONCURRENCY = 4;
const EXPAND_ATTACHMENTS = "$expand=attachments($select=name,contentType,size,isInline)";

/** sendMail and attachment POSTs carry files inline; Graph caps a request at 4 MB. */
const REQUEST_LIMIT = 4 * 1024 * 1024;

// Provider JSON. Only the fields openmail reads; extra fields are ignored.
// Drafts come with null subject, sender and sent time, so those are lenient.

const GraphAddress = Schema.Struct({
  emailAddress: Schema.optionalKey(
    Schema.Struct({
      name: Schema.optionalKey(Schema.String),
      address: Schema.optionalKey(Schema.String),
    }),
  ),
});
type GraphAddress = typeof GraphAddress.Type;

const GraphAttachment = Schema.Struct({
  name: Schema.String,
  contentType: Schema.String,
  size: Schema.Number,
  isInline: Schema.optionalKey(Schema.Boolean),
});
const GraphMessage = Schema.Struct({
  attachments: Schema.optionalKey(Schema.Array(GraphAttachment)),
  "@odata.type": Schema.optionalKey(Schema.String),
  id: Schema.String,
  conversationId: Schema.String,
  webLink: Schema.optionalKey(Schema.NullOr(Schema.String)),
  subject: Schema.optionalKey(Schema.NullOr(Schema.String)),
  bodyPreview: Schema.optionalKey(Schema.String),
  body: Schema.optionalKey(Schema.Struct({ contentType: Schema.String, content: Schema.String })),
  from: Schema.optionalKey(Schema.NullOr(GraphAddress)),
  toRecipients: Schema.optionalKey(Schema.Array(GraphAddress)),
  ccRecipients: Schema.optionalKey(Schema.Array(GraphAddress)),
  replyTo: Schema.optionalKey(Schema.Array(GraphAddress)),
  bccRecipients: Schema.optionalKey(Schema.Array(GraphAddress)),
  internetMessageHeaders: Schema.optionalKey(
    Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
  ),
  internetMessageId: Schema.optionalKey(Schema.String),
  receivedDateTime: Schema.optionalKey(Schema.NullOr(Schema.String)),
  sentDateTime: Schema.optionalKey(Schema.NullOr(Schema.String)),
  isRead: Schema.optionalKey(Schema.Boolean),
  isDraft: Schema.optionalKey(Schema.Boolean),
  hasAttachments: Schema.optionalKey(Schema.Boolean),
  parentFolderId: Schema.optionalKey(Schema.String),
  categories: Schema.optionalKey(Schema.Array(Schema.String)),
  importance: Schema.optionalKey(Schema.String),
  flag: Schema.optionalKey(Schema.Struct({ flagStatus: Schema.optionalKey(Schema.String) })),
});
export type GraphMessage = typeof GraphMessage.Type;

/** A delta entry for a message that left the folder or was deleted. */
const Removed = Schema.Struct({ id: Schema.String, "@removed": Schema.Struct({}) });

/**
 * A delta entry that carries only some of the selected fields. Graph sends
 * these for some changes in an incremental round; the message is fetched whole.
 */
const Partial = Schema.Struct({ id: Schema.String });

const DeltaPage = Schema.Struct({
  value: Schema.Array(Schema.Union([Removed, GraphMessage, Partial])),
  "@odata.nextLink": Schema.optionalKey(Schema.String),
  "@odata.deltaLink": Schema.optionalKey(Schema.String),
});

const FolderPage = Schema.Struct({
  value: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      displayName: Schema.String,
      childFolderCount: Schema.Number,
      totalItemCount: Schema.Number,
    }),
  ),
  "@odata.nextLink": Schema.optionalKey(Schema.String),
});

const AttachmentList = Schema.Struct({
  value: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      contentType: Schema.String,
      size: Schema.Number,
      isInline: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});

const AttachmentNames = Schema.Struct({
  value: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      isInline: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});

const AttachmentIds = Schema.Struct({
  value: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      isInline: Schema.optionalKey(Schema.Boolean),
      contentId: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
});

const Me = Schema.Struct({
  mail: Schema.optionalKey(Schema.NullOr(Schema.String)),
  userPrincipalName: Schema.String,
});

const WithId = Schema.Struct({ id: Schema.String });

/**
 * Per-folder delta links, stored as the account's opaque sync cursor. Keyed by
 * well-known name for system folders and by folder id for custom ones.
 */
const Cursor = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const decodeCursor = Schema.decodeUnknownOption(Cursor);

/** One folder to sync: its delta key, the Graph path segment, and the label its messages get. */
interface SyncFolder {
  key: string;
  path: string;
  label: string;
}

/** A non-2xx response, or a transport failure as status 0, before it becomes a ProviderFailure. */
class ApiError extends Data.TaggedError("ApiError")<{
  status: number;
  body: string;
  retryAfter?: string;
  deferred?: boolean;
}> {}

// 429 throttling and 5xx are transient; back off and retry.
const isTransient = (e: ApiError) => e.status === 0 || e.status === 429 || e.status >= 500;

const is404 = (e: { _tag: string }) => e instanceof ApiError && e.status === 404;
/** Graph expires delta links it no longer tracks (syncStateNotFound). */
const is410 = (e: { _tag: string }) => e instanceof ApiError && e.status === 410;

/**
 * Maps a failed call to what the op queue does next: sign in again, drop the
 * op, or retry later. On reads a 404 that matters (no Archive folder) is
 * caught before this; any other is worth retrying later.
 */
const readFailure =
  (accountId: string) =>
  (e: ApiError | AuthError | ProviderError): AuthError | ProviderError => {
    if (e._tag !== "ApiError") return e;
    const message = `Graph API ${e.status}: ${e.body}`;
    if (e.status === 401) return new AuthError({ accountId, message });
    return new ProviderError({
      message,
      status: e.status,
      ...(e.deferred ? { deferred: true } : {}),
    });
  };

/** Writes Graph will never accept (bad folder id, message gone) are dropped. */
const writeFailure =
  (accountId: string) =>
  (e: ApiError | ProviderFailure): ProviderFailure =>
    e._tag === "ApiError" && (e.status === 400 || e.status === 404)
      ? new PermanentError({ message: `Graph API ${e.status}: ${e.body}` })
      : e._tag === "PermanentError"
        ? e
        : readFailure(accountId)(e);

const decode =
  <A>(schema: Schema.Decoder<A>) =>
  (json: unknown): Effect.Effect<A, ProviderError> =>
    Schema.decodeUnknownEffect(schema)(json).pipe(
      Effect.mapError(
        (e) => new ProviderError({ message: `Unexpected Graph response: ${e.message}` }),
      ),
    );

const expandedAttachments = (raw: GraphMessage): Attachment[] | undefined =>
  raw.attachments
    ?.filter((a) => !a.isInline)
    .map((a) => ({ filename: a.name, mimeType: a.contentType, size: a.size }));

export const makeOutlook: Effect.Effect<
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

  // One refresh at a time: Graph may rotate the refresh token, and two
  // parallel refreshes would race to save it.
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
            message: "No Microsoft refresh token; sign in again",
          });
        }
        const { microsoft } = yield* config.read;
        if (!microsoft) {
          return yield* new ProviderError({
            message: "No Microsoft OAuth client configured",
            reason: "configuration",
          });
        }
        const res = yield* oauth
          .refresh(accountId, {
            tokenUrl: TOKEN_URL,
            clientId: microsoft.clientId,
            refreshToken: refreshToken.value,
          })
          .pipe(
            Effect.tapError((error) =>
              logProviderFailure("outlook", accountId, HttpClientRequest.post(TOKEN_URL), error),
            ),
          );
        if (Option.isSome(res.refreshToken)) yield* secrets.set(accountId, res.refreshToken.value);
        tokens.set(accountId, { token: res.accessToken, expiresAt: now + res.expiresIn * 1000 });
        return res.accessToken;
      }),
    );

  /** Sends one request with retries; resolves to the parsed JSON body, or null for 202/204. */
  const execute = (token: string, request: HttpClientRequest.HttpClientRequest) =>
    retryProviderRequest(
      Effect.gen(function* () {
        const res = yield* http.execute(
          request.pipe(
            HttpClientRequest.bearerToken(token),
            HttpClientRequest.setHeader("prefer", request.headers.prefer ?? PREFER.prefer),
          ),
        );
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

  const requestLocks = new Map<string, Semaphore.Semaphore>();
  const requestLock = (accountId: string) => {
    let lock = requestLocks.get(accountId);
    if (!lock) {
      lock = Semaphore.makeUnsafe(CONCURRENCY);
      requestLocks.set(accountId, lock);
    }
    return lock;
  };

  const permissions = makeOptionalPermissions<ApiError | AuthError | ProviderError>();
  const api = (accountId: string, request: HttpClientRequest.HttpClientRequest) =>
    permissions
      .run(
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
          Effect.tapError((e) => logProviderFailure("outlook", accountId, request, e)),
          Effect.tapError((e) =>
            e._tag === "ApiError" && e.status === 401
              ? Effect.sync(() => tokens.delete(accountId))
              : Effect.void,
          ),
        ),
      )
      .pipe(requestLock(accountId).withPermits(1));

  const headersDenied = new Set<string>();
  /** `path` is a path under GRAPH, or a full https URL (delta and next links are absolute). */
  const get = <A>(accountId: string, schema: Schema.Decoder<A>, path: string) =>
    Effect.suspend(() => {
      const url = new URL(path.startsWith("https://") ? path : `${GRAPH}${path}`);
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
        return HttpClientRequest.get(url.toString());
      };
      return api(
        accountId,
        hasHeaders && headersDenied.has(accountId)
          ? withoutHeaders()
          : HttpClientRequest.get(url.toString()),
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
        const links = new Set<string>();
        while (path !== null) {
          if (links.has(path))
            return yield* new PermanentError({
              message: "Deleted folder pagination repeated a page.",
            });
          links.add(path);
          const children: typeof Page.Type = yield* get(account.id, Page, path);
          pending.push(...children.value.map((child) => child.id));
          const next = children["@odata.nextLink"];
          if (next) {
            const url = yield* Effect.try({
              try: () => new URL(next),
              catch: () =>
                new PermanentError({ message: "Invalid deleted folder pagination link." }),
            });
            if (url.origin !== "https://graph.microsoft.com" || url.pathname !== `/v1.0${base}`)
              return yield* new PermanentError({
                message: "Invalid deleted folder pagination link.",
              });
            path = `${url.pathname.slice("/v1.0".length)}${url.search}`;
          } else path = null;
        }
      }
      return ids;
    });

  /** A GET whose body is not JSON (a message's MIME source). */
  const getBytesAttempt = (accountId: string, path: string, maxBytes?: number) =>
    accessToken(accountId).pipe(
      Effect.flatMap((token) =>
        retryProviderRequest(
          Effect.gen(function* () {
            const res = yield* http.execute(
              HttpClientRequest.get(`${GRAPH}${path}`).pipe(
                HttpClientRequest.bearerToken(token),
                HttpClientRequest.setHeaders(PREFER),
              ),
            );
            if (res.status < 200 || res.status >= 300) {
              return yield* new ApiError({
                status: res.status,
                body: yield* res.text,
                ...(res.headers["retry-after"] ? { retryAfter: res.headers["retry-after"] } : {}),
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
              Effect.fail(new ApiError({ status: 0, body: e.message })),
            ),
          ),
          HttpClientRequest.get(`${GRAPH}${path}`),
          (error) => error._tag === "ApiError" && isTransient(error),
        ).pipe(requestLock(accountId).withPermits(1)),
      ),
    );

  const getBytes = (accountId: string, path: string, maxBytes?: number) =>
    getBytesAttempt(accountId, path, maxBytes).pipe(
      Effect.catchIf(
        (error) => error._tag === "ApiError" && error.status === 401,
        () =>
          Effect.sync(() => tokens.delete(accountId)).pipe(
            Effect.andThen(getBytesAttempt(accountId, path, maxBytes)),
          ),
      ),
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
    headersDenied.clear();
    return {
      email: me.mail ?? me.userPrincipalName,
      secret: res.refreshToken.value,
      scopes: res.scopes ?? [],
    };
  });

  // Server writes are authoritative while Graph folder listings catch up.
  const pendingFolders = new Map<
    string,
    Map<string, { name: string | null; previousName?: string }>
  >();
  const rememberFolder = (
    accountId: string,
    id: string,
    change: { name: string | null; previousName?: string },
  ) => {
    let pending = pendingFolders.get(accountId);
    if (!pending) {
      pending = new Map();
      pendingFolders.set(accountId, pending);
    }
    pending.set(id, change);
  };

  const mergeFolderChanges = (
    accountId: string,
    listedFolders: readonly { id: string; name: string }[],
    confirmed: boolean,
  ) => {
    const pending = pendingFolders.get(accountId);
    if (!pending) return listedFolders;
    const folders = new Map(listedFolders.map((folder) => [folder.id, folder]));
    for (const [id, change] of pending) {
      const listed = folders.get(id);
      if (confirmed && ((change.name === null && !listed) || listed?.name === change.name)) {
        pending.delete(id);
        continue;
      }
      if (change.name === null) {
        folders.delete(id);
        if (listed)
          for (const [childId, child] of folders)
            if (child.name.startsWith(`${listed.name}/`)) folders.delete(childId);
      } else {
        folders.set(id, { id, name: change.name });
        if (change.previousName)
          for (const [childId, child] of folders)
            if (child.name.startsWith(`${change.previousName}/`))
              folders.set(childId, {
                ...child,
                name: `${change.name}${child.name.slice(change.previousName.length)}`,
              });
      }
    }
    if (!pending.size) pendingFolders.delete(accountId);
    return [...folders.values()];
  };

  /**
   * User folders, nested names joined with "/". Skipped system folders are left
   * out together with their subfolders (Sync Issues holds Conflicts and so on),
   * including empty folders so newly created folders can be organized.
   */
  const listCustomFolders = Effect.fnUntraced(function* (accountId: string) {
    const systemIds = yield* Effect.forEach(
      [...WELL_KNOWN.map((f) => f.name), ...SKIPPED],
      (name) =>
        get(accountId, WithId, `/me/mailFolders/${encodeURIComponent(name)}?$select=id`).pipe(
          Effect.map(({ id }) => Option.some({ name, id })),
          // Not every mailbox has every well-known folder.
          Effect.catchIf(is404, () => Effect.succeed(Option.none())),
        ),
      { concurrency: 4 },
    );
    const system = new Set<string>();
    const skipped = new Set<string>();
    for (const found of systemIds) {
      if (Option.isNone(found)) continue;
      system.add(found.value.id);
      if (SKIPPED.includes(found.value.name)) skipped.add(found.value.id);
    }

    const out: { id: string; name: string }[] = [];
    const walk = (
      path: string,
      prefix: string,
    ): Effect.Effect<void, ApiError | AuthError | ProviderError> =>
      Effect.gen(function* () {
        let url: string | undefined =
          `${path}?$select=id,displayName,childFolderCount,totalItemCount&$top=100&includeHiddenFolders=false`;
        while (url) {
          const page: typeof FolderPage.Type = yield* get(accountId, FolderPage, url);
          for (const f of page.value) {
            if (skipped.has(f.id)) continue;
            const name = prefix ? `${prefix}/${f.displayName}` : f.displayName;
            if (!system.has(f.id)) out.push({ id: f.id, name });
            if (f.childFolderCount > 0)
              yield* walk(`/me/mailFolders/${encodeURIComponent(f.id)}/childFolders`, name);
          }
          url = page["@odata.nextLink"];
        }
      });
    yield* walk("/me/mailFolders", "");
    return mergeFolderChanges(accountId, out, true);
  });

  /**
   * Follows a folder's delta from `start` (an initial delta URL or a stored
   * deltaLink) to the end, collecting changed messages and removed ids. The
   * final deltaLink is the cursor for the next sync.
   */

  const fetchAttachments = (accountId: string, id: string) =>
    get(
      accountId,
      AttachmentList,
      `/me/messages/${encodeURIComponent(id)}/attachments?$select=name,contentType,size,isInline`,
    ).pipe(
      // Inline parts are embedded images (signatures, tracking), not real files.
      Effect.map(({ value }): Attachment[] =>
        value
          .filter((a) => !a.isInline)
          .map((a) => ({ filename: a.name, mimeType: a.contentType, size: a.size })),
      ),
    );

  const incomingGraph = (
    account: Account,
    raw: GraphMessage,
    label: string,
    attachments: readonly Attachment[],
  ) => {
    const message = parseGraphMessage(raw, label, attachments);
    if (!hasSignedContainer(message)) return Effect.succeed(message);
    return fetchRaw(account, raw.id, MAX_MIME_BYTES).pipe(
      Effect.catchTag("PermanentError", (error) =>
        Effect.fail(new ProviderError({ message: error.message })),
      ),
      Effect.flatMap((source) =>
        Effect.tryPromise({
          try: () => codec.parse(source),
          catch: () => new ProviderError({ message: "Cannot parse signed MIME" }),
        }),
      ),
      Effect.map((parsed) => withDecodedBody(message, parsed)),
      Effect.catch(() => Effect.succeed(message)),
    );
  };
  const pull = (
    account: Account,
    cursor: Option.Option<string>,
    scope?: "inbox",
    incrementalOnly = false,
  ): Stream.Stream<Change, ProviderFailure> =>
    Stream.callback<Change, ProviderFailure>(
      (queue) =>
        Effect.gen(function* () {
          const stored: Readonly<Record<string, string>> = Option.getOrElse(
            Option.flatMap(cursor, decodeCursor),
            () => ({}),
          );
          const reset = stored[ID_TYPE_KEY] !== "immutable";
          const previous = reset ? {} : stored;
          const custom = scope ? [] : yield* listCustomFolders(account.id);
          const folders: SyncFolder[] = [
            ...WELL_KNOWN.filter((f) => !scope || f.name === "inbox").map((f) => ({
              key: f.name,
              path: f.name,
              label: f.label,
            })),
            ...custom.map((f) => ({ key: f.id, path: f.id, label: f.id })),
          ];
          let started = false;
          const start = Effect.gen(function* () {
            if (started) return;
            started = true;
            if (!scope)
              yield* Queue.offer(queue, {
                _tag: "Labels",
                labels: custom.map((f) => ({ id: f.id, name: f.name, color: null })),
              });
          });
          // Only identities cross page boundaries. Full Graph bodies belong to one
          // page, with backpressure from the bounded sync queue.
          const kept = new Set<string>();
          const restarted = new Set<string>();
          const removed = new Set<string>();
          const next: Record<string, string> = { [ID_TYPE_KEY]: "immutable" };
          let fetched = 0;
          for (const folder of folders) {
            const known = previous[folder.key];
            if (incrementalOnly && known === undefined)
              yield* new ProviderError({ message: "Foreground sync required to renew the cursor" });
            const initial = `${GRAPH}/me/mailFolders/${encodeURIComponent(folder.path)}/messages/delta?$select=${SELECT}&${EXPAND_ATTACHMENTS}&$top=${PAGE_SIZE}`;
            const first = yield* get(account.id, DeltaPage, known ?? initial).pipe(
              Effect.map(Option.some),
              Effect.catchIf(
                (e) => known === undefined && is404(e),
                () => Effect.succeed(Option.none()),
              ),
              Effect.catchIf(
                (e) => !incrementalOnly && known !== undefined && is410(e),
                () =>
                  Effect.gen(function* () {
                    const fresh = yield* get(account.id, DeltaPage, initial);
                    yield* start;
                    restarted.add(folder.label);
                    return Option.some(fresh);
                  }),
              ),
            );
            if (Option.isNone(first)) continue;
            yield* start;
            let page = first.value;
            for (;;) {
              const total = fetched + page.value.filter((item) => !("@removed" in item)).length;
              yield* Stream.fromIterable(page.value).pipe(
                Stream.mapEffect(
                  (item) =>
                    Effect.gen(function* () {
                      if ("@removed" in item) {
                        removed.add(item.id);
                        return null;
                      }
                      const message =
                        "conversationId" in item
                          ? Option.some(item)
                          : yield* get(
                              account.id,
                              GraphMessage,
                              `/me/messages/${encodeURIComponent(item.id)}?$select=${MESSAGE_SELECT}&${EXPAND_ATTACHMENTS}`,
                            ).pipe(
                              Effect.map(Option.some),
                              Effect.catchIf(is404, () => Effect.succeed(Option.none())),
                            );
                      if (Option.isNone(message)) return null;
                      const raw = message.value;
                      const attachments =
                        expandedAttachments(raw) ??
                        (raw.hasAttachments ? yield* fetchAttachments(account.id, raw.id) : []);
                      kept.add(raw.id);
                      return {
                        _tag: "Upsert",
                        message: yield* incomingGraph(account, raw, folder.label, attachments),
                      } satisfies Change;
                    }),
                  { concurrency: CONCURRENCY },
                ),
                Stream.runForEach((change) =>
                  Effect.gen(function* () {
                    if (!change) return;
                    yield* Queue.offer(queue, change);
                    yield* Queue.offer(queue, { _tag: "Progress", fetched: ++fetched, total });
                  }),
                ),
              );
              if (page["@odata.deltaLink"]) next[folder.key] = page["@odata.deltaLink"];
              const url = page["@odata.nextLink"];
              if (!url) break;
              page = yield* get(account.id, DeltaPage, url);
            }
          }
          // Moves can appear as both removed and changed. A change in any folder
          // wins; deletes and the checkpoint follow successful delivery of all pages.
          yield* start;
          const keep = [...kept];
          if (reset) yield* Queue.offer(queue, { _tag: "Reset", keep });
          else
            for (const label of restarted)
              yield* Queue.offer(queue, { _tag: "DeleteLabel", label, keep });
          for (const providerId of removed)
            if (!kept.has(providerId)) yield* Queue.offer(queue, { _tag: "Delete", providerId });
          const wellKnown = new Set(WELL_KNOWN.map((f) => f.name));
          for (const key of Object.keys(previous))
            if (key !== ID_TYPE_KEY && !wellKnown.has(key) && !(key in next))
              yield* Queue.offer(queue, { _tag: "DeleteLabel", label: key });
          yield* Queue.offer(queue, { _tag: "Cursor", cursor: JSON.stringify(next) });
          yield* Queue.end(queue);
        }).pipe(
          Effect.withSpan("Outlook.pull"),
          Effect.mapError(readFailure(account.id)),
          Effect.catchCause((cause) => Queue.failCause(queue, cause)),
        ),
      { bufferSize: 16, strategy: "suspend" },
    );

  const push = Effect.fn("Outlook.push")(
    function* (account: Account, providerId: string, op: MailOp) {
      if (op.kind === "copy")
        yield* new PermanentError({
          message: "Folder copies are available for IMAP accounts.",
        });
      const path = `/me/messages/${encodeURIComponent(providerId)}`;
      if (op.kind === "read") {
        yield* write(account.id, "PATCH", path, { isRead: op.value });
        return;
      }
      if (op.kind === "important") {
        yield* write(account.id, "PATCH", path, { importance: op.value ? "high" : "normal" });
        return;
      }
      if (op.kind === "star") {
        yield* write(account.id, "PATCH", path, {
          flag: { flagStatus: op.value ? "flagged" : "notFlagged" },
        });
        return;
      }
      if (op.kind === "categories") {
        const current = yield* get(
          account.id,
          Schema.Struct({ categories: Schema.optionalKey(Schema.Array(Schema.String)) }),
          `${path}?$select=categories`,
        );
        const Page = Schema.Struct({
          value: Schema.Array(Schema.Struct({ displayName: Schema.String })),
          "@odata.nextLink": Schema.optionalKey(Schema.String),
        });
        const registered = new Map<string, string>();
        let next: string | undefined = "/me/outlook/masterCategories?$select=displayName";
        const seen = new Set<string>();
        while (next) {
          if (seen.has(next) || seen.size >= 100)
            yield* new PermanentError({
              message: "Category pagination repeated or exceeded its limit.",
            });
          seen.add(next);
          if (
            next.startsWith("https://") &&
            !next.startsWith(`${GRAPH}/me/outlook/masterCategories?`)
          )
            yield* new PermanentError({ message: "Invalid category pagination URL." });
          const page: typeof Page.Type = yield* get(account.id, Page, next);
          for (const category of page.value)
            registered.set(categoryKey(category.displayName), category.displayName);
          next = page["@odata.nextLink"];
        }
        const additions: string[] = [];
        for (const name of mergeCategoryNames([], op.add, [])) {
          const key = categoryKey(name);
          if (!registered.has(key)) {
            const created = yield* write(account.id, "POST", "/me/outlook/masterCategories", {
              displayName: name,
              color: "none",
            }).pipe(Effect.flatMap(decode(Schema.Struct({ displayName: Schema.String }))));
            registered.set(key, created.displayName);
          }
          additions.push(registered.get(key) ?? name);
        }
        yield* write(account.id, "PATCH", path, {
          categories: mergeCategoryNames(current.categories ?? [], additions, op.remove),
        });
        return;
      }
      const destinationId = destination(op);
      if (destinationId) yield* write(account.id, "POST", `${path}/move`, { destinationId });
    },
    (effect, account) => Effect.mapError(effect, writeFailure(account.id)),
  );

  const deliveryLookup = (accountId: string, messageId: string, folder = "sentitems") =>
    get(
      accountId,
      Schema.Struct({ value: Schema.Array(WithId) }),
      `/me/mailFolders/${folder}/messages?${new URLSearchParams({ $filter: `internetMessageId eq '${messageId.replaceAll("'", "''")}'`, $select: "id", $top: "1" }).toString()}`,
    );
  const deliver = (accountId: string, messageId: string, effect: ReturnType<typeof api>) =>
    effect.pipe(
      Effect.catchIf(
        (error) => error._tag === "ApiError" && (error.status === 0 || error.status >= 500),
        () =>
          confirmDelivery(
            deliveryLookup(accountId, messageId).pipe(Effect.map((found) => !!found.value.length)),
          ).pipe(Effect.as(null)),
      ),
    );

  const send = Effect.fn("Outlook.send")(
    function* (
      account: Account,
      message: OutgoingMessage,
      original: Option.Option<{ providerId: string; threadId: string }>,
    ) {
      yield* checkAttachmentSize(message);
      const messageId = `<${crypto.randomUUID()}@openmail.local>`;
      const fields = { ...graphFields(message), internetMessageId: messageId };
      const attachments = message.attachments.map(fileAttachment);
      const mode = message.mode ?? "new";
      if ((Option.isNone(original) || mode === "new") && forwardsMessage(message)) {
        // A forwarded .eml goes out as raw MIME, which Graph's sendMail also
        // takes: as a JSON fileAttachment Exchange re-encodes the .eml as an
        // opaque base64 file, and Gmail previews it as text in a guessed
        // charset. In MIME it is a real message/rfc822 part.
        const mime = yield* buildMime(
          { name: "", address: account.email },
          message,
          {},
          { messageId },
        );
        const body = mime.toString("base64");
        yield* checkRequestSize(body);
        yield* deliver(
          account.id,
          messageId,
          api(
            account.id,
            HttpClientRequest.post(`${GRAPH}/me/sendMail`).pipe(
              HttpClientRequest.bodyText(body, "text/plain"),
            ),
          ),
        );
      } else if (Option.isNone(original) || mode === "new") {
        yield* deliver(
          account.id,
          messageId,
          write(account.id, "POST", "/me/sendMail", {
            message: { ...fields, attachments },
            saveToSentItems: true,
          }),
        );
      } else {
        // Replies and forwards go through a draft so Outlook sets the threading
        // headers and conversation itself.
        const action = {
          reply: "createReply",
          replyAll: "createReplyAll",
          forward: "createForward",
        }[mode];
        const draft = yield* write(
          account.id,
          "POST",
          `/me/messages/${encodeURIComponent(original.value.providerId)}/${action}`,
          { message: { internetMessageId: messageId } },
        ).pipe(
          Effect.flatMap(decode(WithId)),
          Effect.catchIf(
            (error) => error._tag === "ApiError" && (error.status === 0 || error.status >= 500),
            (error) => {
              const cleanup = deliveryLookup(account.id, messageId, "drafts").pipe(
                Effect.flatMap((found) =>
                  Effect.forEach(
                    found.value,
                    (orphan) =>
                      write(account.id, "DELETE", `/me/messages/${encodeURIComponent(orphan.id)}`),
                    { discard: true },
                  ).pipe(Effect.as(found.value.length > 0)),
                ),
              );
              return confirmDelivery(cleanup).pipe(
                Effect.result,
                Effect.asVoid,
                Effect.andThen(Effect.fail(error)),
              );
            },
          ),
        );
        const path = `/me/messages/${encodeURIComponent(draft.id)}`;
        let sendAttempted = false;
        yield* Effect.gen(function* () {
          yield* write(account.id, "PATCH", path, fields);
          if (mode === "forward" && message.includeOriginalAttachments !== undefined) {
            const inherited = yield* get(
              account.id,
              AttachmentIds,
              `/me/messages/${encodeURIComponent(draft.id)}/attachments?$select=id,isInline,contentId`,
            );
            for (const attachment of inherited.value)
              yield* write(
                account.id,
                "DELETE",
                `/me/messages/${encodeURIComponent(draft.id)}/attachments/${encodeURIComponent(attachment.id)}`,
              );
          }
          for (const attachment of attachments) {
            yield* write(
              account.id,
              "POST",
              `/me/messages/${encodeURIComponent(draft.id)}/attachments`,
              attachment,
            );
          }
          sendAttempted = true;
          yield* deliver(account.id, messageId, write(account.id, "POST", `${path}/send`));
        }).pipe(
          Effect.onError(() =>
            (sendAttempted
              ? get(
                  account.id,
                  Schema.Struct({ isDraft: Schema.Boolean }),
                  `${path}?$select=isDraft`,
                ).pipe(
                  Effect.flatMap((current) =>
                    current.isDraft ? write(account.id, "DELETE", path) : Effect.void,
                  ),
                )
              : write(account.id, "DELETE", path)
            ).pipe(Effect.catch(() => Effect.void)),
          ),
        );
      }
    },
    (effect, account) =>
      Effect.mapError(effect, (error) =>
        error._tag === "SendUncertain" ? error : writeFailure(account.id)(error),
      ),
  );

  /**
   * Outlook drafts are messages in the Drafts folder, edited in place, so the
   * id stays the same across saves. Replies are created with createReply so
   * Outlook threads them; new messages use plain drafts. Forwards inherit the original attachments
   * on the server, so large originals never enter the upload path.
   */
  const saveDraft = Effect.fn("Outlook.saveDraft")(
    function* (account: Account, draft: DraftPush) {
      const { message, original } = draft;
      yield* checkAttachmentSize(message);
      const fields = {
        ...graphFields(message),
        ...(message.draftOrganization
          ? {
              categories: message.draftOrganization.labels,
              flag: { flagStatus: message.draftOrganization.starred ? "flagged" : "notFlagged" },
            }
          : {}),
        singleValueExtendedProperties: [
          {
            id: MARKDOWN_DRAFT_PROPERTY,
            value: message.markdown ? JSON.stringify(markdownDraftSource(message.text)) : "",
          },
        ],
      };
      const attachments = message.attachments.map(fileAttachment);
      const addAttachments = (id: string) =>
        Effect.forEach(
          attachments,
          (a) => write(account.id, "POST", `/me/messages/${encodeURIComponent(id)}/attachments`, a),
          { discard: true },
        );

      const create = Effect.gen(function* () {
        const mode = message.mode ?? "new";
        if (Option.isSome(original) && mode !== "new") {
          const action =
            mode === "forward"
              ? "createForward"
              : mode === "reply"
                ? "createReply"
                : "createReplyAll";
          const created = yield* write(
            account.id,
            "POST",
            `/me/messages/${encodeURIComponent(original.value.providerId)}/${action}`,
          ).pipe(Effect.flatMap(decode(WithId)));
          yield* write(
            account.id,
            "PATCH",
            `/me/messages/${encodeURIComponent(created.id)}`,
            fields,
          );
          if (mode === "forward" && message.includeOriginalAttachments !== undefined) {
            const inherited = yield* get(
              account.id,
              AttachmentIds,
              `/me/messages/${encodeURIComponent(created.id)}/attachments?$select=id,isInline,contentId`,
            );
            for (const attachment of inherited.value)
              yield* write(
                account.id,
                "DELETE",
                `/me/messages/${encodeURIComponent(created.id)}/attachments/${encodeURIComponent(attachment.id)}`,
              );
          }
          yield* addAttachments(created.id);
          return created.id;
        }
        const created = yield* write(account.id, "POST", "/me/messages", {
          ...fields,
          attachments,
        }).pipe(Effect.flatMap(decode(WithId)));
        return created.id;
      });

      const update = (id: string) =>
        Effect.gen(function* () {
          // Recreate the server-side forward when uploaded parts change. Its inherited
          // parts are opaque to the upload list and must never be deleted with it.
          if (
            message.mode === "forward" &&
            message.includeOriginalAttachments === undefined &&
            draft.replaceAttachments &&
            Option.isSome(original)
          ) {
            // This replaces the message. Read live metadata instead of replaying
            // stale local intent when another client changed its categories/flag.
            if (message.draftOrganization === undefined) {
              const live = yield* get(
                account.id,
                Schema.Struct({
                  categories: Schema.optionalKey(Schema.Array(Schema.String)),
                  flag: Schema.optionalKey(
                    Schema.Struct({ flagStatus: Schema.optionalKey(Schema.String) }),
                  ),
                }),
                `/me/messages/${encodeURIComponent(id)}?$select=categories,flag`,
              ).pipe(
                Effect.catchIf(is404, () =>
                  Effect.succeed({ categories: undefined, flag: undefined }),
                ),
              );
              if (live.categories) fields.categories = live.categories;
              if (live.flag?.flagStatus) fields.flag = { flagStatus: live.flag.flagStatus };
            }
            const next = yield* create;
            yield* write(account.id, "DELETE", `/me/messages/${encodeURIComponent(id)}`).pipe(
              Effect.catchIf(is404, () => Effect.void),
            );
            return next;
          }
          yield* write(account.id, "PATCH", `/me/messages/${encodeURIComponent(id)}`, fields);
          if (!draft.replaceAttachments) return id;
          const current = yield* get(
            account.id,
            AttachmentIds,
            `/me/messages/${encodeURIComponent(id)}/attachments?$select=id,isInline,contentId`,
          );
          const managedInline = new Set(
            message.attachments.flatMap((attachment) =>
              attachment.contentId ? [attachment.contentId] : [],
            ),
          );
          for (const a of current.value.filter(
            (x) =>
              (message.mode === "forward" && message.includeOriginalAttachments !== undefined) ||
              !x.isInline ||
              (x.contentId !== null && x.contentId !== undefined && managedInline.has(x.contentId)),
          )) {
            yield* write(
              account.id,
              "DELETE",
              `/me/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(a.id)}`,
            );
          }
          yield* addAttachments(id);
          return id;
        });

      const known = draft.remote?.messageId ?? draft.remote?.draftId;
      // Deleted in another client meanwhile: the person is still writing it.
      const id = known
        ? yield* update(known).pipe(Effect.catchIf(is404, () => create))
        : yield* create;
      return { draftId: id, messageId: id } satisfies DraftRemote;
    },
    (effect, account) => Effect.mapError(effect, writeFailure(account.id)),
  );

  const deleteDraft = Effect.fn("Outlook.deleteDraft")(
    function* (account: Account, remote: DraftRemote) {
      const id = remote.messageId ?? remote.draftId;
      if (!id) return;
      yield* write(account.id, "DELETE", `/me/messages/${encodeURIComponent(id)}`).pipe(
        Effect.catchIf(is404, () => Effect.void),
      );
    },
    (effect, account) => Effect.mapError(effect, writeFailure(account.id)),
  );

  const draftMarkdownSource = Effect.fn("Outlook.draftMarkdownSource")(
    function* (account: Account, providerId: string) {
      const metadata = yield* get(
        account.id,
        Schema.Struct({
          singleValueExtendedProperties: Schema.optionalKey(
            Schema.Array(Schema.Struct({ id: Schema.String, value: Schema.String })),
          ),
        }),
        `/me/messages/${encodeURIComponent(providerId)}?$select=id&$expand=${encodeURIComponent(`singleValueExtendedProperties($filter=id eq '${MARKDOWN_DRAFT_PROPERTY}')`)}`,
      );
      const value = metadata.singleValueExtendedProperties?.find(
        (property) => property.id === MARKDOWN_DRAFT_PROPERTY,
      )?.value;
      return value
        ? Option.getOrUndefined(
            Schema.decodeUnknownOption(Schema.fromJsonString(MarkdownDraftSource))(value),
          )
        : undefined;
    },
    (effect, account) => Effect.mapError(effect, writeFailure(account.id)),
  );

  const fetchRaw = Effect.fn("Outlook.fetchRaw")(
    function* (account: Account, providerId: string, maxBytes?: number) {
      if (maxBytes !== undefined) {
        // Graph has no message byte-size property. Estimate from body and all
        // attachment sizes (including inline), then bound the MIME stream too.
        const metadata = yield* get(
          account.id,
          Schema.Struct({ body: Schema.Struct({ content: Schema.String }) }),
          `/me/messages/${encodeURIComponent(providerId)}?$select=body`,
        );
        const parts = yield* get(
          account.id,
          Schema.Struct({
            value: Schema.Array(Schema.Struct({ size: Schema.Number })),
            "@odata.nextLink": Schema.optionalKey(Schema.String),
          }),
          `/me/messages/${encodeURIComponent(providerId)}/attachments?$select=size`,
        );
        const estimate =
          128 * 1024 +
          Buffer.byteLength(metadata.body.content) * 3 +
          parts.value.reduce((total, part) => total + part.size * 2, 0);
        if (parts["@odata.nextLink"] || estimate > maxBytes)
          return yield* new PermanentError({ message: MEDIA_RAW_TOO_LARGE });
      }
      return yield* getBytes(
        account.id,
        `/me/messages/${encodeURIComponent(providerId)}/$value`,
        maxBytes,
      );
    },
    (effect, account) => Effect.mapError(effect, writeFailure(account.id)),
  );

  const fetchAttachment = Effect.fn("Outlook.fetchAttachment")(
    function* (account: Account, providerId: string, ref: AttachmentRef) {
      // The same list, order and filter as the attachments stored on the message.
      const { value } = yield* get(
        account.id,
        AttachmentNames,
        `/me/messages/${encodeURIComponent(providerId)}/attachments?$select=id,name,isInline`,
      );
      const found = pickAttachment(
        value.filter((a) => !a.isInline),
        (a) => a.name,
        ref,
      );
      if (!found) {
        const bytes = yield* fetchRaw(account, providerId);
        const parsed = yield* Effect.tryPromise({
          try: () => codec.parse(bytes),
          catch: () => new ProviderError({ message: "Cannot parse attachment MIME" }),
        });
        const attachment = pickAttachment(
          parsed.attachments.filter((part) => !part.related),
          (part) => part.filename ?? "attachment",
          ref,
        );
        if (attachment) return new Uint8Array(attachment.content);
        return yield* new PermanentError({ message: `No attachment ${ref.filename}` });
      }
      // $value is the file for file attachments and MIME for attached messages.
      return yield* getBytes(
        account.id,
        `/me/messages/${encodeURIComponent(providerId)}/attachments/${encodeURIComponent(found.id)}/$value`,
      );
    },
    (effect, account) => Effect.mapError(effect, writeFailure(account.id)),
  );

  const settings = makeOutlookSettings(get, write);
  const changeLabel: ProviderAdapter["changeLabel"] = (account, change) =>
    Effect.gen(function* () {
      const before = yield* listCustomFolders(account.id);
      if (change.kind === "create") {
        const result = yield* write(
          account.id,
          "POST",
          change.parentId
            ? `/me/mailFolders/${encodeURIComponent(change.parentId)}/childFolders`
            : "/me/mailFolders",
          { displayName: change.name },
        );
        const folder = yield* decode(
          Schema.Struct({ id: Schema.String, displayName: Schema.optionalKey(Schema.String) }),
        )(result);
        const parent = before.find((f) => f.id === change.parentId);
        rememberFolder(account.id, folder.id, {
          name: `${parent ? `${parent.name}/` : ""}${folder.displayName ?? change.name}`,
        });
      } else if (change.kind === "rename") {
        const old = before.find((f) => f.id === change.id);
        const result = yield* write(
          account.id,
          "PATCH",
          `/me/mailFolders/${encodeURIComponent(change.id)}`,
          { displayName: change.name },
        );
        const folder = yield* decode(
          Schema.Struct({ id: Schema.String, displayName: Schema.optionalKey(Schema.String) }),
        )(result);
        const prefix = old?.name.slice(0, old.name.lastIndexOf("/") + 1) ?? "";
        rememberFolder(account.id, folder.id, {
          name: `${prefix}${folder.displayName ?? change.name}`,
          ...(old ? { previousName: old.name } : {}),
        });
      } else if (change.kind === "parent") {
        const old = before.find((f) => f.id === change.id);
        const result = yield* write(
          account.id,
          "POST",
          `/me/mailFolders/${encodeURIComponent(change.id)}/move`,
          { destinationId: change.parentId ?? "msgfolderroot" },
        );
        const folder = yield* decode(WithId)(result);
        const parent = before.find((f) => f.id === change.parentId);
        if (old)
          rememberFolder(account.id, folder.id, {
            name: `${parent ? `${parent.name}/` : ""}${old.name.split("/").at(-1)}`,
            previousName: old.name,
          });
        if (folder.id !== change.id) rememberFolder(account.id, change.id, { name: null });
      } else if (change.kind === "delete") {
        yield* write(account.id, "DELETE", `/me/mailFolders/${encodeURIComponent(change.id)}`);
        rememberFolder(account.id, change.id, { name: null });
      }
      return mergeFolderChanges(account.id, before, false).map((f) => ({ ...f, color: null }));
    }).pipe(Effect.mapError(writeFailure(account.id)));
  const search: ProviderAdapter["search"] = (account, query) =>
    Effect.gen(function* () {
      const folders = yield* listCustomFolders(account.id);
      const system = yield* Effect.forEach(WELL_KNOWN, (f) =>
        get(account.id, WithId, `/me/mailFolders/${f.name}?$select=id`).pipe(
          Effect.map((r) => ({ id: r.id, label: f.label })),
          Effect.catchIf(is404, () => Effect.succeed({ id: f.name, label: f.label })),
        ),
      );
      const folderNames = folders.map((f) => ({ ...f, color: null }));
      const scope = searchMailboxLabel(query) ?? parseSearchQuery(query).criteria?.labels?.[0];
      const known = WELL_KNOWN.find((f) => f.label === scope)?.name;
      const folder =
        known ?? (scope && folders.find((f) => f.id === scope || f.name === scope)?.id);
      const base = folder
        ? `/me/mailFolders/${encodeURIComponent(folder)}/messages`
        : "/me/messages";
      const limit = Math.max(1, Math.min(query.limit ?? 200, 1000));
      const kql = graphSearch(query);
      const params = new URLSearchParams({
        $select: `${MESSAGE_SELECT},parentFolderId`,
        $expand: "attachments($select=name,contentType,size,isInline)",
        $top: "100",
      });
      const messageId = parseSearchQuery(query).criteria?.rfcMessageId;
      if (messageId)
        params.set(
          "$filter",
          `internetMessageId eq '${`<${messageId.replace(/^<|>$/g, "")}>`.replaceAll("'", "''")}'`,
        );
      else if (kql) params.set("$search", JSON.stringify(kql));
      const messages: IncomingMessage[] = [];
      let url: string | undefined = `${base}?${params.toString()}`;
      let scanned = 0;
      while (url && scanned < 1000 && messages.length < limit) {
        const page: {
          readonly value: readonly GraphMessage[];
          readonly "@odata.nextLink"?: string;
        } = yield* get(
          account.id,
          Schema.Struct({
            value: Schema.Array(GraphMessage),
            "@odata.nextLink": Schema.optionalKey(Schema.String),
          }),
          url,
        );
        let consumed = 0;
        for (const raw of page.value) {
          scanned++;
          consumed++;
          const label =
            system.find((f) => f.id === raw.parentFolderId)?.label ??
            folders.find((f) => f.id === raw.parentFolderId)?.id;
          if (!label) continue;
          const attachments =
            expandedAttachments(raw) ??
            (raw.hasAttachments ? yield* fetchAttachments(account.id, raw.id) : []);
          const message = yield* incomingGraph(account, raw, label, attachments);
          if (matchesSearch(message, query, folderNames)) messages.push(message);
          if (messages.length >= limit) break;
        }
        url = page["@odata.nextLink"];
        if (messages.length >= limit && consumed < page.value.length)
          return { messages, truncated: true };
      }
      return { messages, truncated: url !== undefined || scanned >= 1000 };
    }).pipe(Effect.mapError(writeFailure(account.id)));

  const pageSchema = Schema.Struct({
    value: Schema.Array(WithId),
    "@odata.nextLink": Schema.optionalKey(Schema.String),
  });
  const messageLabel = Effect.fnUntraced(function* (account: Account, raw: GraphMessage) {
    const system = yield* Effect.forEach(WELL_KNOWN, (f) =>
      get(account.id, WithId, `/me/mailFolders/${f.name}?$select=id`).pipe(
        Effect.map((r) => ({ id: r.id, label: f.label })),
        Effect.catchIf(is404, () => Effect.succeed({ id: f.name, label: f.label })),
      ),
    );
    return (
      system.find((f) => f.id === raw.parentFolderId)?.label ?? raw.parentFolderId ?? "ARCHIVE"
    );
  });
  const backfill: ProviderAdapter["backfill"] = (account, state, select) =>
    Effect.gen(function* () {
      const params = new URLSearchParams({
        $select: "id,receivedDateTime",
        $top: "50",
        $orderby: "receivedDateTime desc",
        $filter: `receivedDateTime lt ${new Date(state.before).toISOString()}`,
      });
      const url = state.cursor ?? `/me/messages?${params.toString()}`;
      if (state.cursor && !state.cursor.startsWith(`${GRAPH}/`))
        return yield* new ProviderError({ message: "Invalid Graph backfill continuation" });
      const page = yield* get(account.id, pageSchema, url);
      const listed = page.value.map((m) => m.id);
      const ids = select ? yield* select(listed) : listed;
      const messages = yield* Effect.forEach(
        ids,
        (id) =>
          fetchMessage(account, id).pipe(
            Effect.catchTag("PermanentError", () => Effect.succeed(null)),
          ),
        {
          concurrency: 2,
        },
      );
      return {
        messages: messages.filter((m) => m !== null),
        cursor: page["@odata.nextLink"] ?? null,
        scanned: page.value.length,
      };
    }).pipe(Effect.mapError(readFailure(account.id)));
  const fetchMessage: ProviderAdapter["fetchMessage"] = (account, id) =>
    Effect.gen(function* () {
      const raw = yield* get(
        account.id,
        GraphMessage,
        `/me/messages/${encodeURIComponent(id)}?$select=${MESSAGE_SELECT},parentFolderId&${EXPAND_ATTACHMENTS}`,
      );
      const label = yield* messageLabel(account, raw);
      const attachments =
        expandedAttachments(raw) ??
        (raw.hasAttachments ? yield* fetchAttachments(account.id, id) : []);
      return yield* incomingGraph(account, raw, label, attachments);
    }).pipe(Effect.mapError(writeFailure(account.id)));

  return {
    backfill,
    fetchMessage,
    ...settings,
    ...makeOutlookFeatures(get, write),
    ...makeProviderCalendar(
      "outlook",
      (id, schema, path) =>
        api(
          id,
          HttpClientRequest.get(`${GRAPH}${path}`).pipe(
            HttpClientRequest.setHeader(
              "prefer",
              `IdType="ImmutableId", outlook.timezone="${Intl.DateTimeFormat().resolvedOptions().timeZone}"`,
            ),
          ),
        ).pipe(Effect.flatMap(decode(schema))),
      (id, path, body) => write(id, "POST", path, body),
    ),
    search,
    changeLabel,
    connect,
    pull,
    listFolderMessages: (account, folder, cursor, options) =>
      Effect.gen(function* () {
        if (
          options?.includeChildren &&
          cursor === null &&
          !folder.label &&
          (folder.mailbox === "trash" || folder.mailbox === "spam")
        ) {
          const pending = [folder.mailbox === "trash" ? "deleteditems" : "junkemail"];
          const visited = new Set<string>();
          const Page = Schema.Struct({
            value: Schema.Array(WithId),
            "@odata.nextLink": Schema.optionalKey(Schema.String),
          });
          while (pending.length) {
            const id = pending.shift();
            if (id === undefined) break;
            if (visited.has(id) || visited.size >= 1000)
              return yield* new PermanentError({
                message: "Deleted folder hierarchy repeated or exceeds 1,000 folders.",
              });
            visited.add(id);
            const base = `/me/mailFolders/${encodeURIComponent(id)}`;
            const messages = yield* get(
              account.id,
              Page,
              `${base}/messages?$select=id&$top=${FOLDER_BATCH_LIMIT}`,
            );
            if (messages.value.length) return { ids: messages.value.map((m) => m.id), next: null };
            let path: string | null =
              `${base}/childFolders?includeHiddenFolders=true&$select=id&$top=100`;
            const links = new Set<string>();
            while (path !== null) {
              if (links.has(path))
                return yield* new PermanentError({
                  message: "Deleted folder pagination repeated a page.",
                });
              links.add(path);
              const children: typeof Page.Type = yield* get(account.id, Page, path);
              pending.push(...children.value.map((child) => child.id));
              const next = children["@odata.nextLink"];
              if (next) {
                const url = yield* Effect.try({
                  try: () => new URL(next),
                  catch: () =>
                    new PermanentError({ message: "Invalid deleted folder pagination link." }),
                });
                if (
                  url.origin !== "https://graph.microsoft.com" ||
                  url.pathname !== `/v1.0${base}/childFolders`
                )
                  return yield* new PermanentError({
                    message: "Invalid deleted folder pagination link.",
                  });
                path = `${url.pathname.slice("/v1.0".length)}${url.search}`;
              } else path = null;
            }
          }
          return { ids: [], next: null };
        }
        const labels: Record<string, string> = {
          inbox: "INBOX",
          sent: "SENT",
          drafts: "DRAFT",
          spam: "SPAM",
          trash: "TRASH",
        };
        const known = WELL_KNOWN.find((f) => f.label === labels[folder.mailbox]);
        const target = folder.label ?? known?.name;
        const base = target
          ? `/me/mailFolders/${encodeURIComponent(target)}/messages`
          : "/me/messages";
        const params = new URLSearchParams({
          $select: "id",
          $top: String(FOLDER_BATCH_LIMIT),
          ...(options?.newestFirst ? { $orderby: "receivedDateTime desc" } : {}),
        });
        const filters: string[] = options?.newestFirst
          ? ["receivedDateTime ge 1900-01-01T00:00:00Z"]
          : [];
        if (options?.unreadOnly) filters.push("isRead eq false");
        if (!target) {
          for (const name of ["junkemail", "deleteditems"]) {
            const ref = yield* get(
              account.id,
              WithId,
              `/me/mailFolders/${encodeURIComponent(name)}?$select=id`,
            );
            filters.push(`parentFolderId ne '${ref.id.replaceAll("'", "''")}'`);
          }
          if (folder.mailbox === "starred") filters.push("flag/flagStatus eq 'flagged'");
          if (folder.mailbox === "important") filters.push("importance eq 'high'");
        }
        if (filters.length) params.set("$filter", filters.join(" and "));
        let path = `${base}?${params.toString()}`;
        if (cursor !== null) {
          const url = yield* Effect.try({
            try: () => new URL(cursor, `${GRAPH}/`),
            catch: () => new PermanentError({ message: "Invalid folder pagination link." }),
          });
          if (url.origin !== "https://graph.microsoft.com" || url.pathname !== `/v1.0${base}`)
            return yield* new PermanentError({ message: "Invalid folder pagination link." });
          path = `${url.pathname.slice("/v1.0".length)}${url.search}`;
        }
        const page = yield* get(
          account.id,
          Schema.Struct({
            value: Schema.Array(WithId),
            "@odata.nextLink": Schema.optionalKey(Schema.String),
          }),
          path,
        );
        return { ids: page.value.map((m) => m.id), next: page["@odata.nextLink"] ?? null };
      }).pipe(Effect.mapError(writeFailure(account.id))),
    checkPermanentDelete: (account, folder) =>
      deleteFolderIds(account, folder).pipe(
        Effect.map((ids) => [folder === "trash" ? "TRASH" : "SPAM", ...ids]),
        Effect.mapError(writeFailure(account.id)),
      ),
    permanentlyDelete: (account, ids, folder) =>
      Effect.gen(function* () {
        if (ids.length > FOLDER_BATCH_LIMIT)
          return yield* new PermanentError({
            message: "Permanent delete batch exceeds 100 messages.",
          });
        const subtree = yield* deleteFolderIds(account, folder).pipe(
          Effect.mapError(writeFailure(account.id)),
        );
        const deleted: string[] = [];
        const Metadata = Schema.Struct({ parentFolderId: Schema.String });
        for (const id of ids) {
          const result = yield* Effect.gen(function* () {
            const metadata = yield* get(
              account.id,
              Metadata,
              `/me/messages/${encodeURIComponent(id)}?$select=parentFolderId`,
            ).pipe(
              Effect.map(Option.some),
              Effect.catchIf(is404, () => Effect.succeed(Option.none())),
            );
            if (Option.isNone(metadata) || !subtree.has(metadata.value.parentFolderId))
              return false;
            return yield* write(
              account.id,
              "POST",
              `/me/messages/${encodeURIComponent(id)}/permanentDelete`,
            ).pipe(
              Effect.as(true),
              Effect.catchIf(is404, () => Effect.succeed(false)),
            );
          }).pipe(Effect.mapError(writeFailure(account.id)), Effect.result);
          if (result._tag === "Failure")
            return {
              kind: "partial",
              ids: deleted,
              error: result.failure,
            } satisfies PermanentDeleteBatch;
          if (result.success) deleted.push(id);
        }
        return { kind: "complete", ids: deleted } satisfies PermanentDeleteBatch;
      }),
    push,
    markReadBatch: (account, ids) =>
      Effect.forEach(
        ids,
        (id) =>
          write(account.id, "PATCH", `/me/messages/${encodeURIComponent(id)}`, {
            isRead: true,
          }).pipe(
            Effect.catchIf(is404, () => Effect.void),
            Effect.asVoid,
            Effect.mapError(writeFailure(account.id)),
          ),
        { discard: true, concurrency: 5 },
      ),
    send,
    saveDraft,
    getDraftOrganization: (account, id) =>
      get(
        account.id,
        Schema.Struct({
          categories: Schema.optionalKey(Schema.Array(Schema.String)),
          flag: Schema.optionalKey(
            Schema.Struct({ flagStatus: Schema.optionalKey(Schema.String) }),
          ),
        }),
        `/me/messages/${encodeURIComponent(id)}?$select=categories,flag`,
      ).pipe(
        Effect.map((message) => ({
          labels: message.categories ?? [],
          starred: message.flag?.flagStatus === "flagged",
        })),
        Effect.mapError(writeFailure(account.id)),
      ),
    deleteDraft,
    fetchRaw,
    draftMarkdownSource,
    fetchAttachment,
  } satisfies ProviderAdapter;
});

function fileAttachment(a: OutgoingMessage["attachments"][number]) {
  return {
    "@odata.type": "#microsoft.graph.fileAttachment",
    name: a.filename,
    contentType: a.mimeType,
    contentBytes: a.content,
    ...(a.contentId ? { contentId: a.contentId, isInline: true } : {}),
  };
}

/** Where each moving op sends an Outlook message. Well-known names work as destination ids. */
export function destination(op: MailOp): string | null {
  switch (op.kind) {
    case "archive":
      return "archive";
    case "inbox":
      return "inbox";
    case "trash":
      return "deleteditems";
    case "spam":
      return "junkemail";
    case "move":
      return (
        { INBOX: "inbox", ARCHIVE: "archive", TRASH: "deleteditems", SPAM: "junkemail" }[
          op.labelId
        ] ?? op.labelId
      );
    case "label":
      return op.value ? op.labelId : "inbox";
    default:
      return null;
  }
}

const recipients = (list: readonly Address[]) =>
  list.map((a) => ({ emailAddress: { address: a.address, ...(a.name ? { name: a.name } : {}) } }));

/** Custom internet headers are create-only; this property also supports draft updates. */
export const MARKDOWN_DRAFT_PROPERTY =
  "String {57d14d35-4d11-4f8f-ae63-961883378d87} Name OpenmailMarkdownSource";

function graphFields(message: OutgoingMessage) {
  return {
    subject: message.subject,
    body: message.html
      ? { contentType: "html", content: htmlDocument(composeTransportHtml(message) ?? "") }
      : { contentType: "text", content: message.text },
    toRecipients: recipients(message.to),
    ccRecipients: recipients(message.cc),
    bccRecipients: recipients(message.bcc),
  };
}

const checkRequestSize = (body: string) =>
  body.length > REQUEST_LIMIT
    ? Effect.fail(
        new PermanentError({
          message: "Outlook messages over 3 MB with a forwarded message are not supported yet",
        }),
      )
    : Effect.void;

const forwardsMessage = (message: OutgoingMessage) =>
  message.attachments.some((a) => a.mimeType.toLowerCase() === "message/rfc822");

const checkAttachmentSize = (message: OutgoingMessage) => {
  const problem = attachmentProblem("outlook", message.attachments);
  return problem
    ? Effect.fail(new PermanentError({ message: attachmentProblemMessage(problem) }))
    : Effect.void;
};

function address(a: GraphAddress | null | undefined): Address {
  return {
    name: cleanDisplayName(a?.emailAddress?.name ?? ""),
    address: a?.emailAddress?.address ?? "",
  };
}

export function parseGraphMessage(
  raw: GraphMessage,
  folderLabel: string,
  attachments: readonly Attachment[],
): IncomingMessage {
  const content = raw.body?.content ?? "";
  const isHtml = raw.body?.contentType.toLowerCase() === "html";
  const html = isHtml ? content : "";
  const text = isHtml ? htmlToText(content) : content;
  const isUnread = raw.isRead === false;
  const isStarred = raw.flag?.flagStatus === "flagged";

  const labels = [folderLabel, ...(raw.categories ?? []).map((name) => `category:${name}`)];
  if (raw.importance === "high") labels.push("IMPORTANT");
  if (isUnread) labels.push("UNREAD");
  if (isStarred) labels.push("STARRED");

  return withUuAttachments({
    providerId: raw.id,
    threadId: raw.conversationId,
    ...(raw.webLink ? { webLink: raw.webLink } : {}),
    subject: raw.subject ?? "",
    from: address(raw.from),
    to: (raw.toRecipients ?? []).map(address),
    cc: (raw.ccRecipients ?? []).map(address),
    bcc: (raw.bccRecipients ?? []).map(address),
    ...(raw.internetMessageHeaders ? { headers: raw.internetMessageHeaders } : {}),
    ...(raw.internetMessageId ? { rfcMessageId: raw.internetMessageId } : {}),
    replyTo: (raw.replyTo ?? []).map(address).filter((a) => a.address.trim()),
    date: Date.parse(raw.receivedDateTime || raw.sentDateTime || ""),
    snippet: raw.bodyPreview ?? "",
    bodyText: text,
    bodyHtml: html,
    // Graph header order is not used to establish authentication trust.
    security: messageSecurity([], "outlook"),
    ...(/eventMessage/i.test(raw["@odata.type"] ?? "") ? { hasCalendar: true } : {}),
    labels,
    attachments,
    isUnread,
    isStarred,
  });
}

import { Clock, Data, Effect, Option, Schedule, Schema, Semaphore, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { type AttachmentRef, pickAttachment, MEDIA_RAW_TOO_LARGE } from "./attachments.js";
import type {
  Account,
  Address,
  Attachment,
  DraftRemote,
  IncomingMessage,
  Label,
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
import { buildMime } from "./compose.js";
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
const SCOPES = [
  "offline_access",
  "User.Read",
  "Mail.ReadWrite",
  "Mail.Send",
  "MailboxSettings.ReadWrite",
  "Calendars.ReadWrite",
  "Contacts.Read",
  "People.Read",
];
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
  "id,conversationId,subject,bodyPreview,body,from,toRecipients,ccRecipients," +
  "receivedDateTime,sentDateTime,isRead,isDraft,hasAttachments,flag,importance";
const PAGE_SIZE = 50;
const CONCURRENCY = 6;

/** sendMail and attachment POSTs carry files inline; Graph caps a request at 4 MB. */
const INLINE_ATTACHMENT_LIMIT = 3 * 1024 * 1024;
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

const GraphMessage = Schema.Struct({
  "@odata.type": Schema.optionalKey(Schema.String),
  id: Schema.String,
  conversationId: Schema.String,
  subject: Schema.optionalKey(Schema.NullOr(Schema.String)),
  bodyPreview: Schema.optionalKey(Schema.String),
  body: Schema.optionalKey(Schema.Struct({ contentType: Schema.String, content: Schema.String })),
  from: Schema.optionalKey(Schema.NullOr(GraphAddress)),
  toRecipients: Schema.optionalKey(Schema.Array(GraphAddress)),
  ccRecipients: Schema.optionalKey(Schema.Array(GraphAddress)),
  receivedDateTime: Schema.optionalKey(Schema.NullOr(Schema.String)),
  sentDateTime: Schema.optionalKey(Schema.NullOr(Schema.String)),
  isRead: Schema.optionalKey(Schema.Boolean),
  isDraft: Schema.optionalKey(Schema.Boolean),
  hasAttachments: Schema.optionalKey(Schema.Boolean),
  parentFolderId: Schema.optionalKey(Schema.String),
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
    Schema.Struct({ id: Schema.String, isInline: Schema.optionalKey(Schema.Boolean) }),
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
class ApiError extends Data.TaggedError("ApiError")<{ status: number; body: string }> {}

// 429 throttling and 5xx are transient; back off and retry.
const isTransient = (e: ApiError) => e.status === 0 || e.status === 429 || e.status >= 500;
const RETRY = { schedule: Schedule.exponential("500 millis"), times: 4, while: isTransient };

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
    if (e.status === 401 || e.status === 403) return new AuthError({ accountId, message });
    return new ProviderError({ message, ...(e.status ? { status: e.status } : {}) });
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

export const makeOutlook: Effect.Effect<
  ProviderAdapter,
  never,
  HttpClient.HttpClient | OAuth | AppConfig | Secrets
> = Effect.gen(function* () {
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
          return yield* new AuthError({
            accountId,
            message: "No Microsoft OAuth client configured",
          });
        }
        const res = yield* oauth.refresh(accountId, {
          tokenUrl: TOKEN_URL,
          clientId: microsoft.clientId,
          refreshToken: refreshToken.value,
        });
        if (Option.isSome(res.refreshToken)) yield* secrets.set(accountId, res.refreshToken.value);
        tokens.set(accountId, { token: res.accessToken, expiresAt: now + res.expiresIn * 1000 });
        return res.accessToken;
      }),
    );

  /** Sends one request with retries; resolves to the parsed JSON body, or null for 202/204. */
  const execute = (token: string, request: HttpClientRequest.HttpClientRequest) =>
    Effect.gen(function* () {
      const res = yield* http.execute(
        request.pipe(HttpClientRequest.bearerToken(token), HttpClientRequest.setHeaders(PREFER)),
      );
      const text = yield* res.text;
      if (res.status < 200 || res.status >= 300) {
        return yield* new ApiError({ status: res.status, body: text });
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
      Effect.retry(RETRY),
    );

  const api = (accountId: string, request: HttpClientRequest.HttpClientRequest) =>
    accessToken(accountId).pipe(
      Effect.flatMap((token) => execute(token, request)),
      // The provider can reject an access token before it expires. Drop it,
      // refresh, and retry once; only a failed refresh means signing in again.
      Effect.catchIf(
        (e) => e._tag === "ApiError" && e.status === 401,
        () =>
          Effect.sync(() => tokens.delete(accountId)).pipe(
            Effect.andThen(accessToken(accountId)),
            Effect.flatMap((token) => execute(token, request)),
          ),
      ),
      Effect.tapError((e) =>
        e._tag === "ApiError" && (e.status === 401 || e.status === 403)
          ? Effect.sync(() => tokens.delete(accountId))
          : Effect.void,
      ),
    );

  /** `path` is a path under GRAPH, or a full https URL (delta and next links are absolute). */
  const get = <A>(accountId: string, schema: Schema.Decoder<A>, path: string) =>
    api(
      accountId,
      HttpClientRequest.get(path.startsWith("https://") ? path : `${GRAPH}${path}`),
    ).pipe(Effect.flatMap(decode(schema)));

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

  /** A GET whose body is not JSON (a message's MIME source). */
  const getBytes = (accountId: string, path: string, maxBytes?: number) =>
    accessToken(accountId).pipe(
      Effect.flatMap((token) =>
        Effect.gen(function* () {
          const res = yield* http.execute(
            HttpClientRequest.get(`${GRAPH}${path}`).pipe(
              HttpClientRequest.bearerToken(token),
              HttpClientRequest.setHeaders(PREFER),
            ),
          );
          if (res.status < 200 || res.status >= 300) {
            return yield* new ApiError({ status: res.status, body: yield* res.text });
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
          Effect.retry({
            ...RETRY,
            while: (error) => error._tag === "ApiError" && RETRY.while(error),
          }),
        ),
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
      scopes: SCOPES,
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
    ).pipe(Effect.flatMap(decode(Me)), Effect.mapError(readFailure("")));
    // A new sign-in may carry new scopes; cached tokens from the old grant
    // would keep failing until they expire.
    tokens.clear();
    return { email: me.mail ?? me.userPrincipalName, secret: res.refreshToken.value };
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
        get(accountId, WithId, `/me/mailFolders/${name}?$select=id`).pipe(
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
            if (f.childFolderCount > 0) yield* walk(`/me/mailFolders/${f.id}/childFolders`, name);
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
  const readDelta = Effect.fnUntraced(function* (accountId: string, start: string) {
    const changed: GraphMessage[] = [];
    const removed: string[] = [];
    let url: string | undefined = start;
    let deltaLink = start;
    while (url) {
      const page: typeof DeltaPage.Type = yield* get(accountId, DeltaPage, url);
      for (const item of page.value) {
        if ("@removed" in item) removed.push(item.id);
        else if ("conversationId" in item) changed.push(item);
        else {
          const whole = yield* get(
            accountId,
            GraphMessage,
            `/me/messages/${item.id}?$select=${SELECT}`,
          ).pipe(
            Effect.map(Option.some),
            // Deleted between the delta page and this read; a later round reports the removal.
            Effect.catchIf(is404, () => Effect.succeed(Option.none())),
          );
          if (Option.isSome(whole)) changed.push(whole.value);
        }
      }
      deltaLink = page["@odata.deltaLink"] ?? deltaLink;
      url = page["@odata.nextLink"];
    }
    return { changed, removed, deltaLink };
  });

  const fetchAttachments = (accountId: string, id: string) =>
    get(
      accountId,
      AttachmentList,
      `/me/messages/${id}/attachments?$select=name,contentType,size,isInline`,
    ).pipe(
      // Inline parts are embedded images (signatures, tracking), not real files.
      Effect.map(({ value }): Attachment[] =>
        value
          .filter((a) => !a.isInline)
          .map((a) => ({ filename: a.name, mimeType: a.contentType, size: a.size })),
      ),
    );

  const pull = (
    account: Account,
    cursor: Option.Option<string>,
  ): Stream.Stream<Change, ProviderFailure> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const stored: Readonly<Record<string, string>> = Option.getOrElse(
          Option.flatMap(cursor, decodeCursor),
          () => ({}),
        );
        // Ids stored before immutable ids were requested don't match the new
        // ones, so the local copy is dropped and everything is fetched again.
        const reset = stored[ID_TYPE_KEY] !== "immutable";
        const previous = reset ? {} : stored;

        const custom = yield* listCustomFolders(account.id);
        const labels: Omit<Label, "accountId">[] = custom.map((f) => ({
          id: f.id,
          name: f.name,
          color: null,
        }));
        const folders: SyncFolder[] = [
          ...WELL_KNOWN.map((f) => ({ key: f.name, path: f.name, label: f.label })),
          ...custom.map((f) => ({ key: f.id, path: f.id, label: f.id })),
        ];

        const changed: { message: GraphMessage; label: string }[] = [];
        const removed: string[] = [];
        const next: Record<string, string> = { [ID_TYPE_KEY]: "immutable" };
        // Folders whose delta link expired: synced again from scratch, so
        // their local copies are dropped first.
        const restarted: string[] = [];
        for (const folder of folders) {
          const known = previous[folder.key];
          const initial = `${GRAPH}/me/mailFolders/${folder.path}/messages/delta?$select=${SELECT}&$top=${PAGE_SIZE}`;
          const delta = yield* readDelta(account.id, known ?? initial).pipe(
            Effect.map(Option.some),
            // Not every mailbox has an Archive folder.
            Effect.catchIf(
              (e) => known === undefined && is404(e),
              () => Effect.succeed(Option.none()),
            ),
            Effect.catchIf(
              (e) => known !== undefined && is410(e),
              () =>
                Effect.sync(() => restarted.push(folder.label)).pipe(
                  Effect.andThen(readDelta(account.id, initial)),
                  Effect.map(Option.some),
                ),
            ),
          );
          if (Option.isNone(delta)) continue;
          for (const message of delta.value.changed) changed.push({ message, label: folder.label });
          removed.push(...delta.value.removed);
          next[folder.key] = delta.value.deltaLink;
        }

        // A message moved between two custom folders can be reported removed
        // from one and changed in the other; the change wins.
        const kept = new Set(changed.map((c) => c.message.id));
        const deletes = removed
          .filter((id) => !kept.has(id))
          .map((providerId): Change => ({ _tag: "Delete", providerId }));
        // Custom folders deleted (or emptied) since the last sync.
        const wellKnown = new Set(WELL_KNOWN.map((f) => f.name));
        const vanished = Object.keys(previous)
          .filter((key) => key !== ID_TYPE_KEY && !wellKnown.has(key) && !(key in next))
          .map((label): Change => ({ _tag: "DeleteLabel", label }));

        const total = changed.length;
        const fetched = Stream.fromIterable(changed).pipe(
          Stream.mapEffect(
            ({ message, label }, i) =>
              (message.hasAttachments
                ? fetchAttachments(account.id, message.id)
                : Effect.succeed<Attachment[]>([])
              ).pipe(
                Effect.map((attachments): Change[] => [
                  { _tag: "Upsert", message: parseGraphMessage(message, label, attachments) },
                  { _tag: "Progress", fetched: i + 1, total },
                ]),
              ),
            { concurrency: CONCURRENCY },
          ),
          Stream.flattenIterable,
        );

        const head: Change[] = [
          ...(reset ? [{ _tag: "Reset" } as const] : []),
          { _tag: "Labels", labels },
          ...restarted.map((label): Change => ({ _tag: "DeleteLabel", label })),
        ];
        // Delta links only cover the whole batch, so the cursor goes last.
        const tail: Change[] = [
          ...deletes,
          ...vanished,
          { _tag: "Cursor", cursor: JSON.stringify(next) },
        ];
        return Stream.fromIterable(head).pipe(
          Stream.concat(fetched),
          Stream.concat(Stream.fromIterable(tail)),
        );
      }).pipe(Effect.withSpan("Outlook.pull")),
    ).pipe(Stream.mapError(readFailure(account.id)));

  const push = Effect.fn("Outlook.push")(
    function* (account: Account, providerId: string, op: MailOp) {
      const path = `/me/messages/${providerId}`;
      if (op.kind === "read") {
        yield* write(account.id, "PATCH", path, { isRead: op.value });
        return;
      }
      if (op.kind === "star") {
        yield* write(account.id, "PATCH", path, {
          flag: { flagStatus: op.value ? "flagged" : "notFlagged" },
        });
        return;
      }
      const destinationId = destination(op);
      if (destinationId) yield* write(account.id, "POST", `${path}/move`, { destinationId });
    },
    (effect, account) => Effect.mapError(effect, writeFailure(account.id)),
  );

  const send = Effect.fn("Outlook.send")(
    function* (
      account: Account,
      message: OutgoingMessage,
      original: Option.Option<{ providerId: string; threadId: string }>,
    ) {
      yield* checkAttachmentSize(message);
      const fields = graphFields(message);
      const attachments = message.attachments.map(fileAttachment);
      const mode = message.mode ?? "new";
      if ((Option.isNone(original) || mode === "new") && forwardsMessage(message)) {
        // A forwarded .eml goes out as raw MIME, which Graph's sendMail also
        // takes: as a JSON fileAttachment Exchange re-encodes the .eml as an
        // opaque base64 file, and Gmail previews it as text in a guessed
        // charset. In MIME it is a real message/rfc822 part.
        const mime = yield* buildMime({ name: "", address: account.email }, message);
        const body = mime.toString("base64");
        yield* checkRequestSize(body);
        yield* api(
          account.id,
          HttpClientRequest.post(`${GRAPH}/me/sendMail`).pipe(
            HttpClientRequest.bodyText(body, "text/plain"),
          ),
        );
      } else if (Option.isNone(original) || mode === "new") {
        yield* write(account.id, "POST", "/me/sendMail", {
          message: { ...fields, attachments },
          saveToSentItems: true,
        });
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
          `/me/messages/${original.value.providerId}/${action}`,
        ).pipe(Effect.flatMap(decode(WithId)));
        yield* write(account.id, "PATCH", `/me/messages/${draft.id}`, fields);
        for (const attachment of attachments) {
          yield* write(account.id, "POST", `/me/messages/${draft.id}/attachments`, attachment);
        }
        yield* write(account.id, "POST", `/me/messages/${draft.id}/send`);
      }
    },
    (effect, account) => Effect.mapError(effect, writeFailure(account.id)),
  );

  /**
   * Outlook drafts are messages in the Drafts folder, edited in place, so the
   * id stays the same across saves. Replies are created with createReply so
   * Outlook threads them; new messages and forwards are plain drafts (the
   * send path forwards the original's attachments itself).
   */
  const saveDraft = Effect.fn("Outlook.saveDraft")(
    function* (account: Account, draft: DraftPush) {
      const { message, original } = draft;
      yield* checkAttachmentSize(message);
      const fields = graphFields(message);
      const attachments = message.attachments.map(fileAttachment);
      const addAttachments = (id: string) =>
        Effect.forEach(
          attachments,
          (a) => write(account.id, "POST", `/me/messages/${id}/attachments`, a),
          { discard: true },
        );

      const create = Effect.gen(function* () {
        const mode = message.mode ?? "new";
        if (Option.isSome(original) && (mode === "reply" || mode === "replyAll")) {
          const action = mode === "reply" ? "createReply" : "createReplyAll";
          const created = yield* write(
            account.id,
            "POST",
            `/me/messages/${original.value.providerId}/${action}`,
          ).pipe(Effect.flatMap(decode(WithId)));
          yield* write(account.id, "PATCH", `/me/messages/${created.id}`, fields);
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
          yield* write(account.id, "PATCH", `/me/messages/${id}`, fields);
          if (!draft.replaceAttachments) return id;
          const current = yield* get(
            account.id,
            AttachmentIds,
            `/me/messages/${id}/attachments?$select=id,isInline`,
          );
          for (const a of current.value.filter((x) => !x.isInline)) {
            yield* write(account.id, "DELETE", `/me/messages/${id}/attachments/${a.id}`);
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
      yield* write(account.id, "DELETE", `/me/messages/${id}`).pipe(
        Effect.catchIf(is404, () => Effect.void),
      );
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
          `/me/messages/${providerId}?$select=body`,
        );
        const parts = yield* get(
          account.id,
          Schema.Struct({
            value: Schema.Array(Schema.Struct({ size: Schema.Number })),
            "@odata.nextLink": Schema.optionalKey(Schema.String),
          }),
          `/me/messages/${providerId}/attachments?$select=size`,
        );
        const estimate =
          128 * 1024 +
          Buffer.byteLength(metadata.body.content) * 3 +
          parts.value.reduce((total, part) => total + part.size * 2, 0);
        if (parts["@odata.nextLink"] || estimate > maxBytes)
          return yield* new PermanentError({ message: MEDIA_RAW_TOO_LARGE });
      }
      return yield* getBytes(account.id, `/me/messages/${providerId}/$value`, maxBytes);
    },
    (effect, account) => Effect.mapError(effect, writeFailure(account.id)),
  );

  const fetchAttachment = Effect.fn("Outlook.fetchAttachment")(
    function* (account: Account, providerId: string, ref: AttachmentRef) {
      // The same list, order and filter as the attachments stored on the message.
      const { value } = yield* get(
        account.id,
        AttachmentNames,
        `/me/messages/${providerId}/attachments?$select=id,name,isInline`,
      );
      const found = pickAttachment(
        value.filter((a) => !a.isInline),
        (a) => a.name,
        ref,
      );
      if (!found) {
        return yield* new PermanentError({ message: `No attachment ${ref.filename}` });
      }
      // $value is the file for file attachments and MIME for attached messages.
      return yield* getBytes(
        account.id,
        `/me/messages/${providerId}/attachments/${found.id}/$value`,
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
        $select: `${SELECT},parentFolderId`,
        $top: "100",
      });
      if (kql) params.set("$search", `"${kql.replaceAll('"', '\\"')}"`);
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
          const attachments = raw.hasAttachments ? yield* fetchAttachments(account.id, raw.id) : [];
          const message = parseGraphMessage(raw, label, attachments);
          if (matchesSearch(message, query, folderNames)) messages.push(message);
          if (messages.length >= limit) break;
        }
        url = page["@odata.nextLink"];
        if (messages.length >= limit && consumed < page.value.length)
          return { messages, truncated: true };
      }
      return { messages, truncated: url !== undefined || scanned >= 1000 };
    }).pipe(Effect.mapError(writeFailure(account.id)));

  return {
    ...settings,
    ...makeOutlookFeatures(get, write),
    search,
    changeLabel,
    connect,
    pull,
    push,
    send,
    saveDraft,
    deleteDraft,
    fetchRaw,
    fetchAttachment,
  } satisfies ProviderAdapter;
});

function fileAttachment(a: OutgoingMessage["attachments"][number]) {
  return {
    "@odata.type": "#microsoft.graph.fileAttachment",
    name: a.filename,
    contentType: a.mimeType,
    contentBytes: a.content,
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
    case "label":
      return op.value ? op.labelId : "inbox";
    default:
      return null;
  }
}

const recipients = (list: readonly Address[]) =>
  list.map((a) => ({ emailAddress: { address: a.address, ...(a.name ? { name: a.name } : {}) } }));

function graphFields(message: OutgoingMessage) {
  return {
    subject: message.subject,
    body: message.html
      ? { contentType: "html", content: htmlDocument(message.html) }
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

const checkAttachmentSize = (message: OutgoingMessage) =>
  message.attachments.reduce((n, a) => n + (a.content.length * 3) / 4, 0) > INLINE_ATTACHMENT_LIMIT
    ? Effect.fail(
        new PermanentError({
          message: "Outlook attachments over 3 MB in total are not supported yet",
        }),
      )
    : Effect.void;

function address(a: GraphAddress | null | undefined): Address {
  return { name: a?.emailAddress?.name ?? "", address: a?.emailAddress?.address ?? "" };
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

  const labels = [folderLabel];
  if (raw.importance === "high") labels.push("IMPORTANT");
  if (isUnread) labels.push("UNREAD");
  if (isStarred) labels.push("STARRED");

  return {
    providerId: raw.id,
    threadId: raw.conversationId,
    subject: raw.subject ?? "",
    from: address(raw.from),
    to: (raw.toRecipients ?? []).map(address),
    cc: (raw.ccRecipients ?? []).map(address),
    date: Date.parse(raw.receivedDateTime || raw.sentDateTime || ""),
    snippet: raw.bodyPreview ?? "",
    bodyText: text,
    bodyHtml: html,
    ...(/eventMessage/i.test(raw["@odata.type"] ?? "") ? { hasCalendar: true } : {}),
    labels,
    attachments,
    isUnread,
    isStarred,
  };
}

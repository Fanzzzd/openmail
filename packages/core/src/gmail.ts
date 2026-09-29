import { Clock, Data, Effect, Option, Schedule, Schema, Semaphore, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { buildMime, type Threading } from "./compose.js";
import type {
  Account,
  Attachment,
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
import { charsetOf, decodeBytes, decodeHeader, htmlToText, parseAddressList } from "./mime.js";
import {
  AppConfig,
  type Change,
  type ConnectInput,
  type Connected,
  OAuth,
  type ProviderAdapter,
  Secrets,
} from "./services.js";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
// modify covers reading, labels, archive and trash, but not permanent delete.
// Accounts added under the old read-only scope get a 403 on their first write
// and are asked to sign in again.
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
];

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
  readonly body: { readonly data?: string; readonly size: number };
  readonly parts?: readonly GmailPart[];
}

const GmailPart: Schema.Codec<GmailPart> = Schema.Struct({
  mimeType: Schema.String,
  filename: Schema.optionalKey(Schema.String),
  headers: Schema.optionalKey(Schema.Array(Header)),
  body: Schema.Struct({ data: Schema.optionalKey(Schema.String), size: Schema.Number }),
  parts: Schema.optionalKey(Schema.Array(Schema.suspend((): Schema.Codec<GmailPart> => GmailPart))),
});

const GmailMessage = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  labelIds: Schema.optionalKey(Schema.Array(Schema.String)),
  snippet: Schema.optionalKey(Schema.String),
  internalDate: Schema.String,
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

/** A non-2xx response, or a transport failure as status 0, before it becomes a ProviderFailure. */
class ApiError extends Data.TaggedError("ApiError")<{ status: number; body: string }> {}

// 429 and 5xx are quota and transient errors. Gmail also reports per-user
// quota as 403 rateLimitExceeded, which clears the same way.
const isTransient = (e: ApiError) =>
  e.status === 0 ||
  e.status === 429 ||
  e.status >= 500 ||
  (e.status === 403 && /rateLimitExceeded/i.test(e.body));

const RETRY = { schedule: Schedule.exponential("500 millis"), times: 4, while: isTransient };

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
    if (e.status === 401 || (e.status === 403 && /insufficient|scope/i.test(e.body))) {
      return new AuthError({ accountId, message });
    }
    return new ProviderError({ message, ...(e.status ? { status: e.status } : {}) });
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
  HttpClient.HttpClient | OAuth | AppConfig | Secrets
> = Effect.gen(function* () {
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
          return yield* new AuthError({ accountId, message: "No Google OAuth client configured" });
        }
        const res = yield* oauth.refresh(accountId, {
          tokenUrl: TOKEN_URL,
          clientId: google.clientId,
          clientSecret: google.clientSecret,
          refreshToken: refreshToken.value,
        });
        tokens.set(accountId, { token: res.accessToken, expiresAt: now + res.expiresIn * 1000 });
        return res.accessToken;
      }),
    );

  /** Sends one request with retries; resolves to the parsed JSON body, or null when empty. */
  const execute = (token: string, request: HttpClientRequest.HttpClientRequest) =>
    Effect.gen(function* () {
      const res = yield* http.execute(HttpClientRequest.bearerToken(request, token));
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
      // A rejected token may still sit in the cache; the next call refreshes.
      Effect.tapError((e) =>
        e._tag === "ApiError" && (e.status === 401 || e.status === 403)
          ? Effect.sync(() => tokens.delete(accountId))
          : Effect.void,
      ),
    );

  const get = <A>(
    accountId: string,
    schema: Schema.Decoder<A>,
    path: string,
    urlParams?: Record<string, string>,
  ) =>
    api(accountId, HttpClientRequest.get(`${API}${path}`, urlParams ? { urlParams } : {})).pipe(
      Effect.flatMap(decode(schema)),
    );

  const post = (accountId: string, path: string, body?: unknown) =>
    api(
      accountId,
      body === undefined
        ? HttpClientRequest.post(`${API}${path}`)
        : HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post(`${API}${path}`), body),
    );

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
      scopes: SCOPES,
      // offline + consent: Google only returns a refresh token on explicit consent.
      extraParams: {
        access_type: "offline",
        prompt: "consent",
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
      Effect.flatMap(decode(Profile)),
      Effect.mapError(readFailure("")),
    );
    // A new sign-in may carry new scopes; cached tokens from the old grant
    // would keep failing until they expire.
    tokens.clear();
    return { email: profile.emailAddress, secret: res.refreshToken.value };
  });

  /** User-created labels. System labels (INBOX, CATEGORY_*) map to fixed mailboxes instead. */
  const fetchUserLabels = (accountId: string) =>
    get(accountId, LabelList, "/labels").pipe(
      Effect.map(({ labels = [] }): Omit<Label, "accountId">[] =>
        labels
          .filter((l) => l.type === "user")
          .map((l) => ({ id: l.id, name: l.name, color: l.color?.backgroundColor ?? null })),
      ),
    );

  /** None when the cursor is too old (Gmail keeps about a week), forcing a full sync. */
  const readHistory = Effect.fnUntraced(
    function* (accountId: string, cursor: string) {
      const changed = new Set<string>();
      const deleted = new Set<string>();
      let pageToken: string | undefined;
      let latest = cursor;
      do {
        const page = yield* get(accountId, HistoryPage, "/history", {
          startHistoryId: cursor,
          maxResults: "500",
          ...(pageToken ? { pageToken } : {}),
        });
        for (const h of page.history ?? []) {
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
      return Option.some({ changedIds: [...changed], deletedIds: [...deleted], cursor: latest });
    },
    Effect.catchIf(
      (e) => e._tag === "ApiError" && e.status === 404,
      () => Effect.succeed(Option.none()),
    ),
  );

  const fullSyncPlan = Effect.fnUntraced(function* (accountId: string) {
    // Take the cursor before listing so nothing that arrives mid-sync is lost;
    // the next incremental run re-fetches any overlap idempotently.
    const { historyId } = yield* get(accountId, Profile, "/profile");
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const page = yield* get(accountId, MessageList, "/messages", {
        q: INITIAL_QUERY,
        includeSpamTrash: "true",
        maxResults: "500",
        ...(pageToken ? { pageToken } : {}),
      });
      ids.push(...(page.messages ?? []).map((m) => m.id));
      pageToken = page.nextPageToken;
    } while (pageToken && ids.length < INITIAL_LIMIT);
    return {
      changedIds: ids.slice(0, INITIAL_LIMIT),
      deletedIds: [] as string[],
      cursor: historyId,
    };
  });

  /** None when the message was deleted between listing and fetching. */
  const fetchMessage = (accountId: string, id: string) =>
    get(accountId, GmailMessage, `/messages/${id}`, { format: "full" }).pipe(
      Effect.map((raw) => Option.some(parseGmailMessage(raw))),
      Effect.catchIf(
        (e) => e._tag === "ApiError" && e.status === 404,
        () => Effect.succeed(Option.none<IncomingMessage>()),
      ),
    );

  const pull = (
    account: Account,
    cursor: Option.Option<string>,
  ): Stream.Stream<Change, ProviderFailure> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const labels = yield* fetchUserLabels(account.id);
        const incremental = Option.isSome(cursor)
          ? yield* readHistory(account.id, cursor.value)
          : Option.none();
        const plan = Option.isSome(incremental)
          ? incremental.value
          : yield* fullSyncPlan(account.id);
        const total = plan.changedIds.length;

        const fetched = Stream.fromIterable(plan.changedIds).pipe(
          Stream.mapEffect(
            (id, i) =>
              fetchMessage(account.id, id).pipe(
                Effect.map((m): Change[] => [
                  Option.isSome(m)
                    ? { _tag: "Upsert", message: m.value }
                    : { _tag: "Delete", providerId: id },
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
        return Stream.succeed(head).pipe(
          Stream.concat(fetched),
          Stream.concat(Stream.fromIterable(deletes)),
          Stream.concat(Stream.succeed(tail)),
        );
      }).pipe(Effect.withSpan("Gmail.pull")),
    ).pipe(Stream.mapError(readFailure(account.id)));

  const push = Effect.fn("Gmail.push")(
    function* (account: Account, providerId: string, op: MailOp) {
      const path = `/messages/${providerId}`;
      if (op.kind === "trash") {
        yield* post(account.id, `${path}/trash`);
        return;
      }
      if (op.kind === "inbox") {
        // Untrash restores the labels the message had before trashing; the
        // modify below then makes sure it lands in the inbox.
        yield* post(account.id, `${path}/untrash`);
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
      `/messages/${providerId}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`,
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
      const raw = yield* buildMime({ name: "", address: account.email }, message, threading);
      yield* post(account.id, "/messages/send", {
        raw: raw.toString("base64url"),
        ...(threadId ? { threadId } : {}),
      });
    },
    (effect, account) => Effect.mapError(effect, writeFailure(account.id)),
  );

  return { connect, pull, push, send } satisfies ProviderAdapter;
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
    default:
      return op.value ? { add: [op.labelId], remove: [] } : { add: [], remove: [op.labelId] };
  }
}

export function parseGmailMessage(raw: GmailMessage): IncomingMessage {
  const headers = new Map(
    (raw.payload.headers ?? []).map((h) => [h.name.toLowerCase(), h.value] as const),
  );
  let text = "";
  let html = "";
  const attachments: Attachment[] = [];
  const walk = (part: GmailPart) => {
    if (part.filename) {
      attachments.push({ filename: part.filename, mimeType: part.mimeType, size: part.body.size });
    } else if (part.body.data) {
      const partHeaders = new Map(
        (part.headers ?? []).map((h) => [h.name.toLowerCase(), h.value] as const),
      );
      const decoded = decodeBytes(
        Buffer.from(part.body.data, "base64url"),
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
  return {
    providerId: raw.id,
    threadId: raw.threadId,
    subject: decodeHeader(headers.get("subject") ?? ""),
    from,
    to: parseAddressList(headers.get("to")),
    cc: parseAddressList(headers.get("cc")),
    date: Number(raw.internalDate),
    snippet: decodeEntities(raw.snippet ?? ""),
    bodyText: text || htmlToText(html),
    bodyHtml: html,
    labels,
    attachments,
    isUnread: labels.includes("UNREAD"),
    isStarred: labels.includes("STARRED"),
  };
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

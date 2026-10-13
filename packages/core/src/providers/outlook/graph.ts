import { Context, Effect, Option, Schema } from "effect";
import { InferenceClassification, type MailOp } from "../../domain/domain.js";
import { PermanentError, ProviderError, type ProviderFailure } from "../../domain/errors.js";
import { graphPageLink } from "./graph-pagination.js";
import { BASE_SCOPES } from "../optional-services.js";
import { ApiError } from "../provider-http.js";
import { providerDecode, providerReadFailure } from "../provider-send.js";

// `consumers` scopes sign-in to personal Microsoft accounts (outlook.com,
// hotmail, live). Work/school accounts need a tenant admin to consent to the
// app first, which openmail deliberately does not work around.
const TENANT = "consumers";

export const AUTH_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`;

export const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;

export const GRAPH = "https://graph.microsoft.com/v1.0";

type PageHistory = Set<string> | { readonly previous: string } | undefined;

export function nextPage<E>(
  link: string,
  base: string,
  seen: PageHistory,
  onError: () => E,
): Effect.Effect<string, E>;

export function nextPage<E>(
  link: string | undefined,
  base: string,
  seen: PageHistory,
  onError: () => E,
): Effect.Effect<string | undefined, E>;

export function nextPage<E>(
  link: string | undefined,
  base: string,
  seen: PageHistory,
  onError: () => E,
): Effect.Effect<string | undefined, E> {
  if (link === undefined) return Effect.succeed(undefined);
  return Effect.try({
    try: () =>
      graphPageLink(
        link,
        base,
        seen instanceof Set || seen === undefined
          ? seen
          : new Set([
              new URL(
                seen.previous.startsWith("https://") ? seen.previous : `${GRAPH}${seen.previous}`,
              ).href,
            ]),
      ),
    catch: onError,
  });
}

// offline_access is what makes Graph return a refresh token. Accounts added
// under the old Mail.Read scope get a 403 on their first write and are asked
// to sign in again.
export const SCOPES = BASE_SCOPES.outlook;

// Immutable ids survive moves between folders, so a message archived here
// keeps its local row and any queued op still finds it.
export const PREFER = { prefer: 'IdType="ImmutableId"' };

/** Cursor key recording that stored ids are immutable. Older cursors trigger a clean resync. */
export const ID_TYPE_KEY = "__idType";

export const WINDOW_KEY = "__windowDays";

// Folders synced, and the mailbox label each maps to. A Graph message lives in
// exactly one folder, so its id is unique and needs no cross-folder dedup.
/** Well-known folders synced under a fixed label. Other system folders (outbox and so on) are skipped. */
export const WELL_KNOWN: readonly { name: string; label: string }[] = [
  { name: "inbox", label: "INBOX" },
  { name: "sentitems", label: "SENT" },
  { name: "drafts", label: "DRAFT" },
  { name: "junkemail", label: "SPAM" },
  { name: "deleteditems", label: "TRASH" },
  { name: "archive", label: "ARCHIVE" },
];

export const SKIPPED = [
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

export const SELECT =
  "id,conversationId,subject,bodyPreview,body,from,toRecipients,ccRecipients,replyTo," +
  "receivedDateTime,sentDateTime,isRead,isDraft,hasAttachments,flag,importance,webLink,categories,inferenceClassification,internetMessageId,bccRecipients";

// Header selection is supported on ordinary message GETs, not requested from delta.
export const MESSAGE_SELECT = `${SELECT},internetMessageHeaders`;

const PAGE_SIZE = 50;

export const DELTA_PREFER = `${PREFER.prefer}, odata.maxpagesize=${PAGE_SIZE}`;

export const INITIAL_WINDOW_DAYS = 90;

export const CONCURRENCY = 4;

export const SearchRequest = Context.Reference<boolean>("openmail/GraphSearchRequest", {
  defaultValue: () => false,
});

// Draft preparation and delivery confirmation belong to the send lane, too.
export const SendRequest = Context.Reference<boolean>("openmail/OutlookSendRequest", {
  defaultValue: () => false,
});

export const EXPAND_ATTACHMENTS = "$expand=attachments($select=name,contentType,size,isInline)";

/** sendMail and attachment POSTs carry files inline; Graph caps a request at 4 MB. */
export const REQUEST_LIMIT = 4 * 1024 * 1024;

// Provider JSON. Only the fields openmail reads; extra fields are ignored.
// Drafts come with null subject, sender and sent time, so those are lenient.

export const GraphAddress = Schema.Struct({
  emailAddress: Schema.optionalKey(
    Schema.Struct({
      name: Schema.optionalKey(Schema.String),
      address: Schema.optionalKey(Schema.String),
    }),
  ),
});

export type GraphAddress = typeof GraphAddress.Type;

const GraphAttachment = Schema.Struct({
  name: Schema.String,
  contentType: Schema.String,
  size: Schema.Number,
  isInline: Schema.optionalKey(Schema.Boolean),
});

export const GraphMessage = Schema.Struct({
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
  inferenceClassification: Schema.optionalKey(Schema.NullOr(InferenceClassification)),
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

export const DeltaPage = Schema.Struct({
  value: Schema.Array(Schema.Union([Removed, GraphMessage, Partial])),
  "@odata.nextLink": Schema.optionalKey(Schema.String),
  "@odata.deltaLink": Schema.optionalKey(Schema.String),
});

export const FolderPage = Schema.Struct({
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

export const AttachmentList = Schema.Struct({
  value: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      contentType: Schema.String,
      size: Schema.Number,
      isInline: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});

export const AttachmentNames = Schema.Struct({
  value: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      isInline: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});

export const AttachmentIds = Schema.Struct({
  value: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      isInline: Schema.optionalKey(Schema.Boolean),
      contentId: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
});

export const Me = Schema.Struct({
  mail: Schema.optionalKey(Schema.NullOr(Schema.String)),
  userPrincipalName: Schema.String,
});

export const WithId = Schema.Struct({ id: Schema.String });

export const DraftVersion = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  changeKey: Schema.optionalKey(Schema.String),
  lastModifiedDateTime: Schema.optionalKey(Schema.String),
});

export const UploadedAttachments = Schema.Struct({
  value: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      contentType: Schema.optionalKey(Schema.String),
      contentBytes: Schema.optionalKey(Schema.String),
      contentId: Schema.optionalKey(Schema.NullOr(Schema.String)),
      /** Graph storage size can include envelope overhead; it is not attachment byte identity. */
      size: Schema.optionalKey(Schema.Number),
      isInline: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  "@odata.nextLink": Schema.optionalKey(Schema.String),
});

/**
 * Per-folder delta links, stored as the account's opaque sync cursor. Keyed by
 * well-known name for system folders and by folder id for custom ones.
 */
const Cursor = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));

export const decodeCursor = Schema.decodeUnknownOption(Cursor);

/** One folder to sync: its delta key, the Graph path segment, and the label its messages get. */
export interface GraphSyncFolder {
  key: string;
  path: string;
  label: string;
}

// 429 throttling and 5xx are transient; back off and retry.
export const isTransient = (e: ApiError) =>
  !e.deferred && (e.status === 0 || e.status === 429 || e.status >= 500);

export const is404 = (e: { _tag: string }) => e instanceof ApiError && e.status === 404;

/** Graph expires delta links it no longer tracks (syncStateNotFound). */
export const is410 = (e: { _tag: string }) => e instanceof ApiError && e.status === 410;

export const readFailure = providerReadFailure("Graph");

const GraphFailureBody = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.Struct({
      message: Schema.optionalKey(Schema.String),
      code: Schema.optionalKey(Schema.String),
    }),
  }),
);

const writeReason = (error: ApiError) => {
  const decoded = Schema.decodeUnknownOption(GraphFailureBody)(error.body);
  const message = Option.isSome(decoded) ? decoded.value.error.message : undefined;
  if (message?.trim()) return message.replace(/\s+/g, " ").trim().slice(0, 300);
  switch (error.status) {
    case 0:
      return "Outlook could not be reached. The change will be retried.";
    case 403:
      return "Access to this message was denied.";
    case 404:
      return "This message or folder no longer exists.";
    case 409:
      return "This change conflicts with the server state.";
    case 413:
      return "This message is too large.";
    case 415:
      return "The server does not support this message format.";
    case 422:
      return "The server could not accept this message content.";
    default:
      return error.status === 429 || error.status >= 500
        ? "Outlook is busy. The change will be retried."
        : "The server rejected this change.";
  }
};

/** Writes Graph will never accept (bad folder id, message gone) are dropped. */
export const writeFailure =
  (accountId: string) =>
  (e: ApiError | ProviderFailure): ProviderFailure =>
    e._tag === "ApiError" &&
    ([400, 404, 409, 413, 415, 422].includes(e.status) ||
      (e.status === 403 && /ErrorAccessDenied/.test(e.body)))
      ? new PermanentError({ message: writeReason(e) })
      : e._tag === "PermanentError"
        ? e
        : e._tag === "ApiError" && e.status !== 401
          ? new ProviderError({
              message: writeReason(e),
              status: e.status,
              ...(e.retryAfter === undefined ? {} : { retryAfter: e.retryAfter }),
              ...(e.requestNotSent ? { reason: "connection" } : {}),
              ...(e.deferred ? { deferred: true } : {}),
            })
          : readFailure(accountId)(e);

export const decode = providerDecode("Graph");

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

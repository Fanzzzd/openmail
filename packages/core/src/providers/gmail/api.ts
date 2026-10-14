/** Gmail REST endpoints, the response fields openmail reads, and how Gmail errors map to provider failures. */
import { Schema } from "effect";
import { BASE_SCOPES } from "../optional-services.js";
import { ApiError } from "../provider-http.js";
import { isRateLimited, providerDecode, providerReadFailure } from "../provider-send.js";

import { Label } from "../../domain/account.js";
import { PermanentError, type ProviderFailure } from "../../domain/errors.js";

export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
/** Revoking a refresh token removes the whole grant, so OpenMail leaves the Google account's app list. */
export const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const API = "https://gmail.googleapis.com/gmail/v1/users/me";
// Permanent deletion is an optional incremental grant, never requested at account add time.
// Accounts added under the old read-only scope get a 403 on their first write
// and are asked to sign in again.
export const SCOPES = BASE_SCOPES.gmail;

/** First sync pulls this window, spam and trash included; older mail arrives later through backfill. */
export const INITIAL_QUERY = "newer_than:90d";
export const INITIAL_LIMIT = 2000;
export const CONCURRENCY = 8;
export const COUNT_RECHECK_PAGES = 2;
export const COUNT_RECHECK_PAGE_SIZE = 500;
export const COUNT_RECHECK_CAPACITY = COUNT_RECHECK_PAGES * COUNT_RECHECK_PAGE_SIZE;

// Provider JSON. Only the fields openmail reads; extra fields are ignored.

export const Header = Schema.Struct({ name: Schema.String, value: Schema.String });
export type Header = typeof Header.Type;

export interface GmailPart {
  readonly mimeType: string;
  readonly filename?: string;
  readonly headers?: readonly Header[];
  readonly body: { readonly data?: string; readonly attachmentId?: string; readonly size: number };
  readonly parts?: readonly GmailPart[];
}

export const GmailPart: Schema.Codec<GmailPart> = Schema.Struct({
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

export const GmailMessage = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  labelIds: Schema.optionalKey(Schema.Array(Schema.String)),
  snippet: Schema.optionalKey(Schema.String),
  internalDate: Schema.String,
  sizeEstimate: Schema.optionalKey(Schema.Number),
  payload: GmailPart,
});
export type GmailMessage = typeof GmailMessage.Type;

export const MessageRef = Schema.Struct({ message: Schema.Struct({ id: Schema.String }) });
export const MessageRefs = Schema.optionalKey(Schema.Array(MessageRef));

export const HistoryPage = Schema.Struct({
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

export const MessageList = Schema.Struct({
  messages: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.String }))),
  nextPageToken: Schema.optionalKey(Schema.String),
});

export const LabelList = Schema.Struct({
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

export const Profile = Schema.Struct({ emailAddress: Schema.String, historyId: Schema.String });

export const Metadata = Schema.Struct({
  payload: Schema.Struct({ headers: Schema.optionalKey(Schema.Array(Header)) }),
});

export const GmailDraft = Schema.Struct({
  id: Schema.String,
  message: Schema.Struct({ id: Schema.String }),
});

export const DraftList = Schema.Struct({
  drafts: Schema.optionalKey(Schema.Array(GmailDraft)),
  nextPageToken: Schema.optionalKey(Schema.String),
});

export const RawMessage = Schema.Struct({ raw: Schema.String });
export const AttachmentBody = Schema.Struct({ data: Schema.String });

// 429 and 5xx are quota and transient errors. Gmail also reports per-user
// quota as 403 rateLimitExceeded, which clears the same way.
export const isTransient = (e: ApiError) =>
  e.status === 0 || e.status >= 500 || isRateLimited(e.status, e.body);

/**
 * A first sync saves `initial:<historyId>` before fetching. A retry lists again from that
 * history id, skips the messages it already stored, and history from that id covers changes
 * to them in between.
 */
export const INITIAL_CURSOR = "initial:";

export const is404 = (e: { _tag: string }) => e instanceof ApiError && e.status === 404;

export const readFailure = providerReadFailure("Gmail");

/** Writes Gmail will never accept (bad label id, message gone) are dropped. */
export const writeFailure =
  (accountId: string) =>
  (e: ApiError | ProviderFailure): ProviderFailure =>
    e._tag === "ApiError" && (e.status === 400 || e.status === 404)
      ? new PermanentError({ message: `Gmail API ${e.status}: ${e.body}` })
      : e._tag === "PermanentError"
        ? e
        : readFailure(accountId)(e);

export const decode = providerDecode("Gmail");

/** Domain schemas for sync progress, results and failed ops. */

import { Schema } from "effect";

export const SyncProgress = Schema.Struct({
  accountId: Schema.String,
  fetched: Schema.Number,
  total: Schema.Number,
});
export type SyncProgress = typeof SyncProgress.Type;

export const SyncResult = Schema.Struct({
  accountId: Schema.String,
  changed: Schema.Number,
  deleted: Schema.Number,
  error: Schema.optionalKey(Schema.String),
  /** The provider rejected the credentials; the account needs a new sign-in. */
  needsReauth: Schema.optionalKey(Schema.Boolean),
});
export type SyncResult = typeof SyncResult.Type;

/** Durable delivery and outbound-operation notices, until the user dismisses them. */
export const FailedOp = Schema.Struct({
  id: Schema.Number,
  accountId: Schema.String,
  providerId: Schema.String,
  at: Schema.Number,
  kind: Schema.String,
  reason: Schema.String,
  subject: Schema.NullOr(Schema.String),
  sender: Schema.NullOr(Schema.String),
});
export type FailedOp = typeof FailedOp.Type;

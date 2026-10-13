/**
 * Records the sync code exchanges with the Store and ProviderAdapter ports:
 * header backfill progress, folder counts for the sync health report, and
 * sync reset candidates. A leaf module, so the ports can name them without
 * importing the sync logic that uses the ports.
 */
import { Schema } from "effect";

export const HeaderPosition = Schema.Struct({ date: Schema.Number, id: Schema.String });
export const HeaderBackfillCandidate = Schema.Struct({
  ...HeaderPosition.fields,
  providerId: Schema.String,
});
export const HeaderBackfillState = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("running"),
    after: Schema.NullOr(HeaderPosition),
    retryAt: Schema.optionalKey(Schema.Number),
  }),
  Schema.Struct({ kind: Schema.Literal("done"), completedAt: Schema.Number }),
]);
export type HeaderBackfillState = typeof HeaderBackfillState.Type;
export type CachedHeaders =
  | {
      readonly kind: "headers";
      readonly id: string;
      readonly rfcMessageId: string | null;
      readonly headers: readonly { readonly name: string; readonly value: string }[];
    }
  | { readonly kind: "unavailable"; readonly id: string };

export const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const HealthCounts = Schema.Struct({
  total: Count,
  unread: Count,
  threads: Schema.NullOr(Count),
});
export type HealthCounts = typeof HealthCounts.Type;
export const FolderStatus = Schema.Struct({
  ...HealthCounts.fields,
  uidNext: Schema.NullOr(Count),
  uidValidity: Schema.NullOr(Schema.String.check(Schema.isPattern(/^\d+$/))),
});
export type FolderStatus = typeof FolderStatus.Type;

export const ResetCandidate = Schema.Struct({
  providerId: Schema.String,
  /** Original UID is unsafe after a namespace reset; only Message-ID can verify it. */
  resetProviderId: Schema.optionalKey(Schema.String),
  rfcMessageId: Schema.NullOr(Schema.String),
  labels: Schema.Array(Schema.String),
});
export type ResetCandidate = typeof ResetCandidate.Type;
export type ResetVerification =
  | { readonly kind: "gone"; readonly id: string }
  | {
      readonly kind: "present";
      readonly id: string;
      readonly providerId: string;
      readonly labels: readonly string[];
    };

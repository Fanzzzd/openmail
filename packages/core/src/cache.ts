import { Schema } from "effect";

/** null keeps every body; headers and attachment metadata always remain. */
export const CacheWindow = Schema.Struct({
  accountId: Schema.String,
  label: Schema.String,
  days: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
});
export type CacheWindow = typeof CacheWindow.Type;
/** Omit days to restore the account/label default. */
export const CacheWindowInput = Schema.Struct({
  accountId: CacheWindow.fields.accountId,
  label: CacheWindow.fields.label,
  days: Schema.optionalKey(CacheWindow.fields.days),
});
export type CacheWindowInput = typeof CacheWindowInput.Type;

export const CacheSize = Schema.Struct({
  accountId: Schema.String,
  bodyBytes: Schema.Number,
  attachmentBytes: Schema.Number,
});
export type CacheSize = typeof CacheSize.Type;
export const OlderResult = Schema.Struct({ done: Schema.Boolean });
export type OlderResult = typeof OlderResult.Type;

export const BackfillState = Schema.Struct({
  accountId: Schema.String,
  cursor: Schema.NullOr(Schema.String),
  before: Schema.Number,
  fetched: Schema.Int,
  paused: Schema.Boolean,
  done: Schema.Boolean,
  lastError: Schema.NullOr(Schema.String),
  nextRunAt: Schema.Number,
});
export type BackfillState = typeof BackfillState.Type;

export interface BackfillPage {
  readonly messages: readonly import("./domain.js").IncomingMessage[];
  /** null means the account's historical snapshot is complete. */
  readonly cursor: string | null;
  readonly scanned: number;
}

export const DEFAULT_CACHE_WINDOWS = [
  { label: "ALL", days: 365 },
  { label: "INBOX", days: null },
  { label: "SPAM", days: 30 },
  { label: "TRASH", days: 30 },
] satisfies readonly Omit<CacheWindow, "accountId">[];

/** Specific labels override ALL. For multi-label mail, the longest window wins. */
export function keepBody(
  message: Pick<import("./domain.js").IncomingMessage, "date" | "labels">,
  windows: readonly Pick<CacheWindow, "label" | "days">[],
  now: number,
): boolean {
  if (message.labels.includes("DRAFT")) return true;
  const specific = windows.filter((w) => w.label !== "ALL" && message.labels.includes(w.label));
  const applicable = specific.length ? specific : windows.filter((w) => w.label === "ALL");
  return (
    applicable.length === 0 ||
    applicable.some((w) => w.days === null || message.date >= now - w.days * 86_400_000)
  );
}

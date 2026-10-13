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
  message: Pick<import("./domain.js").IncomingMessage, "date" | "labels"> &
    Partial<Pick<import("./domain.js").IncomingMessage, "isStarred">>,
  windows: readonly Pick<CacheWindow, "label" | "days">[],
  now: number,
): boolean {
  if (
    message.isStarred ||
    message.labels.some((label) => ["DRAFT", "STARRED", "OUTBOX"].includes(label))
  )
    return true;
  const specific = windows.filter((w) => w.label !== "ALL" && message.labels.includes(w.label));
  const applicable = specific.length ? specific : windows.filter((w) => w.label === "ALL");
  return (
    applicable.length === 0 ||
    applicable.some((w) => w.days === null || message.date >= now - w.days * 86_400_000)
  );
}

/** Logical SQLite pages, including headers, indexes and reusable pages; excludes the WAL file. */
export const CacheDatabaseSize = Schema.Struct({
  totalBytes: Schema.Number,
  reusableBytes: Schema.Number,
  bodyBytes: Schema.Number,
  attachmentBytes: Schema.Number,
  otherBytes: Schema.Number,
  walBytes: Schema.Number,
  recoveryBytes: Schema.Number,
  footprintBytes: Schema.Number,
  freeDiskBytes: Schema.NullOr(Schema.Number),
  lowDisk: Schema.Boolean,
  canReclaim: Schema.Boolean,
  effectiveBodyBytes: Schema.NullOr(Schema.Number),
});
export type CacheDatabaseSize = typeof CacheDatabaseSize.Type;

export const CacheCompactionResult = Schema.Literals([
  "done",
  "busy",
  "read-only",
  "unsafe",
  "low-disk",
  "failed",
  "unavailable",
]);
export type CacheCompactionResult = typeof CacheCompactionResult.Type;
export type DatabasePages = Pick<CacheDatabaseSize, "totalBytes" | "reusableBytes">;
export interface CacheFiles {
  readonly walBytes: number;
  readonly recoveryBytes: number;
  readonly disk: { readonly freeBytes: number; readonly totalBytes: number } | null;
}
/** Logical payloads are portions of used pages, not additional files. */
export function cacheAccounting(
  pages: DatabasePages,
  bodyBytes: number,
  attachmentBytes: number,
  files: CacheFiles,
) {
  const otherBytes = Math.max(0, pages.totalBytes - pages.reusableBytes - bodyBytes);
  return {
    ...pages,
    bodyBytes,
    attachmentBytes,
    otherBytes,
    walBytes: files.walBytes,
    recoveryBytes: files.recoveryBytes,
    footprintBytes: pages.totalBytes + files.walBytes + files.recoveryBytes + attachmentBytes,
    freeDiskBytes: files.disk?.freeBytes ?? null,
  };
}
/** A zero configured limit is disabled; null means no effective text limit. */
export function adaptiveBodyLimit(
  size: ReturnType<typeof cacheAccounting>,
  disk: CacheFiles["disk"],
  prefs: Pick<import("./domain.js").Prefs, "bodyCacheBytes" | "totalCacheBytes">,
  canReclaim = true,
) {
  const threshold = disk ? Math.min(5 * 1024 ** 3, disk.totalBytes * 0.1) : 0;
  const lowDisk = disk !== null && disk.freeBytes < threshold;
  const excess =
    Math.max(
      prefs.totalCacheBytes > 0 ? size.footprintBytes - prefs.totalCacheBytes : 0,
      lowDisk && canReclaim ? threshold - disk.freeBytes : 0,
      0,
    ) - size.reusableBytes;
  const limits = [
    ...(prefs.bodyCacheBytes > 0 ? [prefs.bodyCacheBytes] : []),
    ...(prefs.totalCacheBytes > 0 || (lowDisk && canReclaim)
      ? [Math.max(0, size.bodyBytes - Math.max(0, excess))]
      : []),
  ];
  return { lowDisk, effectiveBodyBytes: limits.length ? Math.min(...limits) : null };
}

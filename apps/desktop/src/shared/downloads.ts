import { Schema } from "effect";

/** One attachment saved to the attachment folder. Failures carry a category, never OS text. */
export const DownloadItem = Schema.Struct({
  id: Schema.String,
  filename: Schema.String,
  /** Expected bytes; 0 while unknown. */
  size: Schema.Int,
  /** Bytes written so far. */
  received: Schema.Int,
  status: Schema.Literals(["fetching", "writing", "done", "failed"]),
  failure: Schema.optionalKey(Schema.Literals(["fetch", "write", "missing"])),
  /** The file can run code, so OpenMail shows it in Finder but does not open it. */
  blocked: Schema.Boolean,
  startedAt: Schema.Number,
});
export type DownloadItem = typeof DownloadItem.Type;

export const DownloadCommand = Schema.Literals(["open", "show", "retry", "remove"]);
export type DownloadCommand = typeof DownloadCommand.Type;

export const AttachmentApp = Schema.Struct({ application: Schema.String, label: Schema.String });
export type AttachmentApp = typeof AttachmentApp.Type;

export const activeDownload = (item: DownloadItem) =>
  item.status === "fetching" || item.status === "writing";

/** 0–1 over all active downloads, or null when none has a known size yet. */
export function downloadsProgress(items: readonly DownloadItem[]): number | null {
  const active = items.filter(activeDownload);
  const total = active.reduce((sum, item) => sum + item.size, 0);
  if (!active.length || total === 0) return null;
  return Math.min(1, active.reduce((sum, item) => sum + item.received, 0) / total);
}

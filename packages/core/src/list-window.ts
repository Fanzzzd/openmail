import type { Prefs, MailboxView } from "./domain/domain.js";
/** Fixed row geometry shared by the renderer and its large-list tests. */
export const MESSAGE_ROW_HEIGHT = 84;
export function listWindow(
  count: number,
  scrollTop: number,
  height: number,
  rowHeight = MESSAGE_ROW_HEIGHT,
) {
  const first = Math.max(0, Math.min(count, Math.floor(scrollTop / rowHeight) - 6));
  const end = Math.min(count, Math.ceil((scrollTop + height) / rowHeight) + 6);
  return { first, end, offset: first * rowHeight, total: count * rowHeight };
}

/** Geometry and content use one density value; keyset paging remains independent. */
export const LIST_DENSITIES = {
  dense: { height: 60, previewLines: 0, attachments: false },
  compact: { height: 84, previewLines: 1, attachments: false },
  default: { height: 104, previewLines: 1, attachments: true },
  expanded: { height: 124, previewLines: 2, attachments: true },
} satisfies Record<
  Prefs["messageListDensity"],
  { height: number; previewLines: number; attachments: boolean }
>;
export function specialFolderBadge(
  folder: MailboxView,
  counts: Readonly<Record<string, number>>,
  prefs: Prefs["specialFolderBadges"],
) {
  switch (folder) {
    case "inbox":
      return counts.INBOX ?? 0;
    case "starred":
      return prefs.starred ? (counts.STARRED ?? 0) : 0;
    case "drafts":
      return prefs.drafts ? (counts.DRAFT ?? 0) : 0;
    case "spam":
      return prefs.spam ? (counts.SPAM ?? 0) : 0;
    default:
      return 0;
  }
}

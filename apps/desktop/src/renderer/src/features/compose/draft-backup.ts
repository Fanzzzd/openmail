import type { Draft } from "./draft";

/**
 * The web build's backstop for typing the Mac may not have: when the page
 * hides or unloads with an unsaved draft, the draft goes to this tab's
 * sessionStorage, and the next load of the tab opens it again. The Mac's copy
 * stays the source of truth: a backup is cleared once its typing is saved, and
 * when the composer closes, sends or discards in the app.
 */
const KEY = "openmail.open-draft";
/** A backup older than this is stale; the person has moved on. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface DraftBackup {
  draft: Draft;
  /** Whether the Mac had saved this draft before; if it's gone now, it was sent or discarded. */
  saved: boolean;
  /** Attachments didn't fit in storage; the Mac's copy has them. */
  attachmentsOmitted: boolean;
  at: number;
}

type BackupStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const store = (): BackupStorage | null => {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    // Storage can be off (private modes, blocked cookies).
    return null;
  }
};

/** Drafts this load reopened from a backup; their composer saves them at once. */
const restored = new Set<string>();

export function writeDraftBackup(
  draft: Draft,
  saved: boolean,
  storage = store(),
  now = Date.now(),
): void {
  if (!storage) return;
  const backup: DraftBackup = { draft, saved, attachmentsOmitted: false, at: now };
  try {
    storage.setItem(KEY, JSON.stringify(backup));
  } catch {
    // Over quota: attachments are base64 and can be megabytes. Keep the typing.
    try {
      storage.setItem(
        KEY,
        JSON.stringify({
          ...backup,
          draft: { ...draft, attachments: [] },
          attachmentsOmitted: true,
        }),
      );
    } catch {
      storage.removeItem(KEY);
    }
  }
}

export function readDraftBackup(storage = store(), now = Date.now()): DraftBackup | null {
  if (!storage) return null;
  let backup: Partial<DraftBackup> | null;
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- IO boundary: what this tab wrote earlier.
    backup = JSON.parse(storage.getItem(KEY) ?? "null") as Partial<DraftBackup> | null;
  } catch {
    storage.removeItem(KEY);
    return null;
  }
  if (!backup?.draft || typeof backup.draft.id !== "string" || typeof backup.at !== "number")
    return null;
  if (now - backup.at > MAX_AGE_MS) {
    storage.removeItem(KEY);
    return null;
  }
  return {
    draft: backup.draft,
    saved: backup.saved === true,
    attachmentsOmitted: backup.attachmentsOmitted === true,
    at: backup.at,
  };
}

/** Forgets the backup of draft `id`, if that is the one stored. */
export function clearDraftBackup(id: string, storage = store()): void {
  restored.delete(id);
  if (!storage) return;
  try {
    const backup = readDraftBackup(storage);
    if (backup?.draft.id === id) storage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}

/**
 * The draft to reopen from a backup, given the Mac's copy (null when it has
 * none). Typing comes from the backup; sync state and, when the backup had no
 * room for them, attachments come from the Mac. Null when the Mac had saved the
 * draft and no longer has it: it was sent or discarded, so it stays gone.
 */
export function draftFromBackup(backup: DraftBackup, stored: Draft | null): Draft | null {
  if (!stored) return backup.saved ? null : backup.draft;
  return {
    ...backup.draft,
    attachments: backup.attachmentsOmitted ? stored.attachments : backup.draft.attachments,
    ...(stored.synced === undefined ? {} : { synced: stored.synced }),
    ...(stored.syncError === undefined ? {} : { syncError: stored.syncError }),
    ...(stored.syncRetrying === undefined ? {} : { syncRetrying: stored.syncRetrying }),
    ...(stored.localOnly === undefined ? {} : { localOnly: stored.localOnly }),
  };
}

export const markRestored = (id: string) => {
  restored.add(id);
};
export const wasRestored = (id: string) => restored.has(id);

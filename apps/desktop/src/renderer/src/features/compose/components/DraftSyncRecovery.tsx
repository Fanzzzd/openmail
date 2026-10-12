import { useLingui } from "@lingui/react/macro";
import type { StoredDraft } from "../../../../../shared/api";

type SyncStatus = Pick<StoredDraft, "syncError" | "syncRetrying" | "localOnly">;
export function draftSyncNotice(draft: SyncStatus): "none" | "local" | "retrying" | "failed" {
  if (draft.localOnly) return "local";
  if (draft.syncError) return draft.syncRetrying ? "retrying" : "failed";
  return "none";
}

/** Provider details stay in core. Recovery notices explain the state in the UI language. */
export function DraftSyncRecovery({
  draft,
  busy,
  onRecover,
}: {
  draft: SyncStatus;
  busy: boolean;
  onRecover: (action: "retry" | "local") => void;
}) {
  const { t } = useLingui();
  const state = draftSyncNotice(draft);
  if (state === "local")
    return (
      <div className="shrink-0 border-b px-4 py-2 border-separator">
        <output>{t`Kept on this Mac`}</output>
        <button
          type="button"
          disabled={busy}
          className="ml-3"
          onClick={() => onRecover("retry")}
        >{t`Resume syncing`}</button>
      </div>
    );
  if (state !== "failed") return null;
  return (
    <div className="shrink-0 border-b px-4 py-2 border-separator">
      <output role="alert">{t`Couldn't sync`}</output>
      <p className="text-a11y-muted">{t`Your changes are saved on this Mac. Try again or keep a local copy.`}</p>
      <div className="mt-1 flex gap-3">
        <button type="button" disabled={busy} onClick={() => onRecover("retry")}>{t`Retry`}</button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onRecover("local")}
        >{t`Keep local copy`}</button>
      </div>
    </div>
  );
}

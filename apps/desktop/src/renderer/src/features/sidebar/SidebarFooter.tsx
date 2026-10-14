import { useLingui } from "@lingui/react/macro";
import { RefreshCw, Settings as SettingsIcon } from "lucide-react";
import type { Account, SyncProgress, SyncState } from "../../../../shared/api";
import { useShortcutText } from "../../i18n/use-shortcut-text";
import { syncNow, useRunMail } from "../../state/mail";
import { Tip } from "../../ui/Tip";
import { SyncStatusAnnouncement } from "../sync-status";
import { dateFormat } from "../../lib/format";

/** The sidebar's last row: sync progress or result, Settings and Sync now. */
export function SidebarFooter({
  accounts,
  syncState,
  progress,
  failures,
  onSettings,
}: {
  accounts: readonly Account[];
  syncState: SyncState;
  progress: SyncProgress | null;
  failures: readonly string[];
  onSettings: () => void;
}) {
  const { t, i18n } = useLingui();
  const shortcut = useShortcutText();
  const run = useRunMail();
  /** The footer line: progress while syncing, then failures or the last sync time. */
  const syncStatus = () => {
    if (syncState.running) {
      if (!progress) return t`Syncing…`;
      const fetched = i18n.number(progress.fetched),
        total = i18n.number(progress.total);
      return t`Syncing ${fetched}/${total}`;
    }
    if (failures.length) {
      const count = i18n.number(failures.length);
      return t`Sync failed (${count})`;
    }
    if (!syncState.lastFinishedAt) return "";
    const { locale, time: timeOptions } = dateFormat(i18n);
    const time = new Date(syncState.lastFinishedAt).toLocaleTimeString(locale, timeOptions);
    return t`Synced ${time}`;
  };
  return (
    <footer className="flex items-center gap-2 px-4 py-2 text-footnote text-a11y-muted">
      {/* With no account there is nothing to sync, so the footer keeps only Settings. */}
      <span className="line-clamp-2 min-w-0 flex-1" title={failures.join("\n")}>
        {/* Readable on mount too: the announcement below stays silent until the state changes. */}
        {accounts.length > 0 && (
          <>
            <span>{syncStatus()}</span>
            <SyncStatusAnnouncement failed={failures.length > 0} />
          </>
        )}
      </span>
      <Tip label={t`Settings`} shortcut={shortcut("settings")} side="top">
        <button
          type="button"
          aria-label={t`Settings`}
          onClick={onSettings}
          className="rounded p-1 hover:bg-fill-hover"
        >
          <SettingsIcon className="size-3.5" />
        </button>
      </Tip>
      {accounts.length > 0 && (
        <Tip label={t`Sync now`} shortcut={shortcut("sync")} side="top">
          <button
            type="button"
            aria-label={t`Sync now`}
            onClick={() => run(syncNow)}
            className="rounded p-1 hover:bg-fill-hover"
          >
            <RefreshCw className={`size-3.5 ${syncState.running ? "animate-spin" : ""}`} />
          </button>
        </Tip>
      )}
    </footer>
  );
}

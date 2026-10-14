import { useLingui } from "@lingui/react/macro";
import { History } from "lucide-react";
import type { UndoHistoryEntry } from "@openmail/core/schema";
import { DropdownMenu, MenuItem } from "../../ui/Menu";
import { touchIcon } from "../../ui/styles";
import { dateFormat } from "../../lib/format";

/** Restored operations are selected explicitly and never become the window Undo command. */
export function UndoHistory({
  entries,
  onUndo,
}: {
  entries: readonly UndoHistoryEntry[];
  onUndo: (id: string) => void;
}) {
  const { t, i18n } = useLingui();
  return (
    <DropdownMenu
      trigger={
        <button
          type="button"
          aria-label={t`Undo history`}
          className={`rounded-control p-1.5 ${touchIcon} text-a11y-muted hover:bg-fill-hover`}
        >
          <History className="size-4" />
        </button>
      }
    >
      <p className="max-w-72 px-2 py-1 text-footnote text-a11y-muted">{t`Operations from the last 24 hours. Restores labels, folders and flags after checking current state.`}</p>
      <div className="max-h-72 overflow-auto">
        {entries.length ? (
          entries.map((entry) => (
            <MenuItem
              key={entry.undoId}
              onClick={() => onUndo(entry.undoId)}
            >{t`Undo operation from ${new Date(entry.createdAt).toLocaleString(dateFormat(i18n).locale, { dateStyle: "medium", timeStyle: "short", ...dateFormat(i18n).clock })}`}</MenuItem>
          ))
        ) : (
          <p className="px-2 py-1">{t`No operations to undo`}</p>
        )}
      </div>
    </DropdownMenu>
  );
}

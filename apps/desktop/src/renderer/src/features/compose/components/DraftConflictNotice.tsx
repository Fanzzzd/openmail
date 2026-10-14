import { useLingui } from "@lingui/react/macro";

/**
 * Someone saved this draft in another window or on another device after this editor
 * loaded it. The editor shows their version; the person's own text stays one click away.
 */
export function DraftConflictNotice({
  onRestore,
  onDismiss,
}: {
  onRestore: () => void;
  onDismiss: () => void;
}) {
  const { t } = useLingui();
  return (
    <div className="shrink-0 border-b px-4 py-2 border-separator">
      <output>{t`This draft changed in another window or on another device. The newer version is open.`}</output>
      <div className="mt-1 flex gap-3">
        <button type="button" onClick={onRestore}>{t`Restore my version`}</button>
        <button type="button" onClick={onDismiss}>{t`Keep the newer version`}</button>
      </div>
    </div>
  );
}

import { useState } from "react";
import { useLingui } from "@lingui/react/macro";

/** Sync ticks and progress stay visual; only entering/clearing failure is announced. */
export function SyncStatusAnnouncement({ failed }: { failed: boolean }) {
  const { t } = useLingui();
  const [state, setState] = useState<"initial" | "failed" | "cleared">("initial");
  if (failed && state !== "failed") setState("failed");
  else if (!failed && state === "failed") setState("cleared");
  return (
    <output aria-live="polite" aria-atomic="true" className="sr-only">
      {state === "failed" ? t`Sync failed` : state === "cleared" ? t`Syncing normally` : ""}
    </output>
  );
}

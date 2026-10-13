import { useEffect, useState } from "react";
import { OPEN_SETTINGS_EVENT } from "../features/ai/open-ai-settings";
import type { MailDialog } from "../../../shared/routes";

/**
 * Settings opened from elsewhere in the window: an account's optional services, or the AI
 * pane. The dialog itself renders in AppDialogs.
 */
export function useSettingsRequests(setDialog: (dialog: MailDialog | null) => void) {
  const [optionalAccountId, setOptionalAccountId] = useState<string | null>(null);
  useEffect(() => {
    const open = (event: Event) => {
      if (event instanceof CustomEvent && typeof event.detail === "string") {
        setOptionalAccountId(event.detail);
        setDialog("settings");
      }
    };
    window.addEventListener("openmail:optional-services", open);
    return () => window.removeEventListener("openmail:optional-services", open);
  }, [setDialog]);
  const [settingsTab, setSettingsTab] = useState<"ai" | null>(null);
  useEffect(() => {
    const open = () => {
      setSettingsTab("ai");
      setDialog("settings");
    };
    window.addEventListener(OPEN_SETTINGS_EVENT, open);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, open);
  }, [setDialog]);
  return { optionalAccountId, setOptionalAccountId, settingsTab, setSettingsTab };
}

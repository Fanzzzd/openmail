import { Trans } from "@lingui/react/macro";
import { useEffect } from "react";
import { useWebConnection } from "../../state/web-connection";
import { buttonSecondary } from "../../ui/styles";

const RECONNECT_MS = 3000;

/**
 * The web build's link to the Mac. A dropped socket reloads the page after a
 * pause, which opens a new socket. A session the Mac ended waits for the
 * person: reloading asks the Mac again, which works only if the login is still
 * allowed.
 */
export function ConnectionNotice() {
  const state = useWebConnection();
  useEffect(() => {
    const timer =
      state === "lost" ? setTimeout(() => window.location.reload(), RECONNECT_MS) : undefined;
    return () => clearTimeout(timer);
  }, [state]);
  if (state !== "lost" && state !== "ended") return null;
  return (
    <output className="fixed inset-x-0 top-0 z-[100] flex items-center justify-center gap-3 bg-amber-100 px-4 py-2 text-body text-amber-950 shadow-control pt-[max(0.5rem,env(safe-area-inset-top))] dark:bg-amber-900 dark:text-amber-50">
      <span>
        {state === "lost" ? (
          <Trans>Lost the connection to your Mac. Reconnecting…</Trans>
        ) : (
          <Trans>Your Mac ended this session.</Trans>
        )}
      </span>
      {state === "ended" && (
        <button type="button" className={buttonSecondary} onClick={() => window.location.reload()}>
          <Trans>Reload</Trans>
        </button>
      )}
    </output>
  );
}

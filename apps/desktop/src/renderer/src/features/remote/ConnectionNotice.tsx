import { Trans } from "@lingui/react/macro";
import { useWebConnection, useWebUpdate } from "../../state/web-connection";
import { buttonSecondary } from "../../ui/styles";

/**
 * The web build's link to the Mac. A dropped socket reconnects in place
 * (state/web-socket-bridge.ts), so the page, the open message and any typing
 * stay; quitting or restarting OpenMail on the Mac is a drop like any other.
 * A session the Mac ended (Disconnect, the session limit, turning remote
 * access off, or the login leaving the allowlist) waits for the person:
 * reloading starts a new session if the login is still allowed. A newer build
 * on the Mac reloads by itself unless a draft has unsaved typing; then this asks.
 */
export function ConnectionNotice() {
  const state = useWebConnection();
  const updated = useWebUpdate();
  const notice =
    state === "lost" ? "lost" : state === "ended" ? "ended" : updated ? "updated" : null;
  if (!notice) return null;
  return (
    <output className="fixed inset-x-0 top-0 z-[100] flex items-center justify-center gap-3 bg-amber-100 px-4 py-2 text-body text-amber-950 shadow-control pt-[max(0.5rem,env(safe-area-inset-top))] dark:bg-amber-900 dark:text-amber-50">
      <span>
        {notice === "lost" ? (
          <Trans>Can't reach OpenMail on your Mac. Reconnecting…</Trans>
        ) : notice === "ended" ? (
          <Trans>
            Your Mac disconnected this browser. Reload to connect again while your login is still
            allowed.
          </Trans>
        ) : (
          <Trans>OpenMail on your Mac was updated. Reload to use the new version.</Trans>
        )}
      </span>
      {notice !== "lost" && (
        <button type="button" className={buttonSecondary} onClick={() => window.location.reload()}>
          <Trans>Reload</Trans>
        </button>
      )}
    </output>
  );
}

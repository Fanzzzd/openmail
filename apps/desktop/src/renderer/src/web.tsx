import { createBrowserHistory } from "@tanstack/history";

import { ConnectionNotice } from "./features/remote";
import { setPlatform } from "./lib/platform";
import { trackKeyboardInset } from "./lib/keyboard-inset";
import { renderApp } from "./routes/render-app";
import { setRpcBridge } from "./state/rpc-bridge";
import { backupUnsavedWork, flushUnsavedWork, hasUnsavedWork } from "./state/unsaved-work";
import { setWebConnection, setWebUpdate } from "./state/web-connection";
import { probeSession, rpcSocketUrl, webSocketBridge } from "./state/web-socket-bridge";
import "./styles.css";

// The web build, served by the Mac to the person's own devices over their
// tailnet. Same app; RPC travels over a WebSocket and routes use real paths.
setPlatform("web");
setRpcBridge(
  webSocketBridge(rpcSocketUrl(window.location), setWebConnection, {
    probe: () => probeSession(),
    // A phone back from the lock screen or a network switch reconnects at once.
    wake: (reconnect) => {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") reconnect();
      });
      window.addEventListener("online", reconnect);
    },
    onUpdate: () => {
      if (hasUnsavedWork()) setWebUpdate();
      else window.location.reload();
    },
  }),
);

// A hidden page may be frozen or discarded: drafts save now, not after their
// debounce, and go to this tab's storage first in case the Mac doesn't get them.
const saveNow = () => {
  backupUnsavedWork();
  void flushUnsavedWork();
};
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") saveNow();
});
window.addEventListener("pagehide", saveNow);
window.addEventListener("beforeunload", (event) => {
  saveNow();
  if (hasUnsavedWork()) event.preventDefault();
});
trackKeyboardInset(window);

renderApp(createBrowserHistory(), <ConnectionNotice />);

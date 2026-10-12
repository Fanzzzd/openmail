import { RegistryProvider } from "@effect/atom-react";
import { createBrowserHistory } from "@tanstack/history";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ConnectionNotice } from "./features/remote";
import { LocaleProvider } from "./i18n/LocaleProvider";
import { setPlatform } from "./lib/platform";
import { AppRouterProvider } from "./routes/provider";
import { createAppRouter, historyFor, initialLocation } from "./routes/router";
import { historyAtom, locationAtom } from "./state/location";
import { setRpcBridge } from "./state/rpc-bridge";
import { setWebConnection } from "./state/web-connection";
import { rpcSocketUrl, webSocketBridge } from "./state/web-socket-bridge";
import { ConfirmHost } from "./ui/Confirm";
import { TipProvider } from "./ui/Tip";
import "./styles.css";

// The web build, served by the Mac to the person's own devices over their
// tailnet. Same app; RPC travels over a WebSocket and routes use real paths.
setPlatform("web");
setRpcBridge(webSocketBridge(rpcSocketUrl(window.location), setWebConnection));

const router = createAppRouter(createBrowserHistory());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RegistryProvider
      initialValues={[
        [locationAtom, initialLocation(router)],
        [historyAtom, historyFor(router)],
      ]}
    >
      <LocaleProvider>
        <TipProvider>
          <ConnectionNotice />
          <ConfirmHost />
          <AppRouterProvider router={router} />
        </TipProvider>
      </LocaleProvider>
    </RegistryProvider>
  </StrictMode>,
);

import { createBrowserHistory } from "@tanstack/history";

import { ConnectionNotice } from "./features/remote";
import { setPlatform } from "./lib/platform";
import { renderApp } from "./routes/render-app";
import { setRpcBridge } from "./state/rpc-bridge";
import { setWebConnection } from "./state/web-connection";
import { rpcSocketUrl, webSocketBridge } from "./state/web-socket-bridge";
import "./styles.css";

// The web build, served by the Mac to the person's own devices over their
// tailnet. Same app; RPC travels over a WebSocket and routes use real paths.
setPlatform("web");
setRpcBridge(webSocketBridge(rpcSocketUrl(window.location), setWebConnection));

renderApp(createBrowserHistory(), <ConnectionNotice />);

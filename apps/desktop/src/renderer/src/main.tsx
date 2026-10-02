import { RegistryProvider } from "@effect/atom-react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { WindowKeys } from "./components/WindowKeys";
import { App } from "./App";
import { ThreadWindow } from "./ThreadWindow";
import { LocaleProvider } from "./components/LocaleProvider";
import { TipProvider } from "./components/ui/Tip";
import "./styles.css";

/** Set in thread windows: the message whose thread the window shows. */
const thread = new URLSearchParams(window.location.search).get("thread");

// One atom registry for the window. Data atoms refetch when a change
// invalidates their reactivity keys (state/keys.ts), not on a timer or focus.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RegistryProvider>
      <LocaleProvider>
        <TipProvider>
          <WindowKeys />
          {thread ? (
            <ThreadWindow
              id={thread}
              single={new URLSearchParams(window.location.search).get("single") === "1"}
            />
          ) : (
            <App />
          )}
        </TipProvider>
      </LocaleProvider>
    </RegistryProvider>
  </StrictMode>,
);

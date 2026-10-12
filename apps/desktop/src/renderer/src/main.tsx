import { RegistryProvider } from "@effect/atom-react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { WindowKeys } from "./app/WindowKeys";
import { App } from "./app/App";
import { ThreadWindow } from "./app/ThreadWindow";
import { LocaleProvider } from "./i18n/LocaleProvider";
import { TipProvider } from "./ui/Tip";
import { ConfirmHost } from "./ui/Confirm";
import { WindowUi } from "./app/WindowUi";
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
          <WindowUi />
          <ConfirmHost />
          {thread ? (
            <ThreadWindow
              id={thread}
              single={new URLSearchParams(window.location.search).get("single") === "1"}
            />
          ) : (
            <App
              composeId={new URLSearchParams(window.location.search).get("compose") ?? undefined}
            />
          )}
        </TipProvider>
      </LocaleProvider>
    </RegistryProvider>
  </StrictMode>,
);

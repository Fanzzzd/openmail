import { RegistryProvider } from "@effect/atom-react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { WindowKeys } from "./app/WindowKeys";
import { LocaleProvider } from "./i18n/LocaleProvider";
import { TipProvider } from "./ui/Tip";
import { ConfirmHost } from "./ui/Confirm";
import { WindowUi } from "./app/WindowUi";
import { historyFor, initialLocation } from "./app/location-bridge";
import { historyAtom, locationAtom } from "./state/location";
import { AppRouterProvider } from "./routes/provider";
import { createAppHashHistory } from "./routes/hash-history";
import { legacyHref } from "./routes/legacy";
import { createAppRouter } from "./routes/router";
import "./styles.css";

const legacy = window.location.hash ? null : legacyHref(window.location.search);
if (legacy) window.history.replaceState(null, "", `#${legacy}`);
const router = createAppRouter(createAppHashHistory());

// One atom registry for the window. Data atoms refetch when a change
// invalidates their reactivity keys (state/keys.ts), not on a timer or focus.
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
          <WindowKeys />
          <WindowUi />
          <ConfirmHost />
          <AppRouterProvider router={router} />
        </TipProvider>
      </LocaleProvider>
    </RegistryProvider>
  </StrictMode>,
);

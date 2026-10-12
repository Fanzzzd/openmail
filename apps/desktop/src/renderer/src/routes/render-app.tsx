import { RegistryProvider } from "@effect/atom-react";
import type { RouterHistory } from "@tanstack/history";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { LocaleProvider } from "../i18n/LocaleProvider";
import { historyAtom, locationAtom } from "../state/location";
import { ConfirmHost } from "../ui/Confirm";
import { TipProvider } from "../ui/Tip";
import { AppRouterProvider } from "./provider";
import { createAppRouter, historyFor, initialLocation } from "./router";

/**
 * Mounts the app on #root with one atom registry. Data atoms refetch when a
 * change invalidates their reactivity keys (state/keys.ts), not on a timer or
 * focus. `chrome` sits beside the router: window keys for the desktop, the
 * connection notice for the web build.
 */
export function renderApp(history: RouterHistory, chrome: ReactNode) {
  const router = createAppRouter(history);
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
            {chrome}
            <ConfirmHost />
            <AppRouterProvider router={router} />
          </TipProvider>
        </LocaleProvider>
      </RegistryProvider>
    </StrictMode>,
  );
}

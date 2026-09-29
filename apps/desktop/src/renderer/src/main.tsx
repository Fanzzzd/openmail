import { RegistryProvider } from "@effect/atom-react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles.css";

// One atom registry for the window. Data atoms refetch when a change
// invalidates their reactivity keys (state/keys.ts), not on a timer or focus.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RegistryProvider>
      <App />
    </RegistryProvider>
  </StrictMode>,
);

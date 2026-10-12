import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import type { RecoveryBridge, RecoveryPrompt as Prompt } from "../../../shared/recovery";
import { RecoveryPrompt } from "./RecoveryPrompt";
import "../styles.css";

declare global {
  interface Window {
    openmailRecovery: RecoveryBridge;
  }
}

function Recovery() {
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  useEffect(() => {
    void (async () => {
      const next = await window.openmailRecovery.prompt();
      document.documentElement.lang = next.locale;
      document.title = next.message;
      setPrompt(next);
    })();
  }, []);
  useEffect(() => {
    // The main process shows the window, and drops its native fallback, after the first paint.
    if (prompt) requestAnimationFrame(() => window.openmailRecovery.answer(-1));
  }, [prompt]);
  return prompt ? (
    <RecoveryPrompt prompt={prompt} onAnswer={(index) => window.openmailRecovery.answer(index)} />
  ) : null;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Recovery />
  </StrictMode>,
);

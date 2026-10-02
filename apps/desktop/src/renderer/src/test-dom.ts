import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { vi } from "vitest";

/** Node-only DOM harness; no browser or Electron process. Always restore globals. */
export function testDom() {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", window.document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const element = window.document.getElementById("root");
  if (!element) throw new Error("Missing test root");
  const root = createRoot(element);
  return {
    render(node: ReactNode) {
      act(() => root.render(node));
    },
    element,
    window,
    dispose() {
      act(() => root.unmount());
      vi.unstubAllGlobals();
    },
  };
}

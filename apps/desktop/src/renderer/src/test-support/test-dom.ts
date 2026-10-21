import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { vi } from "vitest";
import { mountedTestDoms } from "./test-dom-leaks";

/**
 * Node-only DOM harness; no browser or Electron process. Call `dispose` in a `finally`: a root
 * left mounted is unmounted after the test, which then fails.
 */
export function testDom() {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", window.document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Base UI and Floating UI type-check nodes against these constructors.
  for (const name of ["Node", "Element", "HTMLElement", "HTMLInputElement", "HTMLButtonElement"])
    vi.stubGlobal(name, Reflect.get(window, name));
  const element = window.document.getElementById("root");
  if (!element) throw new Error("Missing test root");
  const root = createRoot(element);
  const dispose = () => {
    if (!mountedTestDoms().delete(dispose)) return;
    act(() => root.unmount());
    vi.unstubAllGlobals();
  };
  mountedTestDoms().add(dispose);
  return {
    render(node: ReactNode) {
      act(() => root.render(node));
    },
    element,
    window,
    /** Unmounts the root and restores the globals. A root left mounted fails its test. */
    dispose,
  };
}

import { expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { listenForMessageActivation } from "./message-activation";

it("autofocus and synthetic events cannot select received mail; trusted input can", () => {
  const { document, window } = parseHTML("<html><body><input autofocus></body></html>");
  const activate = vi.fn();
  const stop = listenForMessageActivation(document, activate);
  const input = document.querySelector("input");
  if (!input) throw new Error("Missing autofocus field");
  for (const type of ["focusin", "pointerdown", "keydown"]) {
    input.dispatchEvent(new window.Event(type, { bubbles: true }));
    expect(activate).not.toHaveBeenCalled();
  }
  for (const type of ["pointerdown", "keydown"]) {
    const event = new window.Event(type, { bubbles: true });
    Object.defineProperty(event, "isTrusted", { value: true });
    input.dispatchEvent(event);
  }
  expect(activate).toHaveBeenCalledTimes(2);
  stop();
  const event = new window.Event("keydown", { bubbles: true });
  Object.defineProperty(event, "isTrusted", { value: true });
  input.dispatchEvent(event);
  expect(activate).toHaveBeenCalledTimes(2);
});

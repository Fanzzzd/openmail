import { expect } from "vitest";
import { screen } from "@testing-library/react/pure";
import type { key as pressKey } from "./harness";

/** Walks Subject, body and the controls between them with Tab and Shift-Tab. */
export function expectComposeTabOrder(key: typeof pressKey) {
  const subject = screen.getByRole("textbox", { name: "Subject" });
  const body = screen.getByRole("textbox", { name: "Body" });
  const signature = screen.getByRole("combobox", { name: "Signature" });
  subject.focus();
  key("Tab");
  expect(document.activeElement).toBe(body);
  key("Tab", { shiftKey: true });
  expect(document.activeElement).toBe(subject);
  key("Tab");
  key("Tab");
  // The first control drawn between Subject and the body comes right after the body.
  expect(document.activeElement).toBe(signature);
  key("Tab", { shiftKey: true });
  expect(document.activeElement).toBe(body);
  // The writing mode picker stays reachable from the keyboard.
  const mode = screen.getByRole("combobox", { name: "Writing mode" });
  for (let i = 0; i < 20 && document.activeElement !== mode; i++) key("Tab");
  expect(document.activeElement).toBe(mode);
}

// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { constVoid } from "effect/Function";
import { EmailFrame } from "./EmailFrame";
import { MAX_UNPROMPTED_GROWTH } from "./frame-style";

vi.mock("../../../state/mail", () => ({ useRunMail: () => constVoid, withMail: constVoid }));

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
});

it.each(["light", "dark"])("a locked preview has a readable page in the %s app theme", (theme) => {
  document.documentElement.classList.toggle("dark", theme === "dark");
  render(
    createElement(
      I18nProvider,
      { i18n: setupI18n({ locale: "en", messages: {} }) },
      createElement(EmailFrame, {
        presentation: "compose",
        html: '<p>Get</p><span style="color:#212121">Outlook for iOS</span>',
        remote: false,
        background: "light",
        zoom: 100,
        onActivate: constVoid,
        previous: { bodies: [], before: 0 },
        findQuery: "",
        findIndex: 0,
        onMatches: undefined,
      }),
    ),
  );
  const frame = screen.getByTitle("Message");
  if (!(frame instanceof HTMLIFrameElement) || !frame.contentDocument || !frame.contentWindow)
    throw new Error("Missing preview frame document");
  // jsdom does not load srcdoc; render the actual component's page in its frame document.
  frame.contentDocument.open();
  frame.contentDocument.write(frame.srcdoc);
  frame.contentDocument.close();
  const doc = frame.contentDocument;
  const view = frame.contentWindow;
  const styles = (element: Element) => view.getComputedStyle(element);
  expect(styles(doc.documentElement).backgroundColor).toBe("rgb(255, 255, 255)");
  expect(styles(doc.body).backgroundColor).toBe("rgb(255, 255, 255)");
  expect(styles(doc.body).color).toBe("rgb(31, 31, 31)");
  const text = doc.querySelector("span");
  if (!text) throw new Error("Missing signature text");
  expect(styles(text).color).toBe("rgb(33, 33, 33)");
  expect(styles(doc.documentElement).filter).not.toContain("invert");
  expect(frame.getAttribute("sandbox")).toBe("allow-same-origin");
});

it("stops growing a frame whose mail keeps following its height, until the mail changes", async () => {
  const observers: (() => void)[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        observers.push(callback);
      }
      observe = constVoid;
      disconnect = constVoid;
    },
  );
  render(
    createElement(
      I18nProvider,
      { i18n: setupI18n({ locale: "en", messages: {} }) },
      createElement(EmailFrame, {
        html: "<p>Hello</p>",
        remote: false,
        background: "light",
        zoom: 100,
        onActivate: constVoid,
        previous: { bodies: [], before: 0 },
        findQuery: "",
        findIndex: 0,
        onMatches: undefined,
      }),
    ),
  );
  const frame = screen.getByTitle("Message");
  if (!(frame instanceof HTMLIFrameElement) || !frame.contentDocument)
    throw new Error("Missing message frame document");
  const doc = frame.contentDocument;
  doc.open();
  doc.write(frame.srcdoc);
  doc.close();
  Object.defineProperty(doc, "URL", { value: "about:srcdoc" });
  // jsdom has no FontFaceSet.
  Object.defineProperty(doc, "fonts", { value: new EventTarget() });
  // A page as tall as the frame plus 40px of padding, as Chromium lays out
  // `html, body { height: 100% } body { padding: 20px }` without the overrides.
  const height = () => Number.parseFloat(frame.style.height);
  Object.defineProperty(doc.documentElement, "scrollHeight", { get: () => height() + 40 });
  await act(async () => {
    frame.dispatchEvent(new Event("load"));
  });
  const resize = async () => {
    await act(async () => {
      for (const callback of observers) callback();
    });
  };
  for (let pass = 0; pass < 50; pass++) await resize();
  const stopped = height();
  // The reader's own quote and search marks count as page changes, hence the extra steps.
  expect(stopped).toBeLessThanOrEqual(120 + 40 * 2 * MAX_UNPROMPTED_GROWTH);
  for (let pass = 0; pass < 50; pass++) await resize();
  expect(height()).toBe(stopped);
  // New content in the page lets the frame grow to it again, as far as before.
  await act(async () => {
    doc.body.append(doc.createElement("p"));
  });
  for (let pass = 0; pass < 50; pass++) await resize();
  expect(height()).toBe(stopped + 40 * MAX_UNPROMPTED_GROWTH);
  // The overrides that keep real mail from following the frame are in place.
  expect(doc.body.style.getPropertyValue("height")).toBe("auto");
  vi.unstubAllGlobals();
});

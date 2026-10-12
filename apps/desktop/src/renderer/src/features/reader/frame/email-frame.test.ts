// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { constVoid } from "effect/Function";
import { EmailFrame } from "./EmailFrame";

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

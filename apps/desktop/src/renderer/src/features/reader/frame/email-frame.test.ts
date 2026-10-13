// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
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

it("re-measures the page with the frame collapsed whenever the page changes", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
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
  const box = frame.parentElement;
  if (!(frame instanceof HTMLIFrameElement) || !frame.contentDocument || !box)
    throw new Error("Missing message frame document");
  const doc = frame.contentDocument;
  doc.open();
  doc.write(frame.srcdoc);
  doc.close();
  Object.defineProperty(doc, "URL", { value: "about:srcdoc" });
  // jsdom has no FontFaceSet.
  const fonts = new EventTarget();
  Object.defineProperty(doc, "fonts", { value: fonts });
  // Like Chromium, scrollHeight is never less than the frame: 1000 px here,
  // unless the frame is collapsed.
  let page = 200;
  Object.defineProperty(doc.documentElement, "scrollHeight", {
    get: () => (frame.style.height === "0px" ? page : Math.max(page, 1000)),
  });
  const frameDrawn = () =>
    act(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        }),
    );
  await act(async () => {
    frame.dispatchEvent(new Event("load"));
  });
  await frameDrawn();
  expect(box.style.height).toBe("200px");
  expect(frame.style.height).toBe("");
  // A late image, a web font and the page's own DOM each measure again.
  const changes = [
    () => doc.body.append(doc.createElement("p")),
    () => doc.body.dispatchEvent(new Event("load")),
    () => fonts.dispatchEvent(new Event("loadingdone")),
  ];
  for (const [index, change] of changes.entries()) {
    page = 300 + index * 100;
    await act(async () => change());
    await frameDrawn();
    expect(box.style.height).toBe(`${page}px`);
  }
  // The overrides that keep real mail from following the frame are in place.
  expect(doc.body.style.getPropertyValue("height")).toBe("auto");
  vi.unstubAllGlobals();
});

it("loads no stylesheet from the network, even with remote images allowed", () => {
  render(
    createElement(
      I18nProvider,
      { i18n: setupI18n({ locale: "en", messages: {} }) },
      createElement(EmailFrame, {
        html: '<link rel="stylesheet" href="https://mail.example.com/a.css"><style>@import "https://mail.example.com/b.css";</style><p>Hi</p>',
        remote: true,
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
  if (!(frame instanceof HTMLIFrameElement)) throw new Error("Missing frame");
  const page = new DOMParser().parseFromString(frame.srcdoc, "text/html");
  const policy =
    page.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? "";
  const directive = (name: string) =>
    policy
      .split(";")
      .map((part) => part.trim().split(/\s+/))
      .find(([key]) => key === name)
      ?.slice(1);
  // The sanitizer already drops <link> and @import; the policy holds if one slips through.
  expect(page.body.innerHTML).not.toMatch(/<link|@import/i);
  // A fetched stylesheet's own url() and @import bypass the tracker and pixel filters.
  expect(directive("style-src")).toEqual(["'unsafe-inline'"]);
  expect(directive("img-src")).toContain("https:");
});

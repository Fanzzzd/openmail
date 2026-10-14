import { i18n as globalI18n, setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { EMPTY_QUOTE_HISTORY } from "@openmail/core/schema";
import { constVoid } from "effect/Function";
import { act, createElement } from "react";
import { expect, it, vi } from "vitest";
import { testDom } from "../../../test-support/test-dom";
import { LazyEmailFrame, loadMessageBody } from "./MessageBodyShell";

const chunk = vi.hoisted(() => ({ fail: true }));
vi.mock("./MessageBody", () => {
  if (chunk.fail) throw new Error("chunk failed to load");
  return { EmailFrame: () => createElement("p", null, "message body") };
});

it("shows Try again when the body chunk fails to load, and it loads the chunk again", async () => {
  const dom = testDom();
  const consoleError = vi.spyOn(console, "error").mockImplementation(constVoid);
  globalI18n.load("en", {});
  globalI18n.activate("en");
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  try {
    dom.render(
      createElement(
        I18nProvider,
        { i18n },
        createElement(LazyEmailFrame, {
          html: "<p>hi</p>",
          remote: false,
          background: "light",
          zoom: 100,
          onActivate: constVoid,
          previous: EMPTY_QUOTE_HISTORY,
          findQuery: "",
          findIndex: 0,
          onMatches: undefined,
        }),
      ),
    );
    expect(dom.element.querySelector("output[aria-busy]")?.textContent).toBe("Loading…");
    await act(() => loadMessageBody());
    const alert = dom.element.querySelector("[role=alert]");
    expect(alert?.textContent).toContain("Couldn't load this message.");

    chunk.fail = false;
    const retry = alert?.querySelector("button");
    expect(retry?.textContent).toBe("Try again");
    act(() => retry?.click());
    expect(dom.element.querySelector("output[aria-busy]")).not.toBeNull();
    await act(() => loadMessageBody());
    expect(dom.element.textContent).toBe("message body");
  } finally {
    consoleError.mockRestore();
    dom.dispose();
  }
});

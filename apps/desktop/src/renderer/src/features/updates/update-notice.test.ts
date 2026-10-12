import { createElement } from "react";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { AsyncResult } from "effect/reactivity";
import { afterAll, expect, it, vi } from "vitest";
import type { UpdateState } from "@openmail/core/schema";
import { testDom } from "../../test-support/test-dom";

const controls = vi.hoisted((): { state: UpdateState } => {
  vi.resetModules();
  const state: UpdateState = { status: "disabled" };
  return { state };
});
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => AsyncResult.success(controls.state) }));
vi.mock("../../state/queries", () => ({ updateStateAtom: {} }));
import { UpdateNotice } from "./UpdateNotice";
afterAll(() => {
  vi.doUnmock("@effect/atom-react");
  vi.doUnmock("../../state/queries");
  vi.resetModules();
});

it("background availability and download readiness are visible outside Settings", () => {
  const dom = testDom();
  const open = vi.fn();
  const render = (state: UpdateState) => {
    controls.state = state;
    dom.render(
      createElement(
        I18nProvider,
        { i18n: setupI18n({ locale: "en", messages: { en: {} } }) },
        createElement(UpdateNotice, { onSettings: open }),
      ),
    );
  };
  try {
    render({ status: "disabled" });
    expect(dom.element.textContent).toBe("");
    render({ status: "available", version: "2.0.0" });
    expect(dom.element.textContent).toContain("Update 2.0.0 is available.");
    dom.element.querySelector("button")?.click();
    expect(open).toHaveBeenCalledOnce();
    render({ status: "downloading", version: "2.0.0" });
    expect(dom.element.textContent).toContain("Downloading update 2.0.0");
    render({ status: "downloaded", version: "2.0.0" });
    expect(dom.element.textContent).toContain("It will install when you quit.");
    render({ status: "upToDate" });
    expect(dom.element.textContent).toBe("");
  } finally {
    dom.dispose();
  }
});

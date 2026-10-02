import { createElement } from "react";
import { afterAll, expect, it, vi } from "vitest";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { testDom } from "./test-dom";

vi.mock("./components/ui/Select", () => ({
  Select: ({ className }: { className: string }) =>
    createElement("button", { className }, "Profile"),
}));
import { ProfileSwitcher } from "./components/ProfileSettings";

afterAll(() => {
  vi.doUnmock("./components/ui/Select");
  vi.resetModules();
});
it("Profile toolbar drags the window while its picker remains clickable", () => {
  const dom = testDom();
  try {
    dom.render(
      createElement(
        I18nProvider,
        { i18n: setupI18n({ locale: "en", messages: { en: {} } }) },
        createElement(ProfileSwitcher, {
          profiles: [{ id: "work", name: "Work", icon: "W", color: "blue", position: 0 }],
          value: "work",
          onChange: () => null,
        }),
      ),
    );
    const control = dom.element.querySelector("button");
    expect(control?.classList.contains("no-drag")).toBe(true);
    expect(control?.parentElement?.classList.contains("drag")).toBe(true);
    expect(control?.parentElement?.classList.contains("no-drag")).toBe(false);
  } finally {
    dom.dispose();
  }
});

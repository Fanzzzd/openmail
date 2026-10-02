import { createElement, type ReactNode } from "react";
import { afterAll, expect, it, vi } from "vitest";
import { testDom } from "./test-dom";

const controls = vi.hoisted(() => {
  vi.resetModules();
  return { layouts: new Array<{ id: string; panelIds: string[] }>() };
});
vi.mock("react-resizable-panels", () => ({
  Panel: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  Group: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  useDefaultLayout: (options: { id: string; panelIds: string[] }) => {
    controls.layouts.push(options);
    return { defaultLayout: {}, onLayoutChanged: vi.fn() };
  },
}));
import { MailPanels } from "./components/MailPanels";
afterAll(() => {
  vi.doUnmock("react-resizable-panels");
  vi.resetModules();
});
it("hidden reading panes use a full-width list layout, separate from both saved split layouts", () => {
  const dom = testDom();
  vi.stubGlobal("localStorage", {});
  controls.layouts.length = 0;
  try {
    for (const [position, readerVisible] of [
      ["right", true],
      ["right", false],
      ["bottom", true],
    ] as const) {
      dom.render(
        createElement(
          MailPanels,
          {
            position,
            readerVisible,
          },
          createElement("p", null, "Messages"),
        ),
      );
    }
    expect(controls.layouts.map((p) => [p.id, p.panelIds])).toEqual([
      ["openmail:mail-panes:right", ["list", "reader"]],
      ["openmail:mail-panes:right:list", ["list"]],
      ["openmail:mail-panes:bottom", ["list", "reader"]],
    ]);
  } finally {
    dom.dispose();
  }
});

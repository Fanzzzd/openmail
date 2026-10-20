import { act, createElement, useEffect, useState, type ReactNode } from "react";
import { afterAll, expect, it, vi } from "vitest";
import { testDom } from "../test-support/test-dom";

const controls = vi.hoisted(() => {
  vi.resetModules();
  return {
    groups: new Array<{
      onLayoutChanged: (
        layout: Record<string, number>,
        meta: { isUserInteraction: boolean },
      ) => void;
    }>(),
    panels: new Map<
      string,
      {
        defaultSize?: number;
        onResize?: (size: { asPercentage: number; inPixels: number }, id: string) => void;
      }
    >(),
  };
});
vi.mock("react-resizable-panels", () => ({
  usePanelRef: () => ({ current: null }),
  Panel: ({
    children,
    ...props
  }: {
    children: ReactNode;
    id: string;
    defaultSize?: number;
    onResize?: (size: { asPercentage: number; inPixels: number }, id: string) => void;
  }) => {
    controls.panels.set(props.id, props);
    return createElement("div", null, children);
  },
  Group: ({
    children,
    ...props
  }: {
    children: ReactNode;
    onLayoutChanged: (layout: Record<string, number>, meta: { isUserInteraction: boolean }) => void;
  }) => {
    controls.groups.push(props);
    return createElement("div", null, children);
  },
}));
import { MailPanels } from "./MailPanels";
import { SavedPanel } from "./SavedPanes";
afterAll(() => {
  vi.doUnmock("react-resizable-panels");
  vi.resetModules();
});
function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => void items.set(key, value)),
    removeItem: vi.fn((key: string) => void items.delete(key)),
  };
}

it("hidden reading panes use a full-width list layout, separate from both saved split layouts", () => {
  const dom = testDom();
  const storage = memoryStorage();
  const read = vi.spyOn(storage, "getItem");
  vi.stubGlobal("localStorage", storage);
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
            wide: true,
          },
          createElement("p", null, "Messages"),
        ),
      );
    }
    expect(
      read.mock.calls.map(([key]) => key).filter((key) => key.startsWith("openmail:")),
    ).toEqual([
      "openmail:mail-pane-sizes:right",
      "openmail:mail-pane-sizes:right:list",
      "openmail:mail-pane-sizes:bottom",
    ]);
  } finally {
    dom.dispose();
  }
});

it("the list opens at the width the person gave it, whatever the window did since", () => {
  const dom = testDom();
  const storage = memoryStorage();
  vi.stubGlobal("localStorage", storage);
  const panes = (key: number) =>
    createElement(
      MailPanels,
      { key, position: "right", readerVisible: true, wide: true },
      createElement(SavedPanel, { id: "list", defaultSize: 380 }),
    );
  try {
    dom.render(panes(1));
    const list = () => controls.panels.get("list");
    expect(list()?.defaultSize).toBe(380);
    // The list is 356 px of a 1089 px group.
    act(() => list()?.onResize?.({ asPercentage: 32.69, inPixels: 356 }, "list"));
    const group = () => controls.groups.at(-1);
    // A window resize clamps the list to its minimum; that is not saved.
    act(() => group()?.onLayoutChanged({ list: 37.5, reader: 62.5 }, { isUserInteraction: false }));
    expect(storage.setItem).not.toHaveBeenCalled();
    // The person drags it to 400 px.
    act(() =>
      group()?.onLayoutChanged({ list: 36.73, reader: 63.27 }, { isUserInteraction: true }),
    );
    expect(JSON.parse(storage.items.get("openmail:mail-pane-sizes:right") ?? "{}")).toEqual({
      list: 400,
    });
    // The panes remount as the window crosses a breakpoint, and the list opens at 400 px.
    dom.render(panes(2));
    expect(list()?.defaultSize).toBe(400);
  } finally {
    dom.dispose();
  }
});

it("preserves reader/editor state when the zoom breakpoint changes pane orientation", () => {
  const dom = testDom();
  vi.stubGlobal("localStorage", memoryStorage());
  let mounts = 0;
  function ReaderState() {
    const [text, setText] = useState("Original");
    useEffect(() => {
      mounts++;
    }, []);
    return createElement("button", { onClick: () => setText("Unsaved text and selection") }, text);
  }
  const layout = (position: "right" | "bottom") =>
    createElement(
      MailPanels,
      { position, readerVisible: true, wide: true },
      createElement(ReaderState),
    );
  try {
    dom.render(layout("right"));
    const reader = dom.element.querySelector("button");
    if (!reader) throw new Error("Missing reader fixture");
    act(() => reader.click());
    dom.render(layout("bottom"));
    expect(dom.element.querySelector("button")).toBe(reader);
    expect(reader.textContent).toBe("Unsaved text and selection");
    dom.render(layout("right"));
    expect(mounts).toBe(1);
  } finally {
    dom.dispose();
  }
});

it("converts an earlier build's percent widths once, only in the wide layout", () => {
  const dom = testDom();
  const storage = memoryStorage();
  const read = vi.spyOn(storage, "getItem");
  vi.stubGlobal("localStorage", storage);
  const legacy = "react-resizable-panels:openmail:mail-panes:right:list:reader";
  storage.items.set(legacy, JSON.stringify({ list: 32.69, reader: 67.31 }));
  const panes = (key: number, wide: boolean) =>
    createElement(
      MailPanels,
      { key, position: "right", readerVisible: true, wide },
      createElement(SavedPanel, { id: "list", defaultSize: 380 }),
    );
  const list = () => controls.panels.get("list");
  try {
    // A medium window clamps the panes: the old layout is neither read nor converted.
    dom.render(panes(1, false));
    act(() => list()?.onResize?.({ asPercentage: 37.5, inPixels: 300 }, "list"));
    expect(read.mock.calls.map(([key]) => key)).not.toContain(legacy);
    expect(storage.items.has(legacy)).toBe(true);
    expect(storage.items.has("openmail:mail-pane-sizes:right")).toBe(false);
    // Wide, the list's 32.69 % of the 1089 px group becomes 356 px, and the old key goes.
    dom.render(panes(2, true));
    expect(list()?.defaultSize).toBe(380);
    act(() => list()?.onResize?.({ asPercentage: 34.89, inPixels: 380 }, "list"));
    expect(JSON.parse(storage.items.get("openmail:mail-pane-sizes:right") ?? "{}")).toEqual({
      list: 356,
    });
    expect(storage.items.has(legacy)).toBe(false);
    // The next mount opens at the converted width and does not look for the old key again.
    read.mockClear();
    dom.render(panes(3, true));
    expect(list()?.defaultSize).toBe(356);
    act(() => list()?.onResize?.({ asPercentage: 32.69, inPixels: 356 }, "list"));
    expect(read.mock.calls.map(([key]) => key)).toEqual(["openmail:mail-pane-sizes:right"]);
  } finally {
    dom.dispose();
  }
});

import {
  act,
  createContext,
  createElement,
  createRef,
  useContext,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { afterAll, expect, it, vi } from "vitest";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { AsyncResult } from "effect/reactivity";
import { parseSearchQuery, quoteSearchValue } from "@openmail/core/schema";
import { testDom } from "./test-dom";

const controls = vi.hoisted(() => {
  // Low-memory runs reuse the worker. Do not retain another file's widget imports.
  vi.resetModules();
  const type: (text: string) => void = vi.fn();
  const pick: (token: string) => void = vi.fn();
  const items: string[] = [];
  const groups: { value: string; items: string[] }[] = [];
  return {
    type,
    pick,
    items,
    groups,
    open: false,
    text: "",
    contactLookup: vi.fn(),
    labelScope: vi.fn(),
    accountIds: ["gmail:one"],
  };
});
// The widget shell is stubbed; test the real search field's callbacks and state without a browser.
vi.mock("@base-ui/react/combobox", () => {
  const wrap = ({ children }: { children: ReactNode }) => createElement("div", null, children);
  const GroupItems = createContext<string[]>([]);
  return {
    Combobox: {
      Root: (props: {
        children: ReactNode;
        items: { value: string; items: string[] }[];
        open: boolean;
        value: string[];
        inputValue: string;
        onInputValueChange: (next: string, details: { reason: string }) => void;
        onValueChange: (next: string[], details: { reason: string }) => void;
      }) => {
        controls.groups = props.items;
        controls.items = props.items.flatMap((group) => group.items);
        controls.open = props.open;
        controls.text = props.inputValue;
        controls.type = (next) => props.onInputValueChange(next, { reason: "input-change" });
        controls.pick = (token) =>
          props.onValueChange([...props.value, token], { reason: "item-press" });
        return createElement("div", null, props.children);
      },
      Chips: wrap,
      Chip: wrap,
      Portal: wrap,
      Positioner: wrap,
      Popup: wrap,
      ChipRemove: ({ children, ...props }: ComponentProps<"button">) =>
        createElement("button", props, children),
      Input: (props: ComponentProps<"input">) =>
        createElement("input", { ...props, value: controls.text, readOnly: true }),
      List: ({
        children,
      }: {
        children: (group: { value: string; items: string[] }) => ReactNode;
      }) => createElement("div", null, controls.groups.map(children)),
      Group: ({ children, items }: { children: ReactNode; items: string[] }) =>
        createElement(GroupItems, { value: items }, createElement("div", null, children)),
      GroupLabel: ({ children }: { children: ReactNode }) => createElement("h3", null, children),
      Collection: ({ children }: { children: (item: string) => ReactNode }) =>
        createElement("div", null, useContext(GroupItems).map(children)),
      Empty: ({ children }: { children: ReactNode }) =>
        controls.items.length ? null : createElement("p", null, children),
      Item: ({
        children,
        value,
        ...props
      }: {
        children: ReactNode;
        value: string;
        "aria-describedby"?: string;
      }) =>
        createElement(
          "button",
          {
            "data-key": value,
            "aria-describedby": props["aria-describedby"],
            onClick: () => controls.pick(value),
          },
          children,
        ),
    },
  };
});
vi.mock("@effect/atom-react", () => ({
  useAtom: () => ["all", vi.fn()],
  useAtomValue: (atom: string) => {
    if (atom === "listQuery") return { accountIds: controls.accountIds };
    if (atom === "labels")
      return AsyncResult.success([{ id: "work", name: 'Work "private"', accountId: "gmail:one" }]);
    if (atom === "contacts")
      return AsyncResult.success([{ name: 'Alice "A"', address: "alice+reports@example.com" }]);
    return AsyncResult.success([]);
  },
}));
vi.mock("./state/queries", () => ({
  suggestionsAtom: (query: string, from: string | undefined, accountIds?: readonly string[]) => {
    controls.contactLookup(query, from, accountIds);
    return "contacts";
  },
  labelsAtom: (scope: readonly string[]) => {
    controls.labelScope(scope);
    return "labels";
  },
}));
vi.mock("./state/threads", () => ({ listQueryAtom: "listQuery" }));
vi.mock("./state/mail", () => ({ useRunMail: () => vi.fn(), withMail: vi.fn() }));
vi.mock("./state/ui", () => ({ searchScopeAtom: "scope" }));
vi.mock("./components/ui/Select", () => ({ Select: () => null }));
vi.mock("./components/ui/Menu", () => ({
  DropdownMenu: ({ trigger, children }: { trigger: ReactNode; children: ReactNode }) =>
    createElement("div", null, trigger, children),
  MenuItem: ({ children, onClick }: { children: ReactNode; onClick: () => void }) =>
    createElement("button", { onClick }, children),
  MenuSeparator: () => null,
}));
import { SearchField } from "./components/ui/SearchField";
import { recentSearches } from "./recent-searches";

afterAll(() => {
  for (const module of [
    "@base-ui/react/combobox",
    "@effect/atom-react",
    "./state/queries",
    "./state/threads",
    "./state/mail",
    "./state/ui",
    "./components/ui/Select",
    "./components/ui/Menu",
  ])
    vi.doUnmock(module);
  vi.resetModules();
});

const click = (dom: ReturnType<typeof testDom>, label: string) => {
  const button = [...dom.element.querySelectorAll("button")].find(
    (element) => element.textContent === label,
  );
  if (!button) throw new Error(`Missing ${label}`);
  act(() => {
    button.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  });
};

it("typing values, selecting suggestions and modifying/editing chips retains the full query", () => {
  vi.useFakeTimers();
  controls.contactLookup.mockClear();
  const dom = testDom();
  const changed = vi.fn();
  const inputRef = createRef<HTMLInputElement>();
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  const Harness = () => {
    const [value, setValue] = useState("invoice from:ali");
    return createElement(SearchField, {
      value,
      inputRef,
      onChange: (next) => {
        changed(next);
        setValue(next);
      },
    });
  };
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    callback();
    return 1;
  });
  try {
    dom.render(createElement(I18nProvider, { i18n }, createElement(Harness)));
    expect(controls.contactLookup).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(controls.contactLookup).toHaveBeenCalledWith("ali", undefined, ["gmail:one"]);
    expect(controls.labelScope).toHaveBeenCalledWith(["gmail:one"]);
    act(() => controls.pick('from:"alice+reports@example.com"'));
    expect(changed.mock.calls.at(-1)).toEqual(['invoice from:"alice+reports@example.com" ']);
    click(dom, "to:");
    expect(parseSearchQuery({ search: changed.mock.calls.at(-1)?.[0] }).criteria?.to).toBe(
      "alice+reports@example.com",
    );
    click(dom, "Exclude matches");
    expect(
      parseSearchQuery({ search: changed.mock.calls.at(-1)?.[0] }).criteria?.excluded?.[0]?.to,
    ).toBe("alice+reports@example.com");
    click(dom, "Edit token");
    expect(controls.text).toBe('invoice -to:"alice+reports@example.com"');
    expect(inputRef.current).not.toBeNull();
    act(() => controls.type('invoice label:"Work '));
    const folderToken = `label:${quoteSearchValue('Work "private"')}`;
    expect(controls.items).toContain(folderToken);
    act(() => controls.pick(folderToken));
    expect(parseSearchQuery({ search: changed.mock.calls.at(-1)?.[0] }).criteria?.labels).toEqual([
      'Work "private"',
    ]);
    act(() => controls.type("invoice subject:"));
    act(() => controls.type('invoice subject:"annual report" '));
    expect(parseSearchQuery({ search: changed.mock.calls.at(-1)?.[0] }).criteria?.subject).toBe(
      "annual report",
    );
  } finally {
    dom.dispose();
    vi.useRealTimers();
  }
});

it("shows date presets and commits a picked before/after date with the other terms", () => {
  const dom = testDom();
  const changed = vi.fn();
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  const Harness = () => {
    const [value, setValue] = useState("from:alice invoice before:");
    return createElement(SearchField, {
      value,
      inputRef: null,
      onChange: (next) => {
        changed(next);
        setValue(next);
      },
    });
  };
  try {
    dom.render(createElement(I18nProvider, { i18n }, createElement(Harness)));
    expect(dom.element.textContent).toContain("Today");
    expect(dom.element.textContent).toContain("Yesterday");
    expect(dom.element.textContent).toContain("Last 7 days");
    // React's onChange date adapter is covered by selecting its equivalent token.
    expect(
      dom.element.querySelector('input[type="date"][aria-label="Before date"]'),
    ).not.toBeNull();
    act(() => controls.pick("before:2026-10-01"));
    expect(changed.mock.calls.at(-1)).toEqual(["from:alice invoice before:2026-10-01 "]);
    expect(dom.element.querySelector('input[type="date"]')).toBeNull();
    act(() => controls.type("invoice after:"));
    expect(dom.element.querySelector('input[type="date"][aria-label="After date"]')).not.toBeNull();
    click(dom, "Last 7 days");
    const parsed = parseSearchQuery({ search: changed.mock.calls.at(-1)?.[0] });
    expect(parsed.criteria?.dateBefore).toBeDefined();
    expect(parsed.criteria?.dateAfter).toBeDefined();
    expect(parsed.criteria?.from).toBe("alice");
  } finally {
    dom.dispose();
  }
});

it("contact lookup skips empty values, debounces typing and resets when the Profile scope changes", () => {
  vi.useFakeTimers();
  controls.contactLookup.mockClear();
  controls.accountIds = ["gmail:one"];
  const dom = testDom();
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  const Harness = () => {
    const [value, setValue] = useState("from:");
    return createElement(SearchField, { value, inputRef: null, onChange: setValue });
  };
  const render = () => dom.render(createElement(I18nProvider, { i18n }, createElement(Harness)));
  try {
    render();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(controls.contactLookup).not.toHaveBeenCalled();
    act(() => controls.type("from:a"));
    act(() => {
      vi.advanceTimersByTime(100);
      controls.type("from:al");
    });
    act(() => {
      vi.advanceTimersByTime(100);
      controls.type("from:ali");
    });
    expect(controls.contactLookup).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(controls.contactLookup).toHaveBeenCalledTimes(1);
    expect(controls.contactLookup).toHaveBeenLastCalledWith("ali", undefined, ["gmail:one"]);
    controls.contactLookup.mockClear();
    controls.accountIds = ["outlook:two"];
    render();
    expect(controls.contactLookup).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(controls.contactLookup).toHaveBeenLastCalledWith("ali", undefined, ["outlook:two"]);
    controls.contactLookup.mockClear();
    act(() => controls.type("from:"));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(controls.contactLookup).not.toHaveBeenCalled();
  } finally {
    dom.dispose();
    vi.useRealTimers();
    controls.accountIds = ["gmail:one"];
  }
});

it("the date picker waits for blur or Enter and never commits a partial or pre-1970 year", () => {
  const dom = testDom();
  const changed = vi.fn();
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  const Harness = () => {
    const [value, setValue] = useState("from:alice invoice before:");
    return createElement(SearchField, {
      value,
      inputRef: null,
      onChange: (next) => {
        changed(next);
        setValue(next);
      },
    });
  };
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    callback();
    return 1;
  });
  const picker = () => {
    const input = dom.element.querySelector<HTMLInputElement>('input[type="date"]');
    if (!input) throw new Error("Missing date input");
    return input;
  };
  const emit = (type: string, key?: string) => {
    const input = picker();
    const event = new dom.window.Event(type, { bubbles: true });
    if (key) Object.assign(event, { key });
    if (type === "keydown") {
      // Linkedom uses React's legacy input polyfill, which needs focus bookkeeping.
      Object.defineProperty(input, "attachEvent", { configurable: true, value: vi.fn() });
      Object.defineProperty(input, "detachEvent", { configurable: true, value: vi.fn() });
      act(() => {
        input.dispatchEvent(new dom.window.Event("focusin", { bubbles: true }));
      });
    }
    act(() => {
      input.dispatchEvent(event);
    });
  };
  try {
    dom.render(createElement(I18nProvider, { i18n }, createElement(Harness)));
    picker().value = "0002-10-02";
    emit("input");
    emit("keydown", "Enter");
    emit("focusout");
    expect(changed).not.toHaveBeenCalled();
    picker().value = "1969-10-02";
    emit("focusout");
    expect(changed).not.toHaveBeenCalled();
    picker().value = "2026-10-02";
    emit("input");
    expect(changed).not.toHaveBeenCalled();
    emit("keydown", "Enter");
    expect(changed).toHaveBeenLastCalledWith("from:alice invoice before:2026-10-02 ");
    act(() => controls.type("invoice after:"));
    picker().value = "1970-01-01";
    emit("focusout");
    expect(changed).toHaveBeenLastCalledWith(
      "from:alice before:2026-10-02 invoice after:1970-01-01 ",
    );
  } finally {
    dom.dispose();
  }
});

const renderField = (dom: ReturnType<typeof testDom>, initial: string) => {
  const changed = vi.fn();
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  const Harness = () => {
    const [value, setValue] = useState(initial);
    return createElement(SearchField, {
      value,
      inputRef: null,
      onChange: (next) => {
        changed(next);
        setValue(next);
      },
    });
  };
  dom.render(createElement(I18nProvider, { i18n }, createElement(Harness)));
  return changed;
};
const headings = (dom: ReturnType<typeof testDom>) =>
  [...dom.element.querySelectorAll("h3")].map((element) => element.textContent);

it("an empty field offers recent searches only, or one hint and search help", () => {
  const dom = testDom();
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  try {
    const changed = renderField(dom, "");
    expect(controls.items).toEqual([]);
    expect(dom.element.textContent).toContain("Try from:name or has:attachment");
    expect(dom.element.textContent).toContain("Search help");
    act(() => {
      recentSearches.add("quarterly report");
      recentSearches.add("from:alice invoice");
    });
    expect(headings(dom)).toEqual(["Recent"]);
    expect(dom.element.textContent).not.toContain("Try from:name");
    expect(dom.element.textContent).not.toContain("has:attachment");
    const recent = controls.items.find((key) => key.endsWith("quarterly report"));
    expect(
      dom.element.querySelector(`[data-key="${recent}"]`)?.getAttribute("aria-describedby"),
    ).toBeTruthy();
    act(() => controls.pick(recent ?? ""));
    expect(changed).toHaveBeenLastCalledWith("quarterly report ");
    expect(JSON.parse(values.get("openmail.recentSearches") ?? "[]")).toEqual([
      "quarterly report",
      "from:alice invoice",
    ]);
    act(() => controls.type(""));
    click(dom, "Clear recent searches");
    expect(values.has("openmail.recentSearches")).toBe(false);
  } finally {
    dom.dispose();
  }
});

it("typing a filter name offers those filters with what they do", () => {
  const dom = testDom();
  try {
    renderField(dom, "invoice");
    expect(controls.items).toEqual([]);
    act(() => controls.type("has"));
    expect(headings(dom)[0]).toBe("Filters");
    expect(dom.element.textContent).toContain("Messages with a PDF attachment");
    act(() => controls.type("has:p"));
    act(() => controls.pick("has:pdf"));
    expect(controls.text).toBe("");
  } finally {
    dom.dispose();
  }
});

it("a typed name of three or more letters offers people as from: and to:", () => {
  vi.useFakeTimers();
  controls.contactLookup.mockClear();
  const dom = testDom();
  try {
    const changed = renderField(dom, "invoice al");
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(controls.contactLookup).not.toHaveBeenCalled();
    act(() => controls.type("invoice ali"));
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(controls.contactLookup).toHaveBeenLastCalledWith("ali", undefined, ["gmail:one"]);
    expect(controls.items).toEqual([
      'from:"alice+reports@example.com"',
      'to:"alice+reports@example.com"',
    ]);
    expect(headings(dom)).toEqual(["People"]);
    act(() => controls.pick('to:"alice+reports@example.com"'));
    expect(parseSearchQuery({ search: changed.mock.calls.at(-1)?.[0] }).criteria?.to).toBe(
      "alice+reports@example.com",
    );
  } finally {
    dom.dispose();
    vi.useRealTimers();
  }
});

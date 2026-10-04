import { constVoid } from "effect/Function";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, screen, within } from "@testing-library/react/pure";
import { railTrafficLightInset, trafficLightInset } from "../components/ui/styles";
import { clickButton, eventually, flow, key, row } from "./harness";

let current: Awaited<ReturnType<typeof flow>> | undefined;
let width = 1200;
const resized = new Set<() => void>();
const setupMatchMedia = window.matchMedia;
const setupInnerWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
beforeEach(() => {
  window.matchMedia = (query: string) =>
    Object.assign(setupMatchMedia(query), {
      addEventListener: (_name: string, listener: () => void) => resized.add(listener),
      removeEventListener: (_name: string, listener: () => void) => resized.delete(listener),
    });
  Object.defineProperty(window, "innerWidth", { configurable: true, get: () => width });
});
afterEach(async () => {
  await current?.dispose();
  current = undefined;
  window.matchMedia = setupMatchMedia;
  if (setupInnerWidth) Object.defineProperty(window, "innerWidth", setupInnerWidth);
  resized.clear();
});

const resize = (next: number) => {
  width = next;
  act(() => {
    for (const listener of resized) listener();
  });
};

const reader = () => screen.queryByRole("article", { name: "Selected message" });
const rail = () => document.querySelector<HTMLElement>("[data-sidebar-rail]");

it("a narrow window shows the list or the reader, and goes back with the button, Escape and Cmd+[", async () => {
  width = 520;
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  // The list carries the search field and there is no reader yet.
  expect(screen.getByRole("combobox", { name: "Search mail" })).toBeTruthy();
  expect(reader()).toBeNull();
  expect(document.querySelector('[data-mail-pane="sidebar"]')).toBeNull();
  expect(rail()).toBeNull();

  const open = async () => {
    fireEvent.click(row(h.id("one")));
    await eventually(() => expect(reader()?.textContent).toContain("Original one"));
    expect(row(h.id("one")).closest("[hidden]")).not.toBeNull();
    expect(document.querySelector('[data-mail-pane="list"]')).toBeNull();
    // The clicked row is hidden now, so focus moves to the reader.
    await eventually(() =>
      expect(document.activeElement?.getAttribute("data-mail-pane")).toBe("reader"),
    );
  };
  const backAt = async () => {
    await eventually(() => expect(reader()).toBeNull());
    expect(row(h.id("one")).closest("[hidden]")).toBeNull();
    expect(row(h.id("one")).getAttribute("aria-selected")).toBe("true");
    await eventually(() => expect(document.activeElement).toBe(row(h.id("one"))));
  };

  await open();
  clickButton("Back to messages");
  await backAt();
  await open();
  key("Escape", {}, document.body);
  await backAt();
  await open();
  key("[", { metaKey: true }, document.body);
  await backAt();
  // Arrow keys move the selection without leaving the list.
  key("ArrowDown");
  await eventually(() => expect(row(h.id("two")).getAttribute("aria-selected")).toBe("true"));
  expect(reader()).toBeNull();
});

it("the sidebar opens as a drawer below 960 px and closes when a mailbox is picked", async () => {
  width = 800;
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  // Only the rail is docked; the full sidebar lives in the drawer.
  expect(document.querySelector('[data-mail-pane="sidebar"]')).toBe(rail());
  expect(document.querySelector('[data-mail-pane="reader"]')).not.toBeNull();

  const toggle = within(rail()!).getByRole("button", { name: "Show sidebar" });
  toggle.focus();
  fireEvent.click(toggle);
  const drawer = await screen.findByRole("dialog", { name: "Sidebar" });
  expect(within(drawer).getByRole("navigation", { name: "Mailboxes" })).toBeTruthy();
  // Focus starts on the open mailbox.
  await eventually(() => expect(document.activeElement?.textContent).toMatch(/^Inbox/));
  expect(document.activeElement?.getAttribute("aria-current")).toBe("page");
  key("Escape");
  await eventually(() => expect(screen.queryByRole("dialog", { name: "Sidebar" })).toBeNull());
  await eventually(() => expect(document.activeElement).toBe(toggle));

  fireEvent.click(toggle);
  const reopened = await screen.findByRole("dialog", { name: "Sidebar" });
  fireEvent.click(within(reopened).getByRole("button", { name: /^Starred/ }));
  await eventually(() => expect(screen.queryByRole("dialog", { name: "Sidebar" })).toBeNull());
  await eventually(() =>
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Starred"),
  );
  // Focus goes to the new list, not back to the toggle.
  await eventually(() =>
    expect(document.activeElement?.closest('[data-mail-pane="list"]')).not.toBeNull(),
  );
});

it("crossing a breakpoint keeps the list and reader mounted and closes the drawer", async () => {
  width = 800;
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  const firstRow = row(h.id("one"));
  fireEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
  await screen.findByRole("dialog", { name: "Sidebar" });

  resize(520);
  await eventually(() => expect(screen.queryByRole("dialog", { name: "Sidebar" })).toBeNull());
  expect(row(h.id("one"))).toBe(firstRow);
  resize(800);
  expect(screen.queryByRole("dialog", { name: "Sidebar" })).toBeNull();
  expect(row(h.id("one"))).toBe(firstRow);

  fireEvent.click(firstRow);
  await eventually(() => expect(reader()?.textContent).toContain("Original one"));
  const article = reader();
  resize(520);
  // The row was opened, so the narrow window shows the same reader.
  expect(reader()).toBe(article);
  resize(1200);
  expect(reader()).toBe(article);
  expect(row(h.id("one"))).toBe(firstRow);
});

it("a wide window docks the sidebar and has no drawer toggle", async () => {
  width = 1200;
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  expect(document.querySelector('[data-mail-pane="sidebar"]')).not.toBeNull();
  expect(screen.queryByRole("button", { name: "Show sidebar" })).toBeNull();
  expect(rail()).toBeNull();
});

it("a medium window docks an icon rail whose mailboxes and spaces hand focus to the list", async () => {
  width = 800;
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  const strip = rail();
  if (!strip) throw new Error("Missing sidebar rail");
  // The rail holds the only drawer toggle, and the list header clears the traffic lights beside it.
  expect(screen.getAllByRole("button", { name: "Show sidebar" })).toEqual([
    within(strip).getByRole("button", { name: "Show sidebar" }),
  ]);
  const list = document.querySelector('[data-mail-pane="list"]');
  expect(list?.querySelector("header")?.className).toContain(railTrafficLightInset);

  // Icons are named by their mailbox and unread count; the open one is current.
  const mailboxes = within(strip).getByRole("navigation", { name: "Mailboxes" });
  const inbox = await within(mailboxes).findByRole("button", { name: "Inbox 2" });
  expect(inbox.getAttribute("aria-current")).toBe("page");
  expect(inbox.textContent).toContain("2");
  expect(within(mailboxes).getByRole("button", { name: "Drafts" })).toBeTruthy();

  fireEvent.click(within(mailboxes).getByRole("button", { name: "Starred" }));
  await eventually(() =>
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Starred"),
  );
  expect(
    within(mailboxes).getByRole("button", { name: "Starred" }).getAttribute("aria-current"),
  ).toBe("page");
  expect(inbox.getAttribute("aria-current")).toBeNull();
  await eventually(() =>
    expect(document.activeElement?.closest('[data-mail-pane="list"]')).not.toBeNull(),
  );

  const spaces = within(strip).getByRole("group", { name: "Spaces" });
  fireEvent.click(within(spaces).getByRole("button", { name: "Overview" }));
  await eventually(() =>
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Overview"),
  );
  expect(
    within(spaces).getByRole("button", { name: "Overview" }).getAttribute("aria-current"),
  ).toBe("true");
  // Picking a mailbox from the overview opens it in All accounts.
  fireEvent.click(within(mailboxes).getByRole("button", { name: "Inbox 2" }));
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  expect(
    within(spaces)
      .getByRole("button", { name: /^All accounts/ })
      .getAttribute("aria-current"),
  ).toBe("true");
  await eventually(() =>
    expect(document.activeElement?.closest('[data-mail-pane="list"]')).not.toBeNull(),
  );

  // The full sidebar replaces the rail when wide; a narrow window has neither.
  resize(1200);
  expect(rail()).toBeNull();
  expect(document.querySelector('[data-mail-pane="sidebar"] aside')).not.toBeNull();
  resize(600);
  expect(rail()).toBeNull();
  expect(document.querySelector('[data-mail-pane="sidebar"]')).toBeNull();
  // The list header has the drawer toggle again.
  expect(
    screen.getByRole("button", { name: "Show sidebar" }).closest("[data-sidebar-rail]"),
  ).toBeNull();
});

/**
 * jsdom has no layout: the actions toolbar is `width` px wide, icon buttons
 * are 28 px and a text button 7 px per character. Resizing notifies observers.
 */
function toolbarLayout() {
  let width = 0;
  const observers = new Set<() => void>();
  const SetupObserver = globalThis.ResizeObserver;
  const clientWidth = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth");
  const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
  vi.stubGlobal(
    "ResizeObserver",
    class {
      changed: () => void;
      constructor(callback: () => void) {
        this.changed = callback;
      }
      // Only the actions toolbar resizes here; popups observe other elements.
      observe(target: Element) {
        if (target.getAttribute("role") === "toolbar") observers.add(this.changed);
      }
      unobserve = constVoid;
      disconnect() {
        observers.delete(this.changed);
      }
    },
  );
  Object.defineProperty(Element.prototype, "clientWidth", {
    configurable: true,
    get(this: Element) {
      return this.getAttribute("aria-label") === "Conversation actions" &&
        this.getAttribute("role") === "toolbar"
        ? width
        : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      if (!this.dataset.toolbarAction) return 0;
      const text = this.textContent;
      return text ? text.length * 7 + 12 : 28;
    },
  });
  return {
    resize: (next: number) => {
      width = next;
      act(() => {
        for (const changed of observers) changed();
      });
    },
    restore: () => {
      vi.stubGlobal("ResizeObserver", SetupObserver);
      if (clientWidth) Object.defineProperty(Element.prototype, "clientWidth", clientWidth);
      if (offsetWidth) Object.defineProperty(HTMLElement.prototype, "offsetWidth", offsetWidth);
    },
  };
}
let toolbar: ReturnType<typeof toolbarLayout> | undefined;
afterEach(() => {
  toolbar?.restore();
  toolbar = undefined;
});
const shown = () =>
  [...document.querySelectorAll<HTMLElement>("[data-toolbar-action]")].map(
    (action) => action.dataset.toolbarAction,
  );

it("the thread window folds actions into the actions menu as it narrows and keeps their shortcuts", async () => {
  const layout = toolbarLayout();
  toolbar = layout;
  const resizeToolbar = layout.resize;
  current = await flow({ thread: "one" });
  const h = current;
  await screen.findByRole("button", { name: "Archive" });
  const header = document.querySelector("[data-thread-toolbar]");
  expect(header?.className).toContain("drag");
  expect(header?.className).toContain(trafficLightInset);
  const all = shown();
  expect(all).toEqual(["archive", "trash", "spam", "read", "star", "important", "move", "label"]);

  // 4 buttons of 30 px and the 28 px menu button fit in 150 px; a fifth would not.
  resizeToolbar(150);
  expect(shown()).toEqual(["archive", "trash", "spam", "read"]);
  expect(screen.queryByRole("button", { name: "Star" })).toBeNull();
  const menu = screen.getByRole("button", { name: "Conversation actions" });
  expect(menu.closest('[role="toolbar"]')).not.toBeNull();
  fireEvent.click(menu);
  expect(await screen.findByRole("menuitem", { name: /^Star/ })).toBeTruthy();
  key("Escape");
  await eventually(() => expect(screen.queryByRole("menuitem", { name: /^Star/ })).toBeNull());

  // Folded actions keep their shortcuts; the label picker takes the last button's place.
  key("l", { metaKey: true }, document.body);
  await screen.findByRole("combobox", { name: "Labels" });
  expect(shown()).toEqual(["archive", "trash", "spam", "label"]);
  key("Escape");
  await eventually(() => expect(screen.queryByRole("combobox", { name: "Labels" })).toBeNull());
  expect(shown()).toEqual(["archive", "trash", "spam", "read"]);
  key("l", { metaKey: true, shiftKey: true }, document.body);
  await eventually(() =>
    expect(
      h.requests.some(
        (request) => request.tag === "Modify" && JSON.stringify(request.payload).includes('"star"'),
      ),
    ).toBe(true),
  );

  // Only the menu button fits in 40 px; widening brings every action back.
  resizeToolbar(40);
  expect(shown()).toEqual([]);
  expect(screen.getByRole("button", { name: "Conversation actions" })).toBeTruthy();
  resizeToolbar(400);
  expect(shown()).toEqual(all);
});

it("the thread window opens IMAP's copy form in a popover that stays open while the toolbar fits", async () => {
  const layout = toolbarLayout();
  toolbar = layout;
  current = await flow({ provider: "imap", thread: "one" });
  const h = current;
  await screen.findByRole("button", { name: "Archive" });
  layout.resize(400);
  expect(shown()).toEqual(["archive", "trash", "spam", "read", "star", "move", "label"]);

  fireEvent.click(screen.getByRole("button", { name: "Copy to folders…" }));
  const form = await screen.findByRole("dialog", { name: "Copy to folders…" });
  // The form is outside the toolbar, so the button keeps its width and stays shown.
  expect(form.closest('[role="toolbar"]')).toBeNull();
  layout.resize(401);
  expect(shown()).toContain("label");
  expect(screen.getByRole("dialog", { name: "Copy to folders…" })).toBe(form);

  fireEvent.click(within(form).getByRole("checkbox", { name: "Work" }));
  fireEvent.click(within(form).getByRole("button", { name: "Copy" }));
  await eventually(() =>
    expect(
      h.requests.some(
        (request) => request.tag === "Modify" && JSON.stringify(request.payload).includes('"copy"'),
      ),
    ).toBe(true),
  );
  await eventually(() =>
    expect(screen.queryByRole("dialog", { name: "Copy to folders…" })).toBeNull(),
  );
});

it("an open picker joins the toolbar without hiding actions that have room", async () => {
  const layout = toolbarLayout();
  toolbar = layout;
  current = await flow({ thread: "one", prefs: { toolbarActions: ["archive", "trash", "star"] } });
  await screen.findByRole("button", { name: "Archive" });
  layout.resize(400);
  expect(shown()).toEqual(["archive", "trash", "star"]);
  key("l", { metaKey: true }, document.body);
  await screen.findByRole("combobox", { name: "Labels" });
  expect(shown()).toEqual(["archive", "trash", "star", "label"]);
  key("Escape");
  await eventually(() => expect(shown()).toEqual(["archive", "trash", "star"]));
});

it("a narrow window shows dialogs as full-window sheets with a close button", async () => {
  width = 520;
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  key(",", { metaKey: true }, document.body);
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  expect(settings.className).toContain("max-sm:inset-0");
  expect(within(settings).getByRole("tablist").getAttribute("data-orientation")).toBe("horizontal");
  fireEvent.click(within(settings).getByRole("button", { name: "Close" }));
  await eventually(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull());
});

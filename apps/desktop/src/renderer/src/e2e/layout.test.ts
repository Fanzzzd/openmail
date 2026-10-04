import { afterEach, beforeEach, expect, it } from "vitest";
import { act, fireEvent, screen, within } from "@testing-library/react/pure";
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

it("a narrow window shows the list or the reader, and goes back with the button, Escape and Cmd+[", async () => {
  width = 520;
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  // The list carries the search field and there is no reader yet.
  expect(screen.getByRole("combobox", { name: "Search mail" })).toBeTruthy();
  expect(reader()).toBeNull();
  expect(document.querySelector('[data-mail-pane="sidebar"]')).toBeNull();

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
  expect(document.querySelector('[data-mail-pane="sidebar"]')).toBeNull();
  expect(document.querySelector('[data-mail-pane="reader"]')).not.toBeNull();

  const toggle = screen.getByRole("button", { name: "Show sidebar" });
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

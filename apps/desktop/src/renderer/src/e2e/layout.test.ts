import { afterEach, beforeEach, expect, it } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react/pure";
import { clickButton, eventually, flow, key, row } from "./harness";

let current: Awaited<ReturnType<typeof flow>> | undefined;
let width = 1200;
const setupMatchMedia = window.matchMedia;
beforeEach(() => {
  window.matchMedia = (query: string) => {
    const list = setupMatchMedia(query);
    const below = Number(/width < (\d+)px/.exec(query)?.[1] ?? 0);
    Object.defineProperty(list, "matches", { value: width < below });
    return list;
  };
});
afterEach(async () => {
  await current?.dispose();
  current = undefined;
  window.matchMedia = setupMatchMedia;
});

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

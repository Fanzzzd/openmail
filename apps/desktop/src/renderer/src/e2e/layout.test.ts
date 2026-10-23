import { constVoid } from "effect/Function";
import { AuthError, ProviderError } from "@openmail/core/portable";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { act, fireEvent, screen, within } from "@testing-library/react/pure";
import axe from "axe-core";
import { clickButton, eventually, flow, incoming, key, row, wait } from "./harness";
import { mailHref } from "../../../shared/routes";

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

const reader = () => screen.queryByRole("article", { name: /^Selected message/ });

/**
 * jsdom has no layout: puts a 52 px header row at `left`, `top` in the
 * window and returns the width its TrafficLightSpace measures against the
 * stubbed overlay (e2e/setup.ts): the lights fill the top 52 px up to x = 96.
 */
function lightSpaceAt(row: Element | null | undefined, left: number, top = 0) {
  if (!row) throw new Error("Missing header row");
  for (const [name, value] of Object.entries({
    offsetLeft: left,
    offsetTop: top,
    offsetHeight: 52,
  }))
    Object.defineProperty(row, name, { configurable: true, value });
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
  const space = row.querySelector<HTMLElement>(":scope > [data-traffic-light-space]");
  return space?.hidden ? 0 : Number(space?.dataset.trafficLightSpace);
}
const rail = () => document.querySelector<HTMLElement>("[data-sidebar-rail]");

it("typing in a narrow window's search keeps the field and its focus while results replace the list", async () => {
  width = 569;
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  const field = screen.getByRole<HTMLInputElement>("combobox", { name: "Search mail" });
  field.focus();
  // One letter waits for a second; the results replace the list at "Lu".
  fireEvent.change(field, { target: { value: "Lu" } });
  await eventually(() =>
    expect(screen.getByRole("heading", { name: "Search results" })).toBeTruthy(),
  );
  expect(field.isConnected).toBe(true);
  expect(document.activeElement).toBe(field);
  fireEvent.change(field, { target: { value: "Lun" } });
  await eventually(() => expect(field.value).toBe("Lun"));
  expect(document.activeElement).toBe(field);
});

it("a narrow window shows the list or the reader, and goes back with the button, Escape and Cmd+[", async () => {
  width = 520;
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  // The list carries the search field and there is no reader yet.
  const search = screen.getByRole("combobox", { name: "Search mail" });
  expect(reader()).toBeNull();
  // The search row is the top row and clears the traffic lights; the title row below needs no room.
  const searchRow = search.closest("section > .drag");
  expect(lightSpaceAt(searchRow, 0)).toBe(96);
  expect(lightSpaceAt(searchRow?.nextElementSibling, 0, 52)).toBe(0);
  // After each resize step Electron reports the lights 9 px left for one frame. The search
  // field and the sidebar toggle stay where they are.
  const overlay = navigator.windowControlsOverlay;
  if (!overlay) throw new Error("Missing overlay stub");
  const settled = Object.getOwnPropertyDescriptor(overlay, "getTitlebarAreaRect");
  if (!settled) throw new Error("Missing overlay stub rect");
  Object.defineProperty(overlay, "getTitlebarAreaRect", {
    configurable: true,
    value: () => DOMRect.fromRect({ x: 87, y: 0, width: 913, height: 52 }),
  });
  try {
    expect(lightSpaceAt(searchRow, 0)).toBe(96);
  } finally {
    Object.defineProperty(overlay, "getTitlebarAreaRect", settled);
  }
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
    // The pane fills the window, so its focus ring is drawn inside.
    expect(document.activeElement?.classList.contains("focus-visible:-outline-offset-2")).toBe(
      true,
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

it("Back from a narrow reader selects and focuses the conversation it opened, by click or by Enter", async () => {
  width = 520;
  current = await flow({ windowHistory: true });
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  const selected = (id: string) => row(h.id(id)).getAttribute("aria-selected") === "true";
  const backTo = async (id: string, other: string) => {
    await eventually(() => expect(reader()).toBeNull());
    await eventually(() => expect(document.activeElement).toBe(row(h.id(id))));
    expect(selected(id)).toBe(true);
    expect(selected(other)).toBe(false);
    expect(decodeURIComponent(window.location.hash)).toContain(`thread=${h.id(id)}`);
  };
  // Select one with the keyboard, then open two with a click in the same moment the
  // selection moves: its route write and the reader's entry land in one tick.
  row(h.id("one")).focus();
  key("ArrowUp");
  await eventually(() => expect(selected("one")).toBe(true));
  fireEvent.click(row(h.id("two")));
  await eventually(() => expect(reader()?.textContent).toContain("Original two"));
  clickButton("Back to messages");
  await backTo("two", "one");
  // The next arrow starts from the conversation that was open.
  key("ArrowUp");
  await eventually(() => expect(selected("one")).toBe(true));
  // An arrow and Enter before the selection's route write settles.
  key("ArrowDown");
  await eventually(() => expect(document.activeElement).toBe(row(h.id("two"))));
  // Enter on the focused row button: jsdom sends no click for it, the browser does.
  key("Enter");
  fireEvent.click(row(h.id("two")), { detail: 0 });
  await eventually(() => expect(reader()?.textContent).toContain("Original two"));
  key("Escape", {}, document.body);
  await backTo("two", "one");
});

it("Back from a narrow reader lands on the conversation picked while the window was wide", async () => {
  width = 520;
  current = await flow({
    windowHistory: true,
    messages: [incoming("one"), incoming("two"), incoming("three", { date: Date.now() - 3000 })],
  });
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  const selected = (id: string) => row(h.id(id)).getAttribute("aria-selected") === "true";
  fireEvent.click(row(h.id("one")));
  await eventually(() => expect(reader()?.textContent).toContain("Original one"));
  // The next conversation moves the reader's entry on, so widening leaves that entry in place.
  key("ArrowDown", {}, document.body);
  await eventually(() => expect(reader()?.textContent).toContain("Original two"));
  resize(1200);
  // Wide, a click selects without a new entry; narrow again, the reader shows that pick.
  fireEvent.click(row(h.id("three")));
  await eventually(() => expect(reader()?.textContent).toContain("Original three"));
  resize(520);
  await eventually(() => expect(document.querySelector('[data-mail-pane="list"]')).toBeNull());
  expect(reader()?.textContent).toContain("Original three");
  key("Escape", {}, document.body);
  await eventually(() => expect(reader()).toBeNull());
  await eventually(() => expect(document.activeElement).toBe(row(h.id("three"))));
  // The landing entry is read back a moment later; it must hold the same pick.
  await wait(400);
  expect(selected("three")).toBe(true);
  expect(selected("one")).toBe(false);
  expect(decodeURIComponent(window.location.hash)).toContain(`thread=${h.id("three")}`);
});

it("passing through the narrow layout leaves no Back step that changes nothing", async () => {
  width = 1200;
  current = await flow({ windowHistory: true });
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  const title = () => screen.getByRole("heading", { level: 1 }).textContent;
  const mailboxes = () => screen.getAllByRole("navigation", { name: "Mailboxes" })[0]!;
  fireEvent.click(within(mailboxes()).getByRole("button", { name: "Sent" }));
  await eventually(() => expect(title()).toBe("Sent"));
  fireEvent.click(within(mailboxes()).getByRole("button", { name: /^Inbox/ }));
  await eventually(() => expect(title()).toBe("Inbox"));
  fireEvent.click(row(h.id("one")));
  await eventually(() => expect(reader()?.textContent).toContain("Original one"));
  for (let pass = 0; pass < 3; pass++) {
    resize(520);
    await eventually(() => expect(document.querySelector('[data-mail-pane="list"]')).toBeNull());
    // Widening may step back through history; the next pass starts once that step lands.
    const stepped = new Promise<unknown>((resolve) => {
      window.addEventListener("popstate", resolve, { once: true });
      setTimeout(resolve, 1000);
    });
    resize(1200);
    await eventually(() =>
      expect(document.querySelector('[data-mail-pane="list"]')).not.toBeNull(),
    );
    await act(() => stepped);
  }
  expect(title()).toBe("Inbox");
  // The first Back leaves Inbox for Sent, as it did before the window narrowed.
  key("[", { metaKey: true }, document.body);
  await eventually(() => expect(title()).toBe("Sent"));
  key("]", { metaKey: true }, document.body);
  await eventually(() => expect(title()).toBe("Inbox"));
  expect(decodeURIComponent(window.location.hash)).toContain(`thread=${h.id("one")}`);
});

it("widening after a narrow pick leaves no Back step that changes nothing", async () => {
  width = 1200;
  current = await flow({ windowHistory: true });
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  const title = () => screen.getByRole("heading", { level: 1 }).textContent;
  const mailboxes = () => screen.getAllByRole("navigation", { name: "Mailboxes" })[0]!;
  fireEvent.click(within(mailboxes()).getByRole("button", { name: "Sent" }));
  await eventually(() => expect(title()).toBe("Sent"));
  fireEvent.click(within(mailboxes()).getByRole("button", { name: /^Inbox/ }));
  await eventually(() => expect(title()).toBe("Inbox"));
  resize(520);
  await eventually(() => expect(reader()).toBeNull());
  // The pick pushes the reader's entry, and the reader then writes the message it shows.
  fireEvent.click(row(h.id("one")));
  await eventually(() => expect(reader()?.textContent).toContain("Original one"));
  await eventually(() => expect(decodeURIComponent(window.location.hash)).toContain("message="));
  const stepped = new Promise<unknown>((resolve) => {
    window.addEventListener("popstate", resolve, { once: true });
    setTimeout(resolve, 1000);
  });
  resize(1200);
  await eventually(() => expect(document.querySelector('[data-mail-pane="list"]')).not.toBeNull());
  await act(() => stepped);
  expect(title()).toBe("Inbox");
  key("[", { metaKey: true }, document.body);
  await eventually(() => expect(title()).toBe("Sent"));
});

it("Next view never lands on the reader entry that widening stepped back over", async () => {
  width = 1200;
  current = await flow({ windowHistory: true });
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  const title = () => screen.getByRole("heading", { level: 1 }).textContent;
  const mailboxes = () => screen.getAllByRole("navigation", { name: "Mailboxes" })[0]!;
  fireEvent.click(within(mailboxes()).getByRole("button", { name: "Sent" }));
  await eventually(() => expect(title()).toBe("Sent"));
  fireEvent.click(within(mailboxes()).getByRole("button", { name: /^Inbox/ }));
  await eventually(() => expect(title()).toBe("Inbox"));
  fireEvent.click(row(h.id("one")));
  await eventually(() => expect(reader()?.textContent).toContain("Original one"));
  resize(520);
  await eventually(() => expect(document.querySelector('[data-mail-pane="list"]')).toBeNull());
  const stepped = new Promise<unknown>((resolve) => {
    window.addEventListener("popstate", resolve, { once: true });
    setTimeout(resolve, 1000);
  });
  resize(1200);
  await act(() => stepped);
  const go = (action: "goBack" | "goForward") =>
    h.event({ _tag: "NativeAction", action, triggeredByAccelerator: false });
  await go("goBack");
  await eventually(() => expect(title()).toBe("Sent"));
  await go("goForward");
  await eventually(() => expect(title()).toBe("Inbox"));
  // Nothing is ahead but the reader's old entry: Next view goes back off it.
  await go("goForward");
  await wait(400);
  expect(title()).toBe("Inbox");
  await go("goBack");
  await eventually(() => expect(title()).toBe("Sent"));
});

it("widening keeps focus on the reader or the row that had it", async () => {
  width = 520;
  current = await flow({ windowHistory: true });
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  fireEvent.click(row(h.id("one")));
  await eventually(() =>
    expect(document.activeElement?.getAttribute("data-mail-pane")).toBe("reader"),
  );
  resize(1200);
  await eventually(() => expect(document.querySelector('[data-mail-pane="list"]')).not.toBeNull());
  await eventually(() =>
    expect(document.activeElement?.getAttribute("data-mail-pane")).toBe("reader"),
  );
  // Narrow again with the list shown and a row focused: widening keeps that row.
  resize(520);
  await eventually(() => expect(document.querySelector('[data-mail-pane="list"]')).toBeNull());
  key("Escape", {}, document.body);
  await eventually(() => expect(document.activeElement).toBe(row(h.id("one"))));
  resize(1200);
  await eventually(() => expect(reader()).not.toBeNull());
  await eventually(() => expect(document.activeElement).toBe(row(h.id("one"))));
});

it("crossing 960 px either way keeps focus on the row or the reader that had it", async () => {
  width = 1320;
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  fireEvent.click(row(h.id("one")));
  await eventually(() => expect(reader()?.textContent).toContain("Original one"));
  row(h.id("one")).focus();
  // 919 px docks the rail instead of the sidebar, which moves the list and the reader.
  resize(919);
  await eventually(() => expect(rail()).not.toBeNull());
  await eventually(() => expect(document.activeElement).toBe(row(h.id("one"))));
  resize(1320);
  await eventually(() => expect(rail()).toBeNull());
  await eventually(() => expect(document.activeElement).toBe(row(h.id("one"))));
  // The reader keeps focus the same way.
  document.querySelector<HTMLElement>('[data-mail-pane="reader"]')?.focus();
  resize(919);
  await eventually(() => expect(rail()).not.toBeNull());
  await eventually(() =>
    expect(document.activeElement?.getAttribute("data-mail-pane")).toBe("reader"),
  );
  resize(1320);
  await eventually(() => expect(rail()).toBeNull());
  await eventually(() =>
    expect(document.activeElement?.getAttribute("data-mail-pane")).toBe("reader"),
  );
  // A control in the reader keeps focus itself, not just its pane.
  const bar = await screen.findByRole("group", { name: "Reply to this conversation" });
  const reply = within(bar).getByRole("button", { name: "Reply" });
  reply.focus();
  resize(919);
  await eventually(() => expect(rail()).not.toBeNull());
  await eventually(() => expect(document.activeElement).toBe(reply));
});

// Focus that the person moved to the page stayed remembered, so the next pane move sent it back
// to the search field and the next single-key shortcut typed into it.
it("a pane move leaves focus on the page when the person had left the element", async () => {
  width = 1320;
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  const field = screen.getByRole<HTMLInputElement>("combobox", { name: "Search mail" });
  field.focus();
  // A click on an empty part of the window: focus goes to the page with no focusin. The resize
  // comes in a later task, as it would after a real click.
  const clickEmpty = async (element: HTMLElement) => {
    element.blur();
    await wait(0);
    expect(document.activeElement).toBe(document.body);
  };
  await clickEmpty(field);
  resize(919);
  await eventually(() => expect(rail()).not.toBeNull());
  await wait(100);
  expect(document.activeElement).toBe(document.body);
  resize(1320);
  await eventually(() => expect(rail()).toBeNull());
  await wait(100);
  expect(document.activeElement).toBe(document.body);
  // Hiding the docked sidebar remounts the panes' group the same way.
  field.focus();
  await clickEmpty(field);
  fireEvent.keyDown(document.body, {
    key: "s",
    code: "KeyS",
    metaKey: true,
    altKey: true,
    shiftKey: true,
  });
  await eventually(() =>
    expect(
      document.querySelector('[data-mail-pane="sidebar"]:not([data-sidebar-rail])'),
    ).toBeNull(),
  );
  await wait(100);
  expect(document.activeElement).toBe(document.body);
});

it("focus in the sidebar moves to the same mailbox in the sidebar, rail or drawer that replaces it", async () => {
  width = 1320;
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  const docked = () =>
    document.querySelector<HTMLElement>('[data-mail-pane="sidebar"]:not([data-sidebar-rail])');
  const starred = (sidebar: HTMLElement | null) =>
    sidebar?.querySelector<HTMLElement>('[data-focus-key="mailbox:starred"]');
  // Select a row without opening it, so the narrow layout shows the list.
  row(h.id("one")).focus();
  key("Home");
  await eventually(() => expect(screen.getAllByRole("option", { selected: true })).toHaveLength(1));
  const picked = screen.getByRole("option", { selected: true });
  starred(docked())?.focus();
  expect(document.activeElement?.textContent).toMatch(/^Starred/);
  resize(880);
  await eventually(() => expect(rail()).not.toBeNull());
  await eventually(() => expect(document.activeElement).toBe(starred(rail())));
  resize(1320);
  await eventually(() => expect(rail()).toBeNull());
  await eventually(() => expect(document.activeElement).toBe(starred(docked())));
  // No sidebar shows in the narrow layout: focus goes to the list's selected row.
  resize(780);
  await eventually(() => expect(docked()).toBeNull());
  await eventually(() => expect(document.activeElement).toBe(picked));
  // A sidebar control with no counterpart, such as the rail's drawer toggle, hands focus to the
  // open mailbox in the sidebar that replaces it.
  resize(880);
  await eventually(() => expect(rail()).not.toBeNull());
  const toggle = within(rail()!).getByRole("button", { name: "Show sidebar" });
  toggle.focus();
  resize(1320);
  await eventually(() =>
    expect(document.activeElement).toBe(
      docked()?.querySelector('[data-focus-key="mailbox:inbox"]'),
    ),
  );
  // Focus in the open drawer goes to the docked sidebar when the window widens.
  resize(880);
  await eventually(() => expect(rail()).not.toBeNull());
  fireEvent.click(within(rail()!).getByRole("button", { name: "Show sidebar" }));
  const drawer = await screen.findByRole("dialog", { name: "Sidebar" });
  await eventually(() =>
    expect(drawer.contains(document.activeElement) && document.activeElement?.textContent).toMatch(
      /^Inbox/,
    ),
  );
  resize(1320);
  await eventually(() => expect(screen.queryByRole("dialog", { name: "Sidebar" })).toBeNull());
  await eventually(() =>
    expect(document.activeElement).toBe(
      docked()?.querySelector('[data-focus-key="mailbox:inbox"]'),
    ),
  );
});

it("focus on an account tile in the drawer moves to the same tile in the docked sidebar", async () => {
  width = 880;
  current = await flow();
  const h = current;
  await h.run(h.m.accounts.connect({ provider: "outlook" }));
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  const docked = () =>
    document.querySelector<HTMLElement>('[data-mail-pane="sidebar"]:not([data-sidebar-rail])');
  for (const tile of ["account:all", undefined]) {
    await eventually(() => expect(rail()).not.toBeNull());
    fireEvent.click(within(rail()!).getByRole("button", { name: "Show sidebar" }));
    const drawer = await screen.findByRole("dialog", { name: "Sidebar" });
    const tiles = () => [...drawer.querySelectorAll<HTMLElement>('[data-focus-key^="account:"]')];
    await eventually(() => expect(tiles()).toHaveLength(3));
    // All, then an account's own tile.
    const target = tile ? tiles().find((each) => each.dataset.focusKey === tile)! : tiles()[2]!;
    const key = target.dataset.focusKey!;
    target.focus();
    resize(1320);
    await eventually(() => expect(screen.queryByRole("dialog", { name: "Sidebar" })).toBeNull());
    await eventually(() =>
      expect(document.activeElement).toBe(docked()?.querySelector(`[data-focus-key="${key}"]`)),
    );
    resize(880);
  }
});

it("focus in a menu that a pane move closes goes where its trigger's focus would", async () => {
  width = 880;
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  // Select a row without opening it: the narrow layout then shows the list, not the reader.
  row(h.id("one")).focus();
  key("Home");
  await eventually(() => expect(screen.getAllByRole("option", { selected: true })).toHaveLength(1));
  const picked = screen.getByRole("option", { selected: true });
  await eventually(() => expect(reader()).not.toBeNull());
  const more = within(reader()!.closest<HTMLElement>('[data-mail-pane="reader"]')!).getByRole(
    "button",
    { name: "Conversation actions" },
  );
  more.focus();
  fireEvent.click(more);
  const menu = await screen.findByRole("menu", { name: "Conversation actions" });
  await eventually(() => expect(menu.contains(document.activeElement)).toBe(true));
  // The narrow layout hides the reader, which closes the menu; focus goes to the selected row.
  resize(780);
  await eventually(() => expect(reader()).toBeNull());
  await eventually(() => expect(screen.queryByRole("menu")).toBeNull());
  await eventually(() => expect(document.activeElement).toBe(picked));
});

it("a key pressed while a pane move waits for the list keeps the person's focus there", async () => {
  width = 880;
  current = await flow({
    messages: [incoming("one"), incoming("kept", { labels: ["STARRED"], isUnread: false })],
  });
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  // A starred conversation opened by its route while the lists are held: the reader shows it,
  // and the list still shows the Inbox's rows, none of them for it.
  const release = await h.holdLists();
  onTestFinished(release);
  await act(() =>
    h.router.navigate({
      href: mailHref({ space: "all", mailbox: "starred" }, { thread: h.id("kept") }),
    }),
  );
  await eventually(() => expect(reader()?.textContent).toContain("Original kept"));
  expect(document.querySelector(`[data-id="${h.id("kept")}"]`)).toBeNull();
  const bar = await screen.findByRole("group", { name: "Reply to this conversation" });
  const reply = within(bar).getByRole("button", { name: "Reply" });
  reply.focus();
  // The narrow layout hides the reader, so focus goes to the list, which waits a few frames for
  // the row before it takes focus itself.
  resize(780);
  await eventually(() => expect(reader()).toBeNull());
  await new Promise<void>((done) => {
    requestAnimationFrame(() => requestAnimationFrame(() => done()));
  });
  expect(document.activeElement).toBe(document.body);
  key("Shift", {}, document.body);
  const list = document.querySelector<HTMLElement>('[data-mail-pane="list"]');
  await eventually(() => expect(list?.contains(document.activeElement)).toBe(true));
  const kept = document.activeElement;
  // The Reply button shows again, yet the list the person kept has focus.
  resize(880);
  await eventually(() => expect(reader()).not.toBeNull());
  await wait(100);
  expect(document.activeElement).toBe(kept);
});

it("the search field gets focus back when it shows again after the narrow reader stood in", async () => {
  width = 1320;
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  fireEvent.click(row(h.id("one")));
  await eventually(() => expect(reader()?.textContent).toContain("Original one"));
  const field = screen.getByRole<HTMLInputElement>("combobox", { name: "Search mail" });
  field.focus();
  // The narrow layout shows only the reader, which takes focus while the field is hidden.
  resize(780);
  await eventually(() => expect(document.querySelector('[data-mail-pane="list"]')).toBeNull());
  await eventually(() =>
    expect(document.activeElement?.getAttribute("data-mail-pane")).toBe("reader"),
  );
  // The wide reader header renders its own field again, and that one takes focus.
  resize(1320);
  await eventually(() => expect(rail()).toBeNull());
  await eventually(() =>
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Search mail" })),
  );
  // A click in the reader that stood in makes the reader the person's own.
  resize(780);
  await eventually(() =>
    expect(document.activeElement?.getAttribute("data-mail-pane")).toBe("reader"),
  );
  fireEvent.pointerDown(reader()!);
  resize(1320);
  await eventually(() => expect(rail()).toBeNull());
  await wait(100);
  expect(document.activeElement?.getAttribute("data-mail-pane")).toBe("reader");
  // Focus the person moves on their own replaces the field.
  screen.getByRole("combobox", { name: "Search mail" }).focus();
  resize(780);
  await eventually(() =>
    expect(document.activeElement?.getAttribute("data-mail-pane")).toBe("reader"),
  );
  const bar = await screen.findByRole("group", { name: "Reply to this conversation" });
  const reply = within(bar).getByRole("button", { name: "Reply" });
  reply.focus();
  resize(1320);
  await eventually(() => expect(rail()).toBeNull());
  await wait(100);
  expect(document.activeElement).toBe(reply);
});

it("widening a narrow reader through 800 px and 960 px keeps focus on the reader", async () => {
  width = 600;
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  fireEvent.click(row(h.id("one")));
  await eventually(() =>
    expect(document.activeElement?.getAttribute("data-mail-pane")).toBe("reader"),
  );
  resize(831);
  await eventually(() => expect(rail()).not.toBeNull());
  await eventually(() =>
    expect(document.activeElement?.getAttribute("data-mail-pane")).toBe("reader"),
  );
  resize(1320);
  await eventually(() => expect(rail()).toBeNull());
  await eventually(() =>
    expect(document.activeElement?.getAttribute("data-mail-pane")).toBe("reader"),
  );
  // Straight from 600 px to 1320 px too.
  resize(600);
  await eventually(() => expect(document.querySelector('[data-mail-pane="list"]')).toBeNull());
  document.querySelector<HTMLElement>('[data-mail-pane="reader"]')?.focus();
  resize(1320);
  await eventually(() => expect(document.querySelector('[data-mail-pane="list"]')).not.toBeNull());
  await eventually(() =>
    expect(document.activeElement?.getAttribute("data-mail-pane")).toBe("reader"),
  );
});

it("the reader takes focus when it becomes the only pane by narrowing or by Back", async () => {
  width = 1200;
  current = await flow({ windowHistory: true });
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  const readerFocused = () =>
    eventually(() => expect(document.activeElement?.getAttribute("data-mail-pane")).toBe("reader"));
  fireEvent.click(row(h.id("one")));
  await eventually(() => expect(reader()?.textContent).toContain("Original one"));
  row(h.id("one")).focus();
  resize(520);
  await eventually(() => expect(document.querySelector('[data-mail-pane="list"]')).toBeNull());
  await readerFocused();
  // Another mailbox, then Back onto the reader's entry.
  key("2", { metaKey: true }, document.body);
  await eventually(() =>
    expect(screen.getByRole("heading", { level: 1 }).textContent).not.toBe("Inbox"),
  );
  await eventually(() => expect(document.activeElement?.getAttribute("role")).toBe("listbox"));
  await h.event({ _tag: "NativeAction", action: "goBack", triggeredByAccelerator: true });
  await eventually(() => expect(reader()?.textContent).toContain("Original one"));
  await readerFocused();
});

it("Cmd+] after Cmd+[ in a narrow window opens the reader again", async () => {
  width = 520;
  current = await flow({ windowHistory: true });
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  fireEvent.click(row(h.id("two")));
  await eventually(() => expect(reader()?.textContent).toContain("Original two"));
  key("[", { metaKey: true }, document.body);
  await eventually(() => expect(reader()).toBeNull());
  await eventually(() => expect(document.activeElement).toBe(row(h.id("two"))));
  key("]", { metaKey: true }, document.body);
  await eventually(() => expect(reader()?.textContent).toContain("Original two"));
  expect(document.querySelector('[data-mail-pane="list"]')).toBeNull();
  await eventually(() =>
    expect(document.activeElement?.getAttribute("data-mail-pane")).toBe("reader"),
  );
  // Back again returns to the list, and the next Forward still has its reader.
  key("[", { metaKey: true }, document.body);
  await eventually(() => expect(reader()).toBeNull());
  key("]", { metaKey: true }, document.body);
  await eventually(() => expect(reader()?.textContent).toContain("Original two"));
});

it("Back from a narrow reader to a search whose last word is one character shows the same results", async () => {
  width = 520;
  current = await flow({
    windowHistory: true,
    messages: Array.from({ length: 12 }, (_, index) =>
      incoming(`m${index}`, { subject: `item ${index}`, date: Date.now() - (index + 1) * 60_000 }),
    ),
  });
  const h = current;
  await eventually(() => expect(row(h.id("m0"))).toBeTruthy());
  const shown = () =>
    [...document.querySelectorAll<HTMLElement>("[data-id]")].map((element) => element.dataset.id);
  const field = screen.getByRole<HTMLInputElement>("combobox", { name: "Search mail" });
  field.focus();
  fireEvent.change(field, { target: { value: "item 5" } });
  key("Enter", {}, field);
  await eventually(() => expect(shown()).toEqual([h.id("m5")]));
  // Past the search's commit to the route.
  await eventually(() => expect(decodeURIComponent(window.location.hash)).toContain("q=item+5"));
  fireEvent.click(row(h.id("m5")));
  await eventually(() => expect(reader()?.textContent).toContain("Original m5"));
  clickButton("Back to messages");
  await eventually(() => expect(reader()).toBeNull());
  await eventually(() => expect(document.activeElement).toBe(row(h.id("m5"))));
  await wait(400);
  expect(field.value.trim()).toBe("item 5");
  expect(shown()).toEqual([h.id("m5")]);
});

/**
 * Runs `body` with list layout as Chromium gives it. jsdom lays nothing out: here a shown list is
 * 600 px tall, a hidden one reads a height and scroll offset of 0 but keeps its offset for when it
 * shows again, and the list hears of a change in its size a few frames later, from its
 * ResizeObserver.
 */
async function withListLayout(body: () => Promise<void>) {
  const height = vi
    .spyOn(HTMLElement.prototype, "clientHeight", "get")
    .mockImplementation(function (this: HTMLElement) {
      return this.closest("[hidden]") ? 0 : 600;
    });
  const offsets = new WeakMap<Element, number>();
  const setupScrollTop = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get(this: Element) {
      return this.closest("[hidden]") ? 0 : (offsets.get(this) ?? 0);
    },
    set(this: Element, value: number) {
      offsets.set(this, value);
    },
  });
  const observed = new Set<{ callback: () => void; target: Element }>();
  const shownOrHidden = new MutationObserver(() =>
    setTimeout(() => {
      for (const entry of observed) if (entry.target.isConnected) entry.callback();
    }, 60),
  );
  shownOrHidden.observe(document.body, { attributeFilter: ["hidden"], subtree: true });
  const setupObserver = globalThis.ResizeObserver;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      callback: () => void;
      constructor(callback: () => void) {
        this.callback = callback;
      }
      observe(target: Element) {
        observed.add({ callback: this.callback, target });
      }
      unobserve = constVoid;
      disconnect = constVoid;
    },
  );
  try {
    await body();
  } finally {
    shownOrHidden.disconnect();
    height.mockRestore();
    if (setupScrollTop) Object.defineProperty(Element.prototype, "scrollTop", setupScrollTop);
    vi.stubGlobal("ResizeObserver", setupObserver);
  }
}

const longInbox = (length: number) =>
  Array.from({ length }, (_, index) =>
    incoming(`m${index}`, { date: Date.now() - (index + 1) * 60_000 }),
  );

it("Back from a narrow reader focuses a row that was below the first screen", () =>
  withListLayout(async () => {
    width = 520;
    current = await flow({ messages: longInbox(40) });
    const h = current;
    await eventually(() => expect(row(h.id("m0"))).toBeTruthy());
    const rowHeight = parseFloat(row(h.id("m0")).style.height);
    const list = screen.getByRole("listbox", { name: "Inbox" });
    list.scrollTop = 1000;
    fireEvent.scroll(list);
    // A row on screen, more than six rows below the top of the list.
    const target = `m${Math.floor((1000 + 590) / rowHeight)}`;
    await eventually(() => expect(row(h.id(target))).toBeTruthy());
    fireEvent.click(row(h.id(target)));
    await eventually(() => expect(reader()).not.toBeNull());
    key("Escape", {}, document.body);
    await eventually(() => expect(reader()).toBeNull());
    await eventually(() => expect(document.activeElement).toBe(row(h.id(target))));
  }));

it("Back to a list that started over at the top after a mailbox switch scrolls to its row", () =>
  withListLayout(async () => {
    width = 520;
    current = await flow({ windowHistory: true, messages: longInbox(60) });
    const h = current;
    await eventually(() => expect(row(h.id("m0"))).toBeTruthy());
    const rowHeight = parseFloat(row(h.id("m0")).style.height);
    const list = screen.getByRole("listbox", { name: "Inbox" });
    list.scrollTop = 48 * rowHeight - 300;
    fireEvent.scroll(list);
    await eventually(() => expect(row(h.id("m48"))).toBeTruthy());
    fireEvent.click(row(h.id("m48")));
    await eventually(() => expect(reader()?.textContent).toContain("Original m48"));
    // Another mailbox starts at the top; Back twice returns through the reader to the Inbox list.
    key("2", { metaKey: true }, document.body);
    await eventually(() =>
      expect(screen.getByRole("heading", { level: 1 }).textContent).not.toBe("Inbox"),
    );
    key("[", { metaKey: true }, document.body);
    await eventually(() => expect(reader()?.textContent).toContain("Original m48"));
    key("[", { metaKey: true }, document.body);
    await eventually(() => expect(reader()).toBeNull());
    await eventually(() => expect(document.activeElement).toBe(row(h.id("m48"))));
    expect(row(h.id("m48")).getAttribute("aria-selected")).toBe("true");
  }));

it("Home, End, Page Up and Page Down move the list's selection and focus", () =>
  withListLayout(async () => {
    width = 520;
    current = await flow({ messages: longInbox(150) });
    const h = current;
    await eventually(() => expect(row(h.id("m0"))).toBeTruthy());
    const rowHeight = parseFloat(row(h.id("m0")).style.height);
    const list = screen.getByRole("listbox", { name: "Inbox" });
    const loaded = () =>
      Math.round(
        parseFloat(list.querySelector<HTMLElement>(":scope > div")!.style.height) / rowHeight,
      );
    const at = async (index: number) => {
      await eventually(() => expect(document.activeElement).toBe(row(h.id(`m${index}`))));
      expect(row(h.id(`m${index}`)).getAttribute("aria-selected")).toBe("true");
      expect(screen.getAllByRole("option", { selected: true })).toHaveLength(1);
      // focusList looks for its row in the next frame; the next key waits for that look.
      await act(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          }),
      );
    };
    // The first page of 100 rows.
    await eventually(() => expect(loaded()).toBe(100));
    row(h.id("m0")).focus();
    key("Home");
    await at(0);
    key("End");
    await at(99);
    // The last loaded row asks for older mail, as Down onto it does.
    await eventually(() => expect(loaded()).toBe(150));
    key("Home");
    await at(0);
    // The list is 600 px tall: a page is as many rows as fit in it.
    const page = Math.floor(600 / rowHeight);
    key("PageDown");
    await at(page);
    key("PageUp");
    await at(0);
    expect(list.scrollTop).toBe(0);
  }));

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
  // Focus on the toggle opens its tooltip in a portal at the end of the body, outside every
  // landmark. It must not count as page content outside a landmark.
  await eventually(() =>
    expect(document.querySelector("[data-base-ui-portal]")?.textContent).toContain("Show sidebar"),
  );
  let violations: axe.Result[] = [];
  await act(async () => {
    violations = (await axe.run(document.body, { runOnly: ["region", "aria-hidden-focus"] }))
      .violations;
  });
  expect(violations.map((issue) => issue.id)).toEqual([]);

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
  // The sidebar header holds the traffic lights; the list header beside it needs no room.
  const sidebarHeader = document.querySelector('[data-mail-pane="sidebar"] aside > .drag');
  expect(lightSpaceAt(sidebarHeader, 0)).toBe(96);
  expect(lightSpaceAt(document.querySelector('[data-mail-pane="list"] header'), 260)).toBe(0);
});

it("the list header clears the lights when a breakpoint or the sidebar moves it without resizing it", async () => {
  width = 1200;
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  // The header keeps its size and only moves: right of the docked sidebar, right of the rail, or
  // to the window edge. Its ResizeObserver does not fire, and jsdom has none to begin with.
  const header = document.querySelector('[data-mail-pane="list"] header');
  if (!header) throw new Error("Missing list header");
  const docked = () =>
    document.querySelector('[data-mail-pane="sidebar"]:not([data-sidebar-rail])');
  let moved = 0;
  const at = () => moved + (rail() ? 56 : docked() ? 232 : 0);
  for (const [name, value] of Object.entries({ offsetTop: 0, offsetHeight: 52 }))
    Object.defineProperty(header, name, { configurable: true, value });
  Object.defineProperty(header, "offsetLeft", { configurable: true, get: at });
  const space = () => {
    const spacer = header.querySelector<HTMLElement>(":scope > [data-traffic-light-space]");
    return spacer?.hidden ? 0 : Number(spacer?.dataset.trafficLightSpace);
  };
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
  expect(space()).toBe(0);
  // The window's resize event comes first and measures the old place; then the media query
  // reports the medium breakpoint and the rail replaces the sidebar.
  width = 959;
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
  resize(959);
  expect(rail()).not.toBeNull();
  expect(space()).toBe(40);
  width = 961;
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
  resize(961);
  expect(rail()).toBeNull();
  expect(space()).toBe(0);
  // Hiding the sidebar moves the list to the window edge with no resize at all.
  fireEvent.keyDown(document.body, {
    key: "s",
    code: "KeyS",
    metaKey: true,
    altKey: true,
    shiftKey: true,
  });
  await eventually(() => expect(docked()).toBeNull());
  expect(space()).toBe(96);
  // A row that moves later in the same frame as a resize is measured again before paint.
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
  moved = 200;
  expect(space()).toBe(96);
  await act(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      }),
  );
  expect(space()).toBe(0);
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
  // The 56 px rail leaves the list header 40 px of the lights to clear.
  expect(lightSpaceAt(list?.querySelector("header"), 56)).toBe(40);
  // The lights are wider than the rail. Their row over the rail takes the list's surface and
  // no border; the rail's divider starts below it.
  const [titlebar, body] = strip.children;
  expect(strip.className).not.toMatch(/(^|\s)border/);
  expect(titlebar?.hasAttribute("data-rail-titlebar")).toBe(true);
  expect(titlebar?.className.split(" ")).toEqual(expect.arrayContaining(["h-13", "bg-surface"]));
  expect(titlebar?.className).not.toMatch(/(^|\s)border/);
  expect(body?.className.split(" ")).toContain("border-r");

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
  expect(lightSpaceAt(header, 0)).toBe(96);
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
  // Settings is a lazy chunk; its first import in a cold jsdom run can take over a second.
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  expect(settings.className).toContain("max-sm:inset-0");
  const tabs = within(settings).getByRole("tablist");
  expect(tabs.getAttribute("data-orientation")).toBe("horizontal");
  // Tabs past the right edge fade out there; scrolled to the end, the fade goes.
  for (const [name, value] of Object.entries({ scrollWidth: 900, clientWidth: 500 }))
    Object.defineProperty(tabs, name, { configurable: true, value });
  fireEvent.scroll(tabs);
  await eventually(() => expect(tabs.hasAttribute("data-more")).toBe(true));
  expect(tabs.className).toContain("max-sm:data-more:[mask-image:");
  tabs.scrollLeft = 400;
  fireEvent.scroll(tabs);
  await eventually(() => expect(tabs.hasAttribute("data-more")).toBe(false));
  fireEvent.click(within(settings).getByRole("button", { name: "Close" }));
  await eventually(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull());

  // A dialog with a close button of its own gets no second one.
  clickButton("Show sidebar");
  const drawer = await screen.findByRole("dialog", { name: "Sidebar" });
  fireEvent.click(within(drawer).getByRole("button", { name: "Add email account" }));
  const add = await screen.findByRole("dialog", { name: "Add email account" });
  expect(within(add).getAllByRole("button", { name: "Close" })).toHaveLength(1);
});

it("the reader's toolbar folds actions into its menu as it narrows, next to the search field", async () => {
  const layout = toolbarLayout();
  toolbar = layout;
  width = 1200;
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  fireEvent.click(row(h.id("one")));
  await screen.findByRole("button", { name: "Archive" });
  const header = document.querySelector<HTMLElement>("[data-reader-toolbar]");
  if (!header) throw new Error("Missing reader toolbar");
  expect(header.className).toContain("@container/bar");
  // The actions take the room the search field leaves; it keeps a basis of its own.
  const search = within(header).getByRole("combobox", { name: "Search mail" });
  expect(search.closest("[data-reader-toolbar] > div:last-child")?.className).toContain(
    "flex-[0_1_14rem]",
  );
  const all = shown();
  // Reply and Forward come right after Archive and Delete, so they stay out of the menu.
  expect(all.slice(0, 5)).toEqual(["archive", "trash", "reply", "replyAll", "forward"]);
  layout.resize(150);
  expect(shown()).toEqual(all.slice(0, 4));
  layout.resize(40);
  expect(shown()).toEqual([]);
  expect(screen.getByRole("button", { name: "Conversation actions" })).toBeTruthy();
  layout.resize(2000);
  expect(shown()).toEqual(all);
});

it("a narrow window shows actions for several selected rows above the list", async () => {
  width = 520;
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  const list = () => document.querySelector<HTMLElement>('[data-mail-pane="list"]')!;
  expect(within(list()).queryByRole("button", { name: "Batch actions" })).toBeNull();
  expect(within(list()).getByRole("button", { name: "Quick filters" })).toBeTruthy();
  fireEvent.click(row(h.id("one")), { metaKey: true });
  fireEvent.click(row(h.id("two")), { metaKey: true });
  await eventually(() =>
    expect(within(list()).getByRole("button", { name: "Batch actions" })).toBeTruthy(),
  );
  // The selection stays in the list; the bar takes the filter chips' place. It is the only
  // batch bar, so one label picker opens at a time.
  expect(reader()).toBeNull();
  expect(screen.getAllByRole("button", { name: "Batch actions", hidden: true })).toHaveLength(1);
  expect(within(list()).queryByRole("button", { name: "Quick filters" })).toBeNull();
  expect(within(list()).getByText("2 selected (loaded)")).toBeTruthy();
  fireEvent.click(within(list()).getByRole("button", { name: "Archive" }));
  await eventually(async () => {
    for (const id of ["one", "two"])
      expect((await h.run(h.store.getMessage(h.id(id)))).labels).not.toContain("INBOX");
  });
});

/** The block an empty list shows: its sentence and the button for the next step. */
const emptyList = async (text: string | RegExp) => {
  const sentence = await screen.findByText(text);
  return within(sentence.parentElement ?? sentence);
};

it("an empty list says why and offers the next step", async () => {
  width = 1200;
  current = await flow({ messages: [] });
  const h = current;
  const nav = await screen.findByRole("navigation", { name: "Mailboxes" });

  const syncs = () => h.requests.filter((request) => request.tag === "Sync").length;
  const before = syncs();
  fireEvent.click(
    (await emptyList("You're all caught up. Your Inbox is empty.")).getByRole("button", {
      name: "Sync now",
    }),
  );
  await eventually(() => expect(syncs()).toBeGreaterThan(before));

  fireEvent.click(screen.getByRole("button", { name: "Unread" }));
  fireEvent.click(
    (await emptyList("No messages match the quick filters")).getByRole("button", {
      name: "Turn off quick filters",
    }),
  );
  await screen.findByText("You're all caught up. Your Inbox is empty.");

  fireEvent.change(screen.getByLabelText("Search mail", { exact: true }), {
    target: { value: "nothing-matches" },
  });
  fireEvent.click(
    (await emptyList("No matching messages")).getByRole("button", { name: "Clear search" }),
  );
  await eventually(() =>
    expect(screen.getByLabelText("Search mail", { exact: true })).toHaveProperty("value", ""),
  );

  fireEvent.click(within(nav).getByRole("button", { name: "Starred" }));
  await screen.findByText("No starred messages. Star a message to find it here.");

  fireEvent.click(within(nav).getByRole("button", { name: "Drafts" }));
  fireEvent.click((await emptyList("No drafts")).getByRole("button", { name: "New message" }));
  await eventually(() => expect(screen.getByRole("textbox", { name: "Subject" })).toBeTruthy());
});

it("Snoozed, Trash and Spam explain themselves and have nothing to sync", async () => {
  width = 1200;
  current = await flow({ messages: [] });
  const nav = await screen.findByRole("navigation", { name: "Mailboxes" });
  for (const [mailbox, text] of [
    ["Snoozed", /^No snoozed messages\. A snoozed message leaves the Inbox/],
    ["Trash", "Trash is empty"],
    ["Spam", "Spam is empty"],
  ] as const) {
    fireEvent.click(within(nav).getByRole("button", { name: mailbox }));
    expect((await emptyList(text)).queryByRole("button")).toBeNull();
  }
});

it("an undocked sidebar moves sign-in and sync failures above the list", async () => {
  width = 1200;
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  const list = () => document.querySelector<HTMLElement>('[data-mail-pane="list"]')!;

  // Settings reads come first in a sync and swallow a one-off failure, so fail every call.
  const failEvery = (error: ProviderError | AuthError | undefined) =>
    Object.defineProperty(h.server, "failNext", {
      configurable: true,
      get: () => error,
      set: constVoid,
    });
  // A 403 is not retried, so the sync fails at once.
  failEvery(new ProviderError({ message: "Forbidden", status: 403 }));
  await h.event({ _tag: "NativeAction", action: "sync", triggeredByAccelerator: false });
  await eventually(() => expect(screen.getByText("Sync failed (1)")).toBeTruthy());
  // The docked sidebar already reports it; the list does not repeat it.
  expect(within(list()).queryByText(/Couldn't sync/)).toBeNull();
  // The footer's failure is a button that opens the same lines, with the reason written out.
  fireEvent.click(screen.getByRole("button", { name: "Sync failed (1)" }));
  const problems = await screen.findByRole("dialog", { name: "Sync failed" });
  expect(within(problems).getByText("Couldn't sync me@gmail.com.")).toBeTruthy();
  expect(within(problems).getByRole("listitem").textContent).toMatch(/^me@gmail\.com: /);
  expect(problems.textContent).not.toContain(h.account.id);
  fireEvent.keyDown(problems, { key: "Escape" });
  await eventually(() => expect(screen.queryByRole("dialog", { name: "Sync failed" })).toBeNull());

  resize(800);
  await eventually(() =>
    expect(within(list()).getByText("Couldn't sync me@gmail.com.")).toBeTruthy(),
  );
  failEvery(undefined);
  fireEvent.click(within(list()).getByRole("button", { name: "Try again" }));
  await eventually(() => expect(within(list()).queryByText(/Couldn't sync/)).toBeNull());

  // An AuthError without a reason is a 401 after the forced refresh: token_revoked.
  failEvery(new AuthError({ message: "Expired" }));
  await h.event({ _tag: "NativeAction", action: "sync", triggeredByAccelerator: false });
  await eventually(() =>
    expect(
      within(list()).getByText(
        "me@gmail.com's sign-in was revoked or has expired. Sync is paused.",
      ),
    ).toBeTruthy(),
  );
  // An expired account is not also reported as a sync failure.
  expect(within(list()).queryByText(/Couldn't sync/)).toBeNull();
  expect(within(list()).getByRole("button", { name: "Sign in again" })).toBeTruthy();
});

it("the list says when the computer is offline", async () => {
  width = 520;
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  act(() => {
    window.dispatchEvent(new Event("offline"));
  });
  // The notice shows, and a polite status announces it once.
  const offline = "You're offline. Mail syncs again when you reconnect.";
  expect(screen.getByText(offline, { selector: "p" })).toBeTruthy();
  expect(
    screen.getAllByRole("status").filter((status) => status.textContent === offline),
  ).toHaveLength(1);
  onLine.mockReturnValue(true);
  act(() => {
    window.dispatchEvent(new Event("online"));
  });
  expect(screen.queryByText(/You're offline/)).toBeNull();
});

it("pane dividers are named and resize their panes with the arrow keys", async () => {
  width = 1200;
  // jsdom lays nothing out: the sidebar and the list report the widths a window would give them.
  const widths: Record<string, number> = { sidebar: 232.4, list: 379.6 };
  const rect = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      const pane = this.getAttribute("data-mail-pane");
      return DOMRect.fromRect({ width: (pane && widths[pane]) || 0, height: 600 });
    });
  onTestFinished(() => rect.mockRestore());
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  const sidebar = screen.getByRole("separator", { name: "Resize sidebar" });
  const list = screen.getByRole("separator", { name: "Resize message list" });
  // Both are tab stops. jsdom has no layout, so the arrow keys that resize them are checked
  // in the Electron screenshot run instead (react-resizable-panels handles the keys).
  expect(sidebar.tabIndex).toBe(0);
  expect(list.tabIndex).toBe(0);
  expect(list.getAttribute("aria-orientation")).toBe("vertical");
  // Screen readers hear the pane's width, not the library's raw percentage.
  expect(sidebar.getAttribute("aria-valuetext")).toBe("232 pixels");
  expect(list.getAttribute("aria-valuetext")).toBe("380 pixels");
  // Keyboard focus shows the 3:1 focus ring above the panes, not only a 1 px colour change.
  for (const separator of [sidebar, list]) {
    expect(separator.className).toContain("focus-ring");
    expect(separator.className).toContain("focus-visible:z-10");
    expect(separator.className).not.toMatch(/\boutline-none\b/);
  }
});

it("a narrow window offers New message in the list header, and 720 px shows the list alone", async () => {
  width = 720;
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  expect(reader()).toBeNull();
  expect(rail()).toBeNull();
  const header = document.querySelector('[data-mail-pane="list"] header');
  if (!(header instanceof HTMLElement)) throw new Error("Missing list header");
  fireEvent.click(within(header).getByRole("button", { name: "New message" }));
  await eventually(() => expect(screen.getByRole("textbox", { name: "Subject" })).toBeTruthy());
});

it("the list header offers New message whenever neither the sidebar nor the rail shows it", async () => {
  const listHeader = () => {
    const header = document.querySelector('[data-mail-pane="list"] header');
    if (!(header instanceof HTMLElement)) throw new Error("Missing list header");
    return header;
  };
  width = 1200;
  current = await flow({ prefs: { sidebarVisible: false } });
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  expect(screen.queryByRole("navigation", { name: "Mailboxes" })).toBeNull();
  fireEvent.click(within(listHeader()).getByRole("button", { name: "New message" }));
  await eventually(() => expect(screen.getByRole("textbox", { name: "Subject" })).toBeTruthy());
  await current.dispose();
  // The docked sidebar and the medium rail each have their own button.
  for (const [next, prefs] of [
    [1200, { sidebarVisible: true }],
    [900, { sidebarVisible: false }],
  ] as const) {
    width = next;
    current = await flow({ prefs });
    const c = current;
    await eventually(() => expect(row(c.id("one"))).toBeTruthy());
    expect(within(listHeader()).queryByRole("button", { name: "New message" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "New message" }).length).toBeGreaterThan(0);
    await current.dispose();
  }
  current = undefined;
});

it("the thread ends with Reply, Reply all and Forward, and has one menu for the conversation", async () => {
  width = 1200;
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  fireEvent.click(row(h.id("one")));
  const bar = await screen.findByRole("group", { name: "Reply to this conversation" });
  expect(
    within(bar)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["Reply", "Reply all", "Forward"]);
  // Screen readers skip the tooltips, so each toolbar button names its keys itself.
  expect(screen.getByRole("button", { name: "Archive" }).getAttribute("aria-keyshortcuts")).toBe(
    "Control+Meta+A",
  );
  expect(
    within(bar).getByRole("button", { name: "Reply" }).getAttribute("aria-keyshortcuts"),
  ).toMatch(/^(Meta|Control)\+R$/);
  // The subject row has no "…" of its own: its commands are in Conversation actions.
  const thread = screen.getByRole("document");
  expect(within(thread).queryByRole("button", { name: "More actions" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Conversation actions" }));
  expect(await screen.findByRole("menuitem", { name: "Copy link to conversation" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: /^Larger text/ })).toBeTruthy();
  key("Escape");
  await eventually(() =>
    expect(screen.queryByRole("menuitem", { name: /^Larger text/ })).toBeNull(),
  );

  fireEvent.click(within(bar).getByRole("button", { name: "Reply" }));
  await eventually(() =>
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Subject" }).value).toMatch(
      /^Re: /,
    ),
  );
});

it("with the toolbar hidden, the subject row keeps the thread's menu", async () => {
  width = 1200;
  current = await flow({ prefs: { toolbarVisible: false } });
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  fireEvent.click(row(h.id("one")));
  await screen.findByRole("group", { name: "Reply to this conversation" });
  fireEvent.click(
    within(screen.getByRole("document")).getByRole("button", { name: "More actions" }),
  );
  expect(await screen.findByRole("menuitem", { name: /^Larger text/ })).toBeTruthy();
});

it("the overview beside a docked sidebar keeps every control inside a landmark", async () => {
  width = 1200;
  current = await flow({ route: mailHref({ space: "overview", mailbox: "inbox" }) });
  await eventually(() =>
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Overview"),
  );
  const handle = screen.getByRole("separator", { name: "Resize sidebar" });
  expect(handle.closest('main, [role="main"]')).not.toBeNull();
  expect(screen.getByRole("region", { name: "Sidebar" })).toBeTruthy();
  let violations: axe.Result[] = [];
  await act(async () => {
    violations = (
      await axe.run(document.body, {
        runOnly: [
          "region",
          "landmark-unique",
          "landmark-one-main",
          "landmark-no-duplicate-main",
          "landmark-main-is-top-level",
          "landmark-complementary-is-top-level",
          "landmark-banner-is-top-level",
        ],
      })
    ).violations;
  });
  expect(violations.map((issue) => issue.id)).toEqual([]);
});

// A narrow window's list had no main landmark, and its reader no h1: the list's title went
// hidden with the list while the reader's subject stayed an h2.
it("a narrow window's list and reader are each the main landmark with an h1; wide stays one main", async () => {
  const landmarks = async () => {
    let violations: axe.Result[] = [];
    await act(async () => {
      violations = (
        await axe.run(document.body, {
          runOnly: [
            "region",
            "landmark-one-main",
            "landmark-no-duplicate-main",
            "landmark-main-is-top-level",
            "landmark-unique",
            "page-has-heading-one",
            "heading-order",
          ],
        })
      ).violations;
    });
    return violations.map((issue) => issue.id);
  };
  const h1 = () => screen.getByRole("heading", { level: 1 }).textContent;
  width = 520;
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  expect(screen.getByRole("main").contains(row(h.id("one")))).toBe(true);
  expect(h1()).toBe("Inbox");
  expect(await landmarks()).toEqual([]);
  fireEvent.click(row(h.id("one")));
  await eventually(() => expect(reader()?.textContent).toContain("Original one"));
  expect(screen.getByRole("main").contains(reader())).toBe(true);
  expect(h1()).toBe("Flow one");
  // The message headings follow the subject one level down.
  expect(screen.getByRole("heading", { level: 2, name: /^Alice, / })).toBeTruthy();
  expect(await landmarks()).toEqual([]);
  // Medium: the panes are one main landmark, and the rail beside it is the labelled sidebar.
  resize(880);
  await eventually(() => expect(rail()).not.toBeNull());
  expect(screen.getByRole("complementary", { name: "Sidebar" })).toBe(rail());
  expect(screen.getByRole("main").contains(row(h.id("one")))).toBe(true);
  expect(await landmarks()).toEqual([]);
  // Wide: the panes are one main landmark, the list's title is the h1 and the subject an h2.
  resize(1200);
  await eventually(() => expect(row(h.id("one")).closest("[hidden]")).toBeNull());
  expect(screen.getByRole("main").contains(row(h.id("one")))).toBe(true);
  expect(screen.getByRole("main").contains(reader())).toBe(true);
  expect(h1()).toBe("Inbox");
  expect(screen.getByRole("heading", { level: 2, name: "Flow one" })).toBeTruthy();
  expect(screen.getByRole("heading", { level: 3, name: /^Alice, / })).toBeTruthy();
  expect(await landmarks()).toEqual([]);
});

it("Back from a narrow reader keeps the list, and a cached mailbox off screen refreshes when it shows", async () => {
  width = 520;
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  const lists = (mailbox: string) =>
    h.requests.filter(
      (request) =>
        (request.tag === "Threads" || request.tag === "ThreadCount") &&
        JSON.stringify(request.payload).includes(`"mailbox":"${mailbox}"`),
    ).length;
  const list = screen.getByRole("listbox");
  fireEvent.click(row(h.id("one")));
  await eventually(() => expect(reader()?.textContent).toContain("Original one"));
  const opened = lists("inbox");
  clickButton("Back to messages");
  await eventually(() => expect(reader()).toBeNull());
  await wait(50);
  // The rows come back from the mounted list: no read and no new list node.
  expect(screen.getByRole("listbox")).toBe(list);
  expect(lists("inbox")).toBe(opened);

  resize(1320);
  const mailbox = (id: string) =>
    document.querySelector<HTMLElement>(
      `[data-mail-pane="sidebar"]:not([data-sidebar-rail]) [data-focus-key="mailbox:${id}"]`,
    );
  await eventually(() => expect(mailbox("sent")).not.toBeNull());
  fireEvent.click(mailbox("sent")!);
  await eventually(() => expect(screen.getByRole("listbox").getAttribute("aria-label")).toBe("Sent"));
  const inbox = lists("inbox");
  const sent = lists("sent");
  // New mail changes every list. Sent is on screen and reads again; the cached Inbox waits.
  h.server.messages.set("three", incoming("three"));
  await h.run(h.m.sync.sync());
  await eventually(() => expect(lists("sent")).toBeGreaterThan(sent));
  await wait(50);
  expect(lists("inbox")).toBe(inbox);
  fireEvent.click(mailbox("inbox")!);
  // Its cached rows show at once, and one read brings in the new mail.
  expect(row(h.id("one"))).toBeTruthy();
  await eventually(() => expect(row(h.id("three"))).toBeTruthy());
  expect(lists("inbox")).toBeGreaterThan(inbox);
});

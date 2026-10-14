import { afterEach, expect, it, vi } from "vitest";
import { act, fireEvent, screen, within } from "@testing-library/react/pure";
import { createElement, type ComponentProps } from "react";
import type { EmailFrame as RealEmailFrame } from "../features/reader/frame/EmailFrame";
import { eventually, flow, incoming, row, wait } from "./harness";

/**
 * jsdom marks no dispatched event as trusted, and the message frame forwards only trusted keys.
 * The frame stays real; this records the handler it forwards to, so a test can press keys "in"
 * the message the way the frame's own listener would.
 */
const frame = vi.hoisted(() => ({
  keys: undefined as ((event: KeyboardEvent) => void) | undefined,
}));
vi.mock("../features/reader/frame/EmailFrame", async (original) => {
  const actual = await original<typeof import("../features/reader/frame/EmailFrame")>();
  return {
    EmailFrame: (props: ComponentProps<typeof RealEmailFrame>) => {
      frame.keys = props.onKeyDown;
      return createElement(actual.EmailFrame, props);
    },
  };
});

let current: Awaited<ReturnType<typeof flow>> | undefined;
afterEach(async () => {
  await current?.dispose();
  current = undefined;
  frame.keys = undefined;
});

type Flow = Awaited<ReturnType<typeof flow>>;
const message = (id: string, age: number, overrides: Parameters<typeof incoming>[1] = {}) =>
  incoming(id, {
    threadId: "shared",
    subject: id,
    from: { name: id, address: `${id}@example.com` },
    bodyText: `${id} original body`,
    date: Date.now() - age,
    isUnread: false,
    labels: ["INBOX"],
    ...overrides,
  });
const selected = () => screen.getByRole("article", { name: /^Selected message/ });
const article = (h: Flow, id: string) => {
  // Open messages are articles; collapsed ones are their header button.
  const found = document.querySelector<HTMLElement>(`[data-message-id="${h.id(id)}"]`);
  if (!found) throw new Error(`Missing message ${id}`);
  return found;
};
const findField = () => document.querySelector('input[aria-label="Find in message"]');
function press(target: EventTarget, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}
/** Picks an item from the selected message's own actions menu. */
async function messageAction(name: string) {
  fireEvent.click(within(selected()).getByRole("button", { name: "Message actions" }));
  fireEvent.click(await screen.findByRole("menuitem", { name }));
}
const payloads = (h: Flow, tag: string) =>
  h.requests.filter((request) => request.tag === tag).map((request) => request.payload);

async function threadWindow(
  messages: ReturnType<typeof message>[],
  thread: string,
  prefs: Parameters<typeof flow>[0] = {},
) {
  current = await flow({
    thread,
    messages,
    prefs: { shortcutSet: "mimestream" },
    ...prefs,
  });
  await eventually(() => expect(selected()).toBeTruthy());
  return current;
}

it("sync preserves selected reply/find/expansion; forward/web keep their shortcuts and actions deliver undo IDs", async () => {
  const h = await threadWindow([message("old", 3000), message("new", 2000)], "new");
  fireEvent.click(article(h, "old"));
  await eventually(() => expect(selected().textContent).toContain("old original body"));
  press(selected(), "f", { metaKey: true });
  await eventually(() => expect(findField()).not.toBeNull());

  // A reply arrives; the chosen message, its find field and its expansion stay.
  h.server.messages.set("latest", message("latest", 1000));
  await h.run(h.m.sync());
  await eventually(() => expect(article(h, "latest")).toBeTruthy());
  expect(selected().textContent).toContain("old original body");
  expect(findField()).not.toBeNull();

  // Forward and Open in web keep their shortcuts, from the message and from its find field.
  for (const target of [selected(), findField()]) {
    if (!target) throw new Error("Missing key target");
    press(target, "F", { metaKey: true, shiftKey: true });
    await eventually(() =>
      expect(payloads(h, "ComposeMessage").at(-1)).toEqual({
        id: h.id("old"),
        mode: "forward",
        asAttachment: false,
      }),
    );
    press(target, "G", { metaKey: true, shiftKey: true });
    await eventually(() =>
      expect(payloads(h, "OpenMessageWeb").at(-1)).toEqual({ id: h.id("old") }),
    );
  }

  // Each message action applies to the chosen message only and offers its Undo.
  for (const [label, kind] of [
    ["Star message", "star"],
    ["Mark message unread", "read"],
    ["Archive message", "archive"],
    ["Move message to Trash", "trash"],
  ] as const) {
    const pushed = h.server.pushed.length;
    await messageAction(label);
    await eventually(() => expect(h.server.pushed.length).toBeGreaterThan(pushed));
    expect(h.server.pushed.slice(pushed)).toEqual([
      expect.objectContaining({ providerId: "old", op: expect.objectContaining({ kind }) }),
    ]);
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await eventually(() => expect(h.server.pushed.length).toBe(pushed + 2));
    expect(h.server.pushed.at(-1)?.providerId).toBe("old");
    await eventually(() => expect(selected().textContent).toContain("old original body"));
  }

  const unreadFrom = h.server.pushed.length;
  await messageAction("Mark unread from this message");
  await eventually(() =>
    expect(h.server.pushed.slice(unreadFrom)).toContainEqual(
      expect.objectContaining({ providerId: "old", op: { kind: "read", value: false } }),
    ),
  );
  expect(await screen.findByRole("button", { name: "Undo" })).toBeTruthy();

  // Focus passing through another message does not select it; its own reply key answers it.
  const other = article(h, "new");
  act(() => {
    other.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  });
  expect(selected().textContent).toContain("old original body");
  press(other, "r", { metaKey: true });
  await eventually(() =>
    expect(payloads(h, "ComposeMessage").at(-1)).toMatchObject({ id: h.id("new"), mode: "reply" }),
  );
  press(article(h, "old"), "r", { metaKey: true });
  await eventually(() =>
    expect(payloads(h, "ComposeMessage").at(-1)).toMatchObject({ id: h.id("old"), mode: "reply" }),
  );

  // Once the chosen message leaves the thread, the window's own message takes over and find closes.
  h.server.messages.delete("old");
  await h.run(h.m.sync());
  await eventually(() => expect(selected().textContent).toContain("new original body"));
  expect(findField()).toBeNull();
});

/** A form inside a message: a jsdom iframe is another realm, as the message frame is. */
function messageForm() {
  const element = document.createElement("iframe");
  element.setAttribute("sandbox", "allow-same-origin");
  document.body.append(element);
  const frameDoc = element.contentDocument;
  if (!frameDoc) throw new Error("Missing message frame");
  frameDoc.body.innerHTML = "<p>Body</p><input>";
  const input = frameDoc.querySelector("input");
  if (!input) throw new Error("Missing frame input");
  expect(input instanceof Element).toBe(false);
  // The message frame forwards its document's keydown events to the reader.
  frameDoc.addEventListener("keydown", (event) => frame.keys?.(event));
  return { element, body: frameDoc.body, input };
}

it("window keys pressed in the message frame open compose, a new window and settings", async () => {
  const h = await threadWindow([message("only", 1000, { bodyHtml: "<p>body</p>" })], "only");
  await eventually(() => expect(frame.keys).toBeDefined());
  for (const [key, shiftKey, tag] of [
    ["n", false, "ComposeNew"],
    ["N", true, "NewWindow"],
    [",", false, "OpenSettings"],
  ] as const) {
    const event = new KeyboardEvent("keydown", { key, metaKey: true, shiftKey, cancelable: true });
    act(() => frame.keys?.(event));
    expect(event.defaultPrevented).toBe(true);
    await eventually(() => expect(h.requests.at(-1)?.tag).toBe(tag));
  }
});

it("keys typed into a form field inside the message frame do not run reader shortcuts", async () => {
  const h = await threadWindow([message("only", 1000, { bodyHtml: "<p>Body</p>" })], "only");
  await eventually(() => expect(frame.keys).toBeDefined());
  const form = messageForm();
  try {
    expect(press(form.input, "r", { metaKey: true }).defaultPrevented).toBe(false);
    expect(press(form.input, "f", { metaKey: true }).defaultPrevented).toBe(false);
    await wait(50);
    expect(payloads(h, "ComposeMessage")).toEqual([]);
    expect(findField()).toBeNull();
    expect(press(form.body, "r", { metaKey: true }).defaultPrevented).toBe(true);
    await eventually(() =>
      expect(payloads(h, "ComposeMessage")).toEqual([
        { id: h.id("only"), mode: "reply", asAttachment: false },
      ]),
    );
  } finally {
    form.element.remove();
  }
});

it("list keys pressed in the message frame reach the window's mail shortcuts", async () => {
  current = await flow({
    prefs: { shortcutSet: "mimestream" },
    messages: [
      incoming("one", { bodyHtml: "<p>Body one</p>" }),
      incoming("two", { bodyHtml: "<p>Body two</p>" }),
    ],
  });
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  fireEvent.click(row(h.id("one")));
  await eventually(() => expect(selected()).toBeTruthy());
  await eventually(() => expect(frame.keys).toBeDefined());
  const form = messageForm();
  try {
    // Next message.
    expect(press(form.body, "ArrowDown").defaultPrevented).toBe(true);
    await eventually(() => expect(selected().getAttribute("data-message-id")).toBe(h.id("two")));
    // Copying selected message text stays with the frame.
    expect(press(form.body, "c", { metaKey: true }).defaultPrevented).toBe(false);
    // Arrow keys in a field move its caret.
    expect(press(form.input, "ArrowDown").defaultPrevented).toBe(false);
    await wait(50);
    expect(selected().getAttribute("data-message-id")).toBe(h.id("two"));
    // Archive.
    expect(press(form.body, "a", { metaKey: true, ctrlKey: true }).defaultPrevented).toBe(true);
    await eventually(() =>
      expect(h.server.pushed).toContainEqual(
        expect.objectContaining({
          providerId: "two",
          op: expect.objectContaining({ kind: "archive" }),
        }),
      ),
    );
  } finally {
    form.element.remove();
  }
});

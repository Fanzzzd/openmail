import { act, fireEvent, screen, within } from "@testing-library/react/pure";
import { afterEach, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { SETTLE_MS } from "../routes/router";
import { advance, eventually, flow, incoming, key, row } from "./harness";

let current: Awaited<ReturnType<typeof flow>> | undefined;
afterEach(async () => {
  await current?.dispose();
  current = undefined;
});

const title = () => screen.getByRole("heading", { level: 1 }).textContent;
const mailboxes = () => screen.getAllByRole("navigation", { name: "Mailboxes" })[0]!;

it("renders the view a route names and follows navigation, Back and Forward", async () => {
  current = await flow({ route: "/mail/all/starred" });
  const h = current;
  await eventually(() => expect(title()).toBe("Starred"));
  await act(() => h.router.navigate({ href: "/mail/all/sent" }));
  await eventually(() => expect(title()).toBe("Sent"));
  fireEvent.click(within(mailboxes()).getByRole("button", { name: /^Inbox/ }));
  await eventually(() => expect(title()).toBe("Inbox"));
  expect(h.href()).toBe("/mail/all/inbox");
  act(() => h.router.history.back());
  await eventually(() => expect(title()).toBe("Sent"));
  act(() => h.router.history.back());
  await eventually(() => expect(title()).toBe("Starred"));
  act(() => h.router.history.forward());
  await eventually(() => expect(title()).toBe("Sent"));
});

it("falls back to defaults for invalid params and unknown mailboxes", async () => {
  current = await flow({ route: "/mail/all/nowhere?scope=everywhere&dialog=root" });
  const h = current;
  await eventually(() => expect(title()).toBe("Inbox"));
  expect(h.href()).toBe("/mail/all/inbox");
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("opens the search a route names and commits typed searches with replace", async () => {
  current = await flow({ route: "/mail/all/inbox?q=Original+one" });
  const h = current;
  const field = await screen.findByLabelText("Search mail");
  await eventually(() =>
    expect(field).toHaveProperty("value", expect.stringContaining("Original one")),
  );
  const length = h.router.history.length;
  fireEvent.change(field, { target: { value: "Original two" } });
  await eventually(() => expect(h.href()).toBe("/mail/all/inbox?q=Original+two"));
  expect(h.router.history.length).toBe(length);
  fireEvent.change(field, { target: { value: "" } });
  await eventually(() => expect(h.href()).toBe("/mail/all/inbox"));
});

it("a search link whose last word is one character runs it whole", async () => {
  current = await flow({
    route: "/mail/all/inbox?q=plan+b",
    messages: ["a", "b", "c"].map((letter) => incoming(letter, { subject: `plan ${letter}` })),
  });
  const h = current;
  const field = await screen.findByLabelText("Search mail");
  await eventually(() => expect(row(h.id("b"))).toBeTruthy());
  await eventually(() =>
    expect(
      [...document.querySelectorAll<HTMLElement>("[data-id]")].map((e) => e.dataset.id),
    ).toEqual([h.id("b")]),
  );
  expect(field).toHaveProperty("value", expect.stringContaining("plan b"));
});

it("opens the thread a route names and keeps the open thread in the route", async () => {
  const h = (current = await flow({ route: "/mail/all/inbox" }));
  await act(() =>
    h.router.navigate({ href: `/mail/all/inbox?thread=${encodeURIComponent(h.id("two"))}` }),
  );
  await eventually(() =>
    expect(screen.getByRole("article", { name: /^Selected message/ }).textContent).toContain(
      "Original two",
    ),
  );
  expect(row(h.id("two")).getAttribute("aria-selected")).toBe("true");
  const length = h.router.history.length;
  fireEvent.click(row(h.id("one")));
  await eventually(() =>
    expect(h.href().startsWith(`/mail/all/inbox?thread=${encodeURIComponent(h.id("one"))}`)).toBe(
      true,
    ),
  );
  expect(h.router.history.length).toBe(length);
  fireEvent.click(within(mailboxes()).getByRole("button", { name: "Sent" }));
  await eventually(() => expect(h.href()).toBe("/mail/all/sent"));
  act(() => h.router.history.back());
  await eventually(() => expect(row(h.id("one")).getAttribute("aria-selected")).toBe("true"));
  expect(screen.getByRole("article", { name: /^Selected message/ }).textContent).toContain(
    "Original one",
  );
});

// Browser history folded the selection's waiting replace into the next push, so Back after a
// quick folder switch returned to the inbox without the thread just selected.
it("Back after a quick folder switch returns to the thread just selected, in window history", async () => {
  const h = (current = await flow({ route: "/mail/all/inbox", windowHistory: true }));
  fireEvent.click(row(h.id("one")));
  fireEvent.click(within(mailboxes()).getByRole("button", { name: "Sent" }));
  await eventually(() => expect(h.href()).toBe("/mail/all/sent"));
  act(() => h.router.history.back());
  await eventually(() => expect(row(h.id("one")).getAttribute("aria-selected")).toBe("true"));
  expect(h.href()).toBe(`/mail/all/inbox?thread=${encodeURIComponent(h.id("one"))}`);
});

it("opens the dialog a route names, and closing it leaves the route in place", async () => {
  const h = (current = await flow({ route: "/mail/all/sent?dialog=settings" }));
  // Settings is a lazy chunk; its first import in a cold jsdom run can take over a second.
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  const length = h.router.history.length;
  fireEvent.keyDown(settings, { key: "Escape" });
  await eventually(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull());
  await eventually(() => expect(h.href()).toBe("/mail/all/sent"));
  expect(h.router.history.length).toBe(length);
  await h.event({ _tag: "Command", command: "help" });
  await eventually(() => expect(h.href()).toBe("/mail/all/sent?dialog=help"));
  expect(h.router.history.length).toBe(length);
});

it("Navigate events move only between mail routes and open their thread", async () => {
  const h = (current = await flow());
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  const start = h.href();
  for (const href of [
    "https://evil.example/mail/all/inbox",
    "//evil.example/mail/all/inbox",
    "javascript:alert(1)",
    "/thread/x?single=1",
    "/compose/draft",
  ]) {
    await h.event({ _tag: "Navigate", href });
    expect(h.href()).toBe(start);
  }
  const href = `/mail/all/all?account=${encodeURIComponent(h.account.id)}&thread=${encodeURIComponent(h.id("two"))}`;
  await h.event({ _tag: "Navigate", href });
  await eventually(() => expect(title()).toContain("All Mail"));
  // The reader adds the message it focuses in the thread.
  expect(h.href().startsWith(href)).toBe(true);
  await eventually(() => expect(row(h.id("two")).getAttribute("aria-selected")).toBe("true"));
  act(() => h.router.history.back());
  await eventually(() => expect(h.href()).toBe(start));
});

it("⌘[ and ⌘] go Back and Forward between views", async () => {
  const h = (current = await flow({ route: "/mail/all/inbox" }));
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  fireEvent.click(within(mailboxes()).getByRole("button", { name: "Starred" }));
  await eventually(() => expect(title()).toBe("Starred"));
  key("[", { metaKey: true }, document.body);
  await eventually(() => expect(title()).toBe("Inbox"));
  expect(h.href()).toBe("/mail/all/inbox");
  key("]", { metaKey: true }, document.body);
  await eventually(() => expect(title()).toBe("Starred"));
  // Typing keeps the brackets for the field.
  const field = screen.getByLabelText("Search mail");
  field.focus();
  key("[", { metaKey: true }, field);
  expect(title()).toBe("Starred");
});

it("writes the URL once after rapid selection moves settle", async () => {
  const h = (current = await flow({ route: "/mail/all/inbox" }));
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  row(h.id("one")).focus();
  const push = vi.spyOn(h.router.history, "push");
  const replace = vi.spyOn(h.router.history, "replace");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  // 21 moves inside one settle window, far more than the writes allowed below. An odd count
  // ends on the second row, so the one write carries the last move.
  for (let i = 0; i < 21; i++) act(() => key(i % 2 ? "ArrowUp" : "ArrowDown"));
  await advance(SETTLE_MS + 50);
  await eventually(() => expect(h.href()).toContain(`thread=${encodeURIComponent(h.id("two"))}`));
  expect(push).not.toHaveBeenCalled();
  expect(replace.mock.calls.length).toBeLessThanOrEqual(3);
  // A folder switch still writes at once and keeps its Back entry.
  fireEvent.click(within(mailboxes()).getByRole("button", { name: "Sent" }));
  expect(push).toHaveBeenCalledTimes(1);
  act(() => h.router.history.back());
  await eventually(() => expect(title()).toBe("Inbox"));
});

it("drops a search typed but not committed when Back leaves the route", async () => {
  const h = (current = await flow({ route: "/mail/all/starred" }));
  await eventually(() => expect(title()).toBe("Starred"));
  fireEvent.click(within(mailboxes()).getByRole("button", { name: /^Inbox/ }));
  await eventually(() => expect(title()).toBe("Inbox"));
  const field = await screen.findByLabelText("Search mail");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  fireEvent.change(field, { target: { value: "Original" } });
  act(() => h.router.history.back());
  await eventually(() => expect(title()).toBe("Starred"));
  expect(field).toHaveProperty("value", "");
  // Past the search debounce and the URL settle: nothing pending writes the search back.
  await advance(600);
  expect(h.href()).toBe("/mail/all/starred");
});

it("says when a link's message can't be opened", async () => {
  const h = (current = await flow());
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  await h.event({ _tag: "LinkError", reason: "missing" });
  await eventually(() =>
    expect(document.body.textContent).toContain(
      "Can't open the message: It is no longer stored here and has no web link.",
    ),
  );
});

it("each menu command opens its own dialog or route, and nothing else", async () => {
  const h = (current = await flow({ route: "/mail/all/sent" }));
  await eventually(() => expect(title()).toBe("Sent"));
  const close = async () => {
    await act(() => h.router.navigate({ href: "/mail/all/sent" }));
    await eventually(() => expect(h.href()).toBe("/mail/all/sent"));
  };
  for (const [command, href] of [
    ["feedback", "/mail/all/sent?dialog=feedback"],
    ["help", "/mail/all/sent?dialog=help"],
    ["settings", "/mail/all/sent?dialog=settings"],
  ] as const) {
    await h.event({ _tag: "Command", command });
    await eventually(() => expect(h.href()).toBe(href));
    await close();
  }
  await h.event({ _tag: "Command", command: "inbox" });
  await eventually(() => expect(title()).toBe("Inbox"));
  expect(h.href()).toBe("/mail/all/inbox");
  await h.event({ _tag: "Command", command: "compose" });
  await eventually(() => expect(screen.getByRole("textbox", { name: "Subject" })).toBeTruthy());
  expect(h.href()).toBe("/mail/all/inbox");
});

it("a failed server search says the results are local, names the account and can try again", async () => {
  let calls = 0;
  const h = (current = await flow({
    route: "/mail/all/inbox?q=Original",
    handlers: {
      SearchServer: () =>
        Effect.succeed({
          threads: [],
          truncated: false,
          errors:
            ++calls === 1
              ? [
                  {
                    accountId: "gmail:me@gmail.com",
                    message: "The server couldn't complete this search.",
                  },
                ]
              : [],
        }),
    },
  }));
  const alert = await screen.findByText(
    "Showing results from this Mac. me@gmail.com couldn't search the server.",
    undefined,
  );
  expect(alert.closest('[role="alert"]')).toBeTruthy();
  expect(alert.className).not.toContain("truncate");
  // The end of the list says it has only this Mac's results.
  await eventually(() => expect(screen.getByText("No more messages on this Mac")).toBeTruthy());
  expect(screen.queryByText("No more messages")).toBeNull();
  expect(h.account.id).toBe("gmail:me@gmail.com");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await eventually(() => expect(calls).toBe(2));
  await eventually(() => expect(screen.queryByText(/couldn't search the server/)).toBeNull());
  await eventually(() => expect(screen.getByText("No more messages")).toBeTruthy());
});

it("the Go menu opens mailboxes and steps back and forward through views", async () => {
  const h = (current = await flow({ route: "/mail/all/inbox" }));
  await eventually(() => expect(title()).toBe("Inbox"));
  const go = (action: "goStarred" | "goSpam" | "goBack" | "goForward") =>
    h.event({ _tag: "NativeAction", action, triggeredByAccelerator: true });
  await go("goStarred");
  await eventually(() => expect(title()).toBe("Starred"));
  await go("goSpam");
  await eventually(() => expect(title()).toBe("Spam"));
  await go("goBack");
  await eventually(() => expect(title()).toBe("Starred"));
  await go("goForward");
  await eventually(() => expect(title()).toBe("Spam"));
});

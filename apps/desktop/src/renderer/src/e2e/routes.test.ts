import { act, fireEvent, screen, within } from "@testing-library/react/pure";
import { afterEach, expect, it } from "vitest";
import { eventually, flow, key, row } from "./harness";

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

it("opens the thread a route names and keeps the open thread in the route", async () => {
  const h = (current = await flow({ route: "/mail/all/inbox" }));
  await act(() =>
    h.router.navigate({ href: `/mail/all/inbox?thread=${encodeURIComponent(h.id("two"))}` }),
  );
  await eventually(() =>
    expect(screen.getByRole("article", { name: "Selected message" }).textContent).toContain(
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
  expect(screen.getByRole("article", { name: "Selected message" }).textContent).toContain(
    "Original one",
  );
});

it("opens the dialog a route names, and closing it leaves the route in place", async () => {
  const h = (current = await flow({ route: "/mail/all/sent?dialog=settings" }));
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  const length = h.router.history.length;
  fireEvent.keyDown(settings, { key: "Escape" });
  await eventually(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull());
  expect(h.href()).toBe("/mail/all/sent");
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

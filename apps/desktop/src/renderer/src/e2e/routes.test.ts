import { act, fireEvent, screen, within } from "@testing-library/react/pure";
import { afterEach, expect, it } from "vitest";
import { eventually, flow } from "./harness";

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

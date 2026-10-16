import axe from "axe-core";
import { afterEach, expect, it } from "vitest";
import { act, fireEvent, screen, within } from "@testing-library/react/pure";
import { eventually, flow, key, row } from "./harness";

let current: Awaited<ReturnType<typeof flow>> | undefined;
afterEach(async () => {
  await current?.dispose();
  current = undefined;
});

it("Copy to folders… in a conversation's menu is a menu item the arrow keys reach, and Enter opens its form", async () => {
  current = await flow({ provider: "imap" });
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  const target = row(h.id("one"));
  target.focus();
  fireEvent.keyDown(target, { key: "F10", shiftKey: true });
  const menu = await screen.findByRole("menu", { name: "Conversation actions" });
  let violations: axe.Result[] = [];
  await act(async () => {
    violations = (await axe.run(menu, { rules: { "color-contrast": { enabled: false } } }))
      .violations;
  });
  expect(
    violations
      .filter((issue) => issue.impact === "serious" || issue.impact === "critical")
      .map((issue) => issue.id),
  ).toEqual([]);
  const copy = within(menu).getByRole("menuitem", { name: "Copy to folders…" });
  for (let step = 0; step < 40 && document.activeElement !== copy; step++) key("ArrowDown");
  expect(document.activeElement).toBe(copy);
  key("Enter");
  const form = await screen.findByRole("dialog", { name: "Copy to folders…" });
  await eventually(() => expect(screen.queryByRole("menu")).toBeNull());
  fireEvent.click(within(form).getByRole("checkbox", { name: "Work" }));
  fireEvent.click(within(form).getByRole("button", { name: "Copy" }));
  await eventually(() =>
    expect(screen.queryByRole("dialog", { name: "Copy to folders…" })).toBeNull(),
  );
  await eventually(() =>
    expect(JSON.stringify(h.requests.map((request) => request.payload))).toContain('"copy"'),
  );
});

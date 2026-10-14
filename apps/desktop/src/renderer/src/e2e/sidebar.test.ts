import { afterEach, expect, it } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react/pure";
import { flow, eventually } from "./harness";
import { scaledMs } from "../../../../../../packages/core/test-support/test-time.js";
let current: Awaited<ReturnType<typeof flow>> | undefined;
afterEach(async () => {
  await current?.dispose();
  current = undefined;
});

it("label unnest drop zone appears only during its account drag and clears on cancel and drop", async () => {
  current = await flow();
  const h = current;
  await h.run(h.m.accounts.connect({ provider: "outlook" }));
  await eventually(() =>
    expect(screen.getByRole("button", { name: /me@outlook.com/ })).toBeTruthy(),
  );
  await eventually(() => expect(screen.getByRole("button", { name: "Work" })).toBeTruthy());
  expect(screen.queryByRole("button", { name: /No parent/ })).toBeNull();
  const data = new Map<string, string>();
  const dataTransfer = {
    types: [],
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
    effectAllowed: "",
  };
  fireEvent.dragStart(screen.getByRole("button", { name: "Work" }), { dataTransfer });
  const zone = await screen.findByRole("button", { name: /No parent/ });
  expect(screen.getAllByRole("button", { name: /No parent/ })).toHaveLength(1);
  expect(zone.textContent).toContain("me@gmail.com");
  expect(zone.className).toContain("border-dashed");
  fireEvent.dragEnd(screen.getByRole("button", { name: "Work" }));
  expect(screen.queryByRole("button", { name: /No parent/ })).toBeNull();
  fireEvent.dragStart(screen.getByRole("button", { name: "Work" }), { dataTransfer });
  fireEvent.drop(await screen.findByRole("button", { name: /No parent/ }), { dataTransfer });
  expect(screen.queryByRole("button", { name: /No parent/ })).toBeNull();
  await eventually(() =>
    expect(h.requests.some((request) => request.tag === "ChangeLabel")).toBe(true),
  );
});

it("Shift+F10 opens a label menu that moves a nested label to the top level", async () => {
  current = await flow();
  const h = current;
  h.server.labels = [{ id: "Label_work", name: "Parent/Child", color: null }];
  await h.run(h.m.sync.sync());
  await eventually(() => expect(screen.getByRole("button", { name: "Parent/Child" })).toBeTruthy());
  const label = screen.getByRole("button", { name: "Parent/Child" });
  label.focus();
  fireEvent.keyDown(label, { key: "F10", shiftKey: true });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Move to top level" }));
  await eventually(() => expect(h.server.labels[0]?.name).toBe("Child"));
  await eventually(() => expect(screen.getByRole("button", { name: "Child" })).toBeTruthy());
  expect(screen.queryByRole("button", { name: /No parent/ })).toBeNull();
});

it("top-level labels have no Move to top level menu action", async () => {
  current = await flow();
  await eventually(() => expect(screen.getByRole("button", { name: "Work" })).toBeTruthy());
  const label = screen.getByRole("button", { name: "Work" });
  fireEvent.contextMenu(label);
  expect(screen.queryByRole("menuitem", { name: "Move to top level" })).toBeNull();
  label.focus();
  fireEvent.keyDown(label, { key: "F10", shiftKey: true });
  expect(screen.queryByRole("menuitem", { name: "Move to top level" })).toBeNull();
  expect(current.requests.some((request) => request.tag === "ChangeLabel")).toBe(false);
});

it("favorite stars are named toggles off the tab order; in All accounts the menu favorites every account", async () => {
  current = await flow();
  const h = current;
  await h.run(h.m.accounts.connect({ provider: "outlook" }));
  await eventually(() =>
    expect(screen.getByRole("button", { name: /me@outlook.com/ })).toBeTruthy(),
  );
  const star = screen.getByRole("button", { name: "Favorite Inbox in all accounts" });
  expect(star.tabIndex).toBe(-1);
  expect(star.getAttribute("aria-pressed")).toBe("false");
  // The row's controls wait for the pointer or focus on the row, in place of its count, so every
  // count ends at the same edge.
  expect(star.parentElement?.className).toContain("opacity-0");
  expect(star.parentElement?.className).toContain("group-hover/item:opacity-100");
  expect(star.parentElement?.className).toContain("absolute");
  const count = screen
    .getByRole("button", { name: /^Inbox/ })
    .querySelector("[data-sidebar-count]");
  if (count) expect(count.className).toContain("group-hover/item:invisible");
  expect(screen.getByRole("button", { name: "Favorite Work" }).tabIndex).toBe(-1);

  const inbox = screen.getByRole("button", { name: /^Inbox/ });
  inbox.focus();
  fireEvent.keyDown(inbox, { key: "F10", shiftKey: true });
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Add to favorites in all accounts" }),
  );
  await eventually(() =>
    expect(
      h.requests
        .filter((request) => request.tag === "SetLabelPreference")
        .map((request) => JSON.stringify(request.payload)),
    ).toHaveLength(2),
  );
  await eventually(() =>
    expect(
      screen
        .getByRole("button", { name: "Favorite Inbox in all accounts" })
        .getAttribute("aria-pressed"),
    ).toBe("true"),
  );
  // One Inbox per account, told apart by the account.
  expect(screen.getAllByRole("button", { name: /^Inbox \(/ })).toHaveLength(2);
});

it("with no account the sidebar lists no mailboxes and no sync status, and Add account starts on Gmail", async () => {
  current = await flow({ noAccounts: true });
  const dialog = await screen.findByRole(
    "dialog",
    { name: "Add your first account" },
    { timeout: scaledMs(5000) },
  );
  await eventually(() =>
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Gmail" })),
  );
  expect(dialog.contains(document.activeElement)).toBe(true);
  expect(screen.queryByRole("button", { name: /^Inbox/, hidden: true })).toBeNull();
  expect(screen.queryByRole("button", { name: "Sync now", hidden: true })).toBeNull();
  expect(document.body.textContent).not.toMatch(/Synced|Syncing/);
  // Behind the dialog, the sidebar names the state as the main pane does and offers Add account.
  expect(document.body.textContent).toContain("No email accounts yet.");
  expect(document.body.textContent).not.toContain("This space has no accounts yet.");
  const nav = screen.getByRole("navigation", { name: "Mailboxes", hidden: true });
  expect(within(nav).getByRole("button", { name: "Add account", hidden: true })).toBeTruthy();
});

// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AsyncResult } from "effect/reactivity";
import type { Profile } from "../../../shared/api";
import { UndoHistory } from "../features/undo/UndoHistory";
import { ProfileEditor } from "../features/accounts/ProfileEditor";
import { ProfileSwitcher } from "../features/accounts/ProfileSettings";
import { DropdownMenu, MenuItem } from "../ui/Menu";
import { Select } from "../ui/Select";
import { closeSheet } from "../ui/open-surfaces";
import {
  account,
  localized,
  audit,
  registerAccessibilityHooks,
} from "../test-support/accessibility-fixtures";

vi.hoisted(() => {
  vi.resetModules();
});
vi.mock("@effect/atom-react", async (original) =>
  (await import("../test-support/accessibility-fixtures")).atomReactMock(await original()),
);
vi.mock(
  "../state/queries",
  async () => (await import("../test-support/accessibility-fixtures")).queriesMock,
);
vi.mock("../state/mutations", async () => {
  const { Atom } = await import("effect/reactivity");
  const { Cause } = await import("effect");
  const { mutationsMock } = await import("../test-support/accessibility-fixtures");
  // A save that failed, so the name field shows its error.
  return {
    ...mutationsMock,
    saveProfileAtom: Atom.make(AsyncResult.failure(Cause.die("save"))),
  };
});
vi.mock("../state/downloads", async () =>
  (await import("../test-support/accessibility-fixtures")).downloadsMock(),
);
vi.mock("../state/remote-access", async () =>
  (await import("../test-support/accessibility-fixtures")).remoteAccessMock(),
);
vi.mock(
  "../state/rpc",
  async () => (await import("../test-support/accessibility-fixtures")).rpcMock,
);
vi.mock(
  "../state/mail",
  async () => (await import("../test-support/accessibility-fixtures")).mailMock,
);

registerAccessibilityHooks(import.meta.url);

const spaces: Profile[] = [
  { id: "work", name: "Work", icon: "💼", color: "blue", position: 0 },
  { id: "home", name: "Home", icon: "🏠", color: "emerald", position: 1 },
];

it("names each menu for what it holds, not as More actions", async () => {
  render(
    localized(
      h(
        "main",
        null,
        h(DropdownMenu, {
          label: "Folder actions",
          trigger: h("button", { type: "button" }, "Open"),
          children: h(MenuItem, { onClick: vi.fn(), children: "Mark all as read" }),
        }),
      ),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  const menu = await screen.findByRole("menu", { name: "Folder actions" });
  // The positioner keeps its presentation role; the label sits on the menu and its wrapper.
  expect(menu.parentElement?.tagName).toBe("SECTION");
  expect(menu.parentElement?.parentElement?.getAttribute("aria-label")).toBeNull();
  expect(screen.queryByLabelText("More actions")).toBeNull();
  await audit();
});

it("labels the Undo history menu with its own name", async () => {
  render(localized(h("main", null, h(UndoHistory, { entries: [], onUndo: vi.fn() }))));
  fireEvent.click(screen.getByRole("button", { name: "Undo history" }));
  expect(await screen.findByRole("menu", { name: "Undo history" })).toBeTruthy();
  await audit();
});

it("Close window closes an open dropdown menu, then a Select list, before the window", async () => {
  render(
    localized(
      h("div", null, [
        h(DropdownMenu, {
          key: "menu",
          label: "Folder actions",
          trigger: h("button", { type: "button" }, "Open menu"),
          children: h(MenuItem, { onClick: vi.fn(), children: "Item" }),
        }),
        h(Select, {
          key: "select",
          "aria-label": "Pick",
          value: "a",
          options: [
            { value: "a", label: "Alpha" },
            { value: "b", label: "Beta" },
          ],
          onValueChange: vi.fn(),
        }),
      ]),
    ),
  );
  const closeWindow = vi.fn();
  fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
  await screen.findByRole("menu");
  closeSheet(closeWindow);
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(closeWindow).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("combobox", { name: "Pick" }));
  await screen.findByRole("listbox");
  closeSheet(closeWindow);
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  expect(closeWindow).not.toHaveBeenCalled();

  closeSheet(closeWindow);
  expect(closeWindow).toHaveBeenCalledOnce();
});

it("marks the space name invalid and points it at the error while one shows", async () => {
  render(localized(h(ProfileEditor, { accounts: [account], profiles: spaces, onClose: vi.fn() })));
  const input = screen.getByRole("textbox", { name: "Name, like Work" });
  const alert = screen.getByRole("alert");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(input.getAttribute("aria-describedby")).toBe(alert.id);
  expect(alert.id).not.toBe("");
  await audit();
});

it("puts the space picker in the banner landmark with two spaces", async () => {
  render(localized(h(ProfileSwitcher, { profiles: spaces, value: "work", onChange: vi.fn() })));
  const banner = screen.getByRole("banner");
  expect(banner.contains(screen.getByRole("combobox", { name: "Space" }))).toBe(true);
  await audit();
});

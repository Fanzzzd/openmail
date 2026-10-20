// @vitest-environment jsdom
import { expect, it, onTestFinished, vi } from "vitest";
import { createElement as h, useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import type { Profile } from "../../../shared/api";
import { UndoHistory } from "../features/undo/UndoHistory";
import { ProfileEditor } from "../features/accounts/ProfileEditor";
import { TextContextMenu } from "../app/WindowUi";
import { RecipientField } from "../features/compose/components/RecipientField";
import { SearchField } from "../features/search/SearchField";
import { restoreSearchReturn } from "../features/search/search-return";
import {
  ContextMenuContent,
  ContextMenuRoot,
  ContextMenuTrigger,
  DropdownMenu,
  MenuItem,
} from "../ui/Menu";
import { Select } from "../ui/Select";
import { closeSheet } from "../ui/open-surfaces";
import {
  account,
  fixture,
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
  const { Effect } = await import("effect");
  const { mutationsMock } = await import("../test-support/accessibility-fixtures");
  // A save that fails, so the name field shows its error.
  return {
    ...mutationsMock,
    saveProfileAtom: Atom.fn(() => Effect.die("save")),
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

/** Close window with `role` open: the surface closes and the window stays. */
async function closeSheetClosesFirst(role: "menu" | "listbox") {
  const closeWindow = vi.fn();
  closeSheet(closeWindow);
  await waitFor(() => expect(screen.queryByRole(role)).toBeNull());
  expect(closeWindow).not.toHaveBeenCalled();
}

/** Types into a combobox. Base UI opens the list for typed input only, not for autofill. */
const typeInto = (input: HTMLElement, value: string) =>
  fireEvent.input(input, { target: { value }, inputType: "insertText" });

it("Close window closes an open context menu before the window", async () => {
  render(
    localized(
      h(ContextMenuRoot, null, [
        h(ContextMenuTrigger, { key: "trigger" }, "Message row"),
        h(ContextMenuContent, {
          key: "content",
          label: "Message actions",
          children: h(MenuItem, { onClick: vi.fn(), children: "Archive" }),
        }),
      ]),
    ),
  );
  fireEvent.contextMenu(screen.getByText("Message row"));
  await screen.findByRole("menu", { name: "Message actions" });
  await closeSheetClosesFirst("menu");
});

it("Close window closes the text context menu before the window", async () => {
  const menu = {
    x: 10,
    y: 10,
    misspelledWord: "",
    suggestions: [],
    spellcheck: true,
    canCut: true,
    canCopy: true,
    canPaste: true,
    writingTools: false,
  };
  const Field = () => {
    const [shown, setShown] = useState(true);
    return shown
      ? h(TextContextMenu, { menu, onCommand: vi.fn(), onClosed: () => setShown(false) })
      : null;
  };
  render(localized(h(Field)));
  await screen.findByRole("menu", { name: "Text actions" });
  await closeSheetClosesFirst("menu");
});

it("Close window closes the search suggestions before the window", async () => {
  const Field = () => {
    const [value, setValue] = useState("");
    return h(SearchField, {
      value,
      onChange: setValue,
      onEnterResults: vi.fn(),
      inputRef: null,
    });
  };
  render(localized(h(Field)));
  typeInto(screen.getByRole("combobox", { name: "Search mail" }), "from");
  await screen.findByRole("listbox");
  await closeSheetClosesFirst("listbox");
});

it("Close window closes the recipient suggestions before the window", async () => {
  fixture.values.set("suggestionsAtom", [{ name: "Bob", address: "bob@example.com" }]);
  const Field = () => {
    const [value, setValue] = useState("");
    return h(RecipientField, {
      label: "To",
      value,
      onChange: setValue,
      from: account.email,
      showFullAddresses: false,
    });
  };
  render(localized(h(Field)));
  typeInto(screen.getByRole("combobox", { name: "To" }), "bo");
  await screen.findByRole("option", { name: /bob@example\.com/ });
  await closeSheetClosesFirst("listbox");
});

// The list's name sat on Base UI's presentation popup (aria-prohibited-attr), and each option held
// a Stop suggesting button (nested-interactive) with no keyboard path of its own.
it("recipient suggestions pass axe, and forward Delete stops suggesting the highlighted one", async () => {
  fixture.values.set("suggestionsAtom", [{ name: "Bob", address: "bob@example.com" }]);
  const Field = () => {
    const [value, setValue] = useState("");
    return h(RecipientField, {
      label: "To",
      value,
      onChange: setValue,
      from: account.email,
      showFullAddresses: false,
    });
  };
  render(localized(h("main", null, h(Field))));
  const input = screen.getByRole("combobox", { name: "To" });
  typeInto(input, "bo");
  const option = await screen.findByRole("option", { name: /bob@example\.com/ });
  expect(screen.getByRole("listbox", { name: "To suggestions" })).toBeTruthy();
  expect(option.getAttribute("aria-describedby")).toBeTruthy();
  expect(document.getElementById(option.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
    "Press Fn-Delete to stop suggesting this address.",
  );
  // The popup portals to body, outside the landmarks, so the region rule is left out here.
  const result = await axe.run(document.body, {
    rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
  });
  expect(result.violations.map((issue) => issue.id)).toEqual([]);
  await waitFor(() => expect(input.getAttribute("aria-activedescendant")).toBe(option.id));
  fireEvent.keyDown(input, { key: "Backspace", shiftKey: true });
  expect(fixture.decide).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Delete", shiftKey: true });
  expect(fixture.decide).toHaveBeenCalledWith(
    expect.objectContaining({ payload: { address: "bob@example.com", hidden: true } }),
  );
  expect(input).toHaveProperty("value", "bo");
  expect(await screen.findAllByText("Stopped suggesting bob@example.com")).toHaveLength(1);
  expect(
    screen.getByText("Stopped suggesting bob@example.com. Undo follows this field."),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
});

it("marks the space name invalid and points it at the error while one shows", async () => {
  render(localized(h(ProfileEditor, { accounts: [account], profiles: spaces, onClose: vi.fn() })));
  const input = screen.getByRole("textbox", { name: "Name, like Work" });
  fireEvent.change(input, { target: { value: "Work" } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  const alert = await screen.findByRole("alert");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(input.getAttribute("aria-describedby")).toBe(alert.id);
  expect(alert.id).not.toBe("");
  await audit();
});

const searchChips = (value: string) => {
  const Field = () => {
    const [text, setText] = useState(value);
    return h(SearchField, {
      value: text,
      onChange: setText,
      onEnterResults: vi.fn(),
      inputRef: null,
    });
  };
  render(localized(h("main", null, h(Field))));
};

// Base UI's chip refocused itself on Tab, so Tab from a chip's Modify button came back to it.
it("Tab from the last search chip's Modify button moves on to the input", async () => {
  searchChips("label:Projects from:bob ");
  const input = screen.getByRole("combobox", { name: "Search mail" });
  const modify = screen.getByRole("button", { name: "Modify from:bob" });
  modify.focus();
  const user = userEvent.setup();
  await user.tab();
  expect(document.activeElement).toBe(input);
  await user.tab({ shift: true });
  expect(document.activeElement).toBe(modify);
});

it("names the search chip row and groups each chip under its token", async () => {
  searchChips("label:Projects from:bob ");
  const toolbar = screen.getByRole("toolbar", { name: "Search filters" });
  const groups = within(toolbar).getAllByRole("group");
  expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual([
    "label:Projects",
    "from:bob",
  ]);
  // The Modify and Remove buttons sit inside their chip's group.
  const first = groups[0];
  if (!first) throw new Error("Missing chip group");
  expect(within(first).getByRole("button", { name: "Modify label:Projects" })).toBeTruthy();
  expect(within(first).getByRole("button", { name: "Remove label:Projects" })).toBeTruthy();
  await audit();
});

// Escape in an empty field blurred it and left focus on the page; the field now remembers where
// focus came from.
it("remembers what had focus before the search field and hands it back", () => {
  render(
    localized(
      h("main", null, [
        h("button", { key: "row", type: "button" }, "Row"),
        h(SearchField, {
          key: "field",
          value: "",
          onChange: vi.fn(),
          onEnterResults: vi.fn(),
          inputRef: null,
        }),
      ]),
    ),
  );
  const row = screen.getByRole("button", { name: "Row" });
  const input = screen.getByRole("combobox", { name: "Search mail" });
  row.focus();
  input.focus();
  input.blur();
  expect(document.activeElement).toBe(document.body);
  expect(restoreSearchReturn()).toBe(true);
  expect(document.activeElement).toBe(row);
  // A second restore has nothing left to return to.
  expect(restoreSearchReturn()).toBe(false);
});

// Base UI stopped Escape in a field with chips, so the window never cleared the search.
it("Escape in a search field with a chip reaches the window once the suggestions are closed", async () => {
  searchChips("from:priya ");
  const input = screen.getByRole("combobox", { name: "Search mail" });
  const escapes = vi.fn();
  const listen = (event: KeyboardEvent) => {
    if (event.key === "Escape") escapes(input.getAttribute("aria-expanded"));
  };
  window.addEventListener("keydown", listen);
  onTestFinished(() => window.removeEventListener("keydown", listen));
  input.focus();
  typeInto(input, "from");
  await screen.findByRole("listbox");
  const user = userEvent.setup();
  // The first Escape only closes the suggestions.
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  expect(screen.getByRole("button", { name: "Modify from:priya" })).toBeTruthy();
  expect(escapes).not.toHaveBeenCalledWith("false");
  await user.keyboard("{Escape}");
  expect(escapes).toHaveBeenLastCalledWith("false");
});

// A chip's Remove button takes no Tab stop, so a keyboard user had no way to drop a chip but
// Backspace from the end.
it("the search chip's Modify menu removes the chip and returns focus to the input", async () => {
  searchChips("label:Projects from:bob ");
  const input = screen.getByRole("combobox", { name: "Search mail" });
  screen.getByRole("button", { name: "Modify label:Projects" }).focus();
  const user = userEvent.setup();
  await user.keyboard("{Enter}");
  const menu = await screen.findByRole("menu", { name: "Modify label:Projects" });
  const remove = within(menu).getByRole("menuitem", { name: "Remove filter" });
  await user.keyboard("{End}");
  await waitFor(() => expect(document.activeElement).toBe(remove));
  await user.keyboard("{Enter}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(screen.queryByRole("group", { name: "label:Projects" })).toBeNull();
  expect(screen.getByRole("group", { name: "from:bob" })).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(input));
});

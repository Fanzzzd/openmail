// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createElement as h, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { emptyDraft } from "../features/compose/draft";
import { setPlatform } from "../lib/platform";
import { Composer } from "../features/compose/components/Composer";
import { ComposeToolbar } from "../features/compose/components/ComposeToolbar";
import { RecipientField } from "../features/compose/components/RecipientField";
import {
  fixture,
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
vi.mock(
  "../state/mutations",
  async () => (await import("../test-support/accessibility-fixtures")).mutationsMock,
);
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

for (const standalone of [false, true]) {
  it(`audits the ${standalone ? "full-window" : "floating"} composer and its recipient controls`, async () => {
    render(
      localized(
        h(Composer, {
          standalone,
          draft: {
            ...emptyDraft(account.id),
            to: "alice@example.com",
            cc: "bob@example.com",
            bcc: "carol@example.com",
            attachments: [
              { filename: "agenda.pdf", mimeType: "application/pdf", content: "YWdlbmRh" },
              { filename: "notes.txt", mimeType: "text/plain", content: "bm90ZXM=" },
            ],
          },
          accounts: [account],
          signatureFor: vi.fn(),
          onClose: vi.fn(),
          onDiscard: vi.fn(),
          onSend: vi.fn(),
        }),
      ),
    );
    expect(screen.getByRole("dialog").hasAttribute("data-full-window")).toBe(standalone);
    expect(screen.getByRole("button", { name: "Remove agenda.pdf" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Move notes.txt earlier" }).tabIndex).toBe(0);
    await audit();
  });
}

it("roves the one-row format toolbar and moves groups that do not fit into More formatting", async () => {
  const user = userEvent.setup();
  const toolbarAt = () =>
    render(
      localized(
        h(
          "main",
          null,
          h(ComposeToolbar, {
            leading: null,
            formatting: true,
            disabled: false,
            onFormat: vi.fn(),
            onStyle: vi.fn(),
            onCommand: vi.fn(),
            onLink: vi.fn(),
            more: null,
            shortcutSet: "mimestream",
          }),
        ),
      ),
    );
  toolbarAt();
  const toolbar = screen.getByRole("toolbar", { name: "Formatting" });
  expect(
    [...toolbar.querySelectorAll("button,input")].filter(
      (control) => control.getAttribute("tabindex") === "0",
    ),
  ).toHaveLength(1);
  await user.tab();
  expect(document.activeElement).toBe(within(toolbar).getByRole("button", { name: "Bold" }));
  await user.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(within(toolbar).getByRole("button", { name: "Italic" }));
  await user.keyboard("{End}");
  expect(document.activeElement).toBe(
    within(toolbar).getByRole("button", { name: "More formatting" }),
  );
  expect(within(toolbar).getByRole("button", { name: "Bulleted list" })).toBeTruthy();
  await user.click(within(toolbar).getByRole("button", { name: "Color" }));
  expect(await screen.findByRole("textbox", { name: "Custom hex color" })).toBeTruthy();
  await audit();
  cleanup();

  const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(420);
  try {
    toolbarAt();
    const narrow = screen.getByRole("toolbar", { name: "Formatting" });
    expect(within(narrow).getByRole("button", { name: "Underline" })).toBeTruthy();
    expect(within(narrow).queryByRole("button", { name: "Bulleted list" })).toBeNull();
    expect(within(narrow).queryByRole("button", { name: "Alignment" })).toBeNull();
    await user.click(within(narrow).getByRole("button", { name: "More formatting" }));
    expect(await screen.findByRole("menuitem", { name: /^Bulleted list/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /^Align left/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /^Clear formatting/ })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /^Underline/ })).toBeNull();
  } finally {
    width.mockRestore();
  }
});

it("names recipient actions and exposes removal and moving to keyboard users", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const onMove = vi.fn();
  render(
    localized(
      h(RecipientField, {
        label: "To",
        value: "alice@example.com",
        onChange,
        onMove,
        fieldName: "to",
        from: account.email,
        showFullAddresses: true,
      }),
    ),
  );
  const remove = screen.getByRole("button", { name: "Remove alice@example.com" });
  expect(remove.tabIndex).toBe(-1);
  screen.getByRole("button", { name: "Actions for alice@example.com" }).focus();
  await user.keyboard("{Enter}");
  screen.getByRole("menuitem", { name: "Move to Cc" }).focus();
  await user.keyboard("{Enter}");
  expect(onMove).toHaveBeenCalledWith(0, "cc");
  remove.focus();
  await user.keyboard("{Enter}");
  expect(onChange).toHaveBeenCalledWith("");
});

it("on a touch screen a recipient chip shows the name and opens its menu itself", async () => {
  const user = userEvent.setup();
  setPlatform("web");
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(pointer: coarse)",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  try {
    render(
      localized(
        h(
          "main",
          null,
          h(RecipientField, {
            label: "To",
            value: "Alice Example <alice@example.com>",
            onChange: vi.fn(),
            onMove: vi.fn(),
            fieldName: "to",
            from: account.email,
            showFullAddresses: false,
          }),
        ),
      ),
    );
    expect(screen.queryByRole("button", { name: "Actions for alice@example.com" })).toBeNull();
    const chip = screen.getByRole("button", { name: "Alice Example" });
    expect(chip.getAttribute("title")).toBe("alice@example.com");
    await user.click(chip);
    expect(await screen.findByRole("menuitem", { name: "Move to Cc" })).toBeTruthy();
    await audit();
  } finally {
    setPlatform("desktop");
  }
});

it("lets Escape and composer shortcuts bubble from recipient chip actions", () => {
  const keys = vi.fn();
  render(
    localized(
      h(
        "div",
        { onKeyDown: keys },
        h(RecipientField, {
          label: "To",
          value: "alice@example.com",
          onChange: vi.fn(),
          fieldName: "to",
          from: account.email,
          showFullAddresses: true,
        }),
      ),
    ),
  );
  const actions = screen.getByRole("button", { name: "Actions for alice@example.com" });
  for (const event of [
    { key: "Escape" },
    { key: "s", metaKey: true },
    { key: "Enter", ctrlKey: true },
    { key: "ArrowLeft", altKey: true },
  ]) {
    fireEvent.keyDown(actions, event);
  }
  expect(keys).toHaveBeenCalledTimes(4);
  for (const key of ["Backspace", "Delete", "ArrowLeft", "ArrowRight"])
    fireEvent.keyDown(actions, { key });
  expect(keys).toHaveBeenCalledTimes(4);
});

it("removes recipient chips using Delete and announces the removed address", async () => {
  const user = userEvent.setup();
  function Harness() {
    const [value, setValue] = useState("alice@example.com");
    return localized(
      h(
        "main",
        null,
        h(RecipientField, {
          label: "To",
          value,
          onChange: setValue,
          from: account.email,
          showFullAddresses: true,
        }),
      ),
    );
  }
  render(h(Harness));
  const input = screen.getByRole("combobox", { name: "To" });
  input.focus();
  await user.keyboard("{ArrowLeft}{Delete}");
  expect(screen.queryByRole("button", { name: "Remove alice@example.com" })).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("Removed alice@example.com");
  await audit();
});

it("audits composer send validation and associates the error with recipient fields", async () => {
  render(
    localized(
      h(Composer, {
        draft: emptyDraft(account.id),
        accounts: [account],
        signatureFor: vi.fn(),
        onClose: vi.fn(),
        onDiscard: vi.fn(),
        onSend: vi.fn(),
      }),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  const alert = screen.getByRole("alert");
  expect(alert.textContent).not.toBe("");
  const recipients = screen.getByRole("combobox", { name: "To" });
  expect(recipients.getAttribute("aria-describedby")).toBe(alert.id);
  await audit();
});

it("audits the composer attachment menu and send confirmation using the keyboard", async () => {
  const user = userEvent.setup();
  fixture.values.set("nativeCompose", { photos: true, continuity: true, grammar: false });
  render(
    localized(
      h(Composer, {
        draft: {
          ...emptyDraft(account.id),
          to: "alice@example.com",
          body: { kind: "plain", text: "Hello" },
        },
        accounts: [account],
        signatureFor: vi.fn(),
        onClose: vi.fn(),
        onDiscard: vi.fn(),
        onSend: vi.fn(),
      }),
    ),
  );
  await audit();
  const attach = screen.getByRole("button", { name: "Attach files" });
  attach.focus();
  await user.keyboard("{Enter}");
  await screen.findByRole("menuitem", { name: "Photos" });
  await audit();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(attach));
  screen.getByRole("button", { name: "Send" }).focus();
  await user.keyboard("{Enter}");
  await screen.findByRole("alertdialog");
  await audit();
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Send" })),
  );
});

// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { DEFAULT_PREFS } from "@openmail/core/schema";
import { Settings } from "../features/settings/Settings";
import { ShortcutHelp } from "../features/settings/sections/SystemSettings";
import { AddAccountDialog } from "../features/accounts/AddAccountDialog";
import { FirstRunDone } from "../features/accounts/FirstRunDone";
import {
  fixture,
  account,
  localized,
  audit,
  NO_CLIENTS,
  BUILT_IN_CLIENTS,
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

for (const tab of [
  "general",
  "labs",
  "interactions",
  "accounts",
  "profiles",
  "cache",
  "notifications",
  "shortcuts",
  "signatures",
  "reading",
  "compose",
  "organize",
  "server",
  "ai",
  "log",
] as const) {
  it(`audits the ${tab} settings page`, async () => {
    render(
      localized(
        h(Settings, {
          initialTab: tab,
          accounts: [account],
          onClose: vi.fn(),
          onAddAccount: vi.fn(),
        }),
      ),
    );
    await audit();
  });
}

it("groups the keyboard shortcuts with Triage first and filters them by name or key", async () => {
  render(localized(h(ShortcutHelp, { onClose: vi.fn() })));
  const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
  expect(
    within(dialog)
      .getAllByRole("heading", { level: 3 })
      .map((e) => e.textContent),
  ).toEqual(["Triage", "Navigation", "Reading", "Compose", "Formatting", "Window"]);
  const triage = within(dialog).getByRole("region", { name: "Triage" });
  expect(within(triage).getAllByRole("row")[0]?.textContent).toMatch(/^Archive/);
  const filter = within(dialog).getByRole("searchbox", { name: "Filter shortcuts" });
  fireEvent.change(filter, { target: { value: "reply" } });
  expect(
    within(dialog)
      .getAllByRole("heading", { level: 3 })
      .map((e) => e.textContent),
  ).toEqual(["Compose"]);
  expect(
    within(dialog)
      .getAllByRole("row")
      .map((row) => row.querySelector("td")?.textContent),
  ).toEqual(["Reply", "Reply all"]);
  // A key matches too.
  fireEvent.change(filter, { target: { value: "⌘B" } });
  expect(
    within(dialog)
      .getAllByRole("row")
      .map((row) => row.querySelector("td")?.textContent),
  ).toContain("Bold");
  fireEvent.change(filter, { target: { value: "no such shortcut" } });
  expect(within(dialog).getByRole("status").textContent).toBe("No shortcuts match.");
  await audit();
});

it("AI Access names one setting for AI app changes, with Read only and Ask me first", () => {
  fixture.values.set("agentModeAtom", "propose");
  render(
    localized(
      h(Settings, {
        initialTab: "ai",
        accounts: [account],
        onClose: vi.fn(),
        onAddAccount: vi.fn(),
      }),
    ),
  );
  const group = screen.getByRole("radiogroup", { name: "Changes by AI apps" });
  expect(
    within(group)
      .getAllByRole("radio")
      .map((r) => r.getAttribute("aria-label")),
  ).toEqual(["Read only", "Ask me first"]);
  expect(
    within(group).getByRole("radio", { name: "Ask me first" }).getAttribute("aria-checked"),
  ).toBe("true");
  expect(screen.getByRole("button", { name: "Changes by AI apps" })).toBeTruthy();
  expect(document.body.textContent).not.toMatch(
    /Organize directly|write mode|proposals? turned on/i,
  );
  fixture.values.set("agentModeAtom", "off");
});

it("shows software updates without a GitHub token field", () => {
  render(
    localized(
      h(Settings, {
        initialTab: "general",
        accounts: [account],
        onClose: vi.fn(),
        onAddAccount: vi.fn(),
      }),
    ),
  );
  expect(screen.getByRole("button", { name: "Check for updates" })).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/access token/i);
});

it("audits a custom attachment folder shown read-only with a picker button", async () => {
  fixture.values.set("prefsAtom", {
    ...DEFAULT_PREFS,
    attachmentSaveFolder: { kind: "custom", path: "/Users/me/Mail attachments" },
  });
  render(
    localized(
      h(Settings, {
        initialTab: "reading",
        accounts: [account],
        onClose: vi.fn(),
        onAddAccount: vi.fn(),
      }),
    ),
  );
  const field = screen.getByRole("textbox", { name: "Folder path" });
  expect(field).toHaveProperty("readOnly", true);
  expect(field).toHaveProperty("value", "/Users/me/Mail attachments");
  expect(screen.getByRole("button", { name: "Choose…" })).toBeTruthy();
  await audit();
});

it("names each account row and its actions with the address, after the visible text", async () => {
  const work = { ...account, id: "gmail:work", email: "work@example.com" };
  render(
    localized(
      h(Settings, {
        initialTab: "accounts",
        accounts: [account, work],
        onClose: vi.fn(),
        onAddAccount: vi.fn(),
      }),
    ),
  );
  for (const email of [account.email, work.email]) {
    const row = within(screen.getByRole("group", { name: email }));
    for (const verb of ["Sign in again", "Remove", "Save", "Move up", "Move down"]) {
      const button = row.getByRole("button", { name: `${verb} ${email}` });
      // The visible text starts the accessible name (WCAG 2.5.3, label in name).
      expect(button.firstChild?.textContent?.trim()).toBe(verb);
      expect(button.querySelector(".sr-only")?.textContent).toBe(email);
    }
    expect(row.getByRole("region", { name: `Sync health for ${email}` })).toBeTruthy();
  }
  await audit();
});

it("toolbar order buttons start their names with the visible Move up and Move down", async () => {
  render(
    localized(
      h(Settings, {
        initialTab: "interactions",
        accounts: [account],
        onClose: vi.fn(),
        onAddAccount: vi.fn(),
      }),
    ),
  );
  const archive = screen.getByRole("button", { name: "Move up Archive" });
  expect(archive.firstChild?.textContent?.trim()).toBe("Move up");
  expect(archive.querySelector(".sr-only")?.textContent).toBe("Archive");
  expect(screen.getByRole("button", { name: "Move down Archive" })).toBeTruthy();
  await audit();
});

it("existing accounts without an OAuth registration show the configuration state", () => {
  fixture.values.set("clientSetupAtom", NO_CLIENTS);
  render(
    localized(
      h(Settings, {
        initialTab: "accounts",
        accounts: [account],
        onClose: vi.fn(),
        onAddAccount: vi.fn(),
      }),
    ),
  );
  expect(screen.getByText("OAuth client not configured. Set it up before syncing.")).toBeTruthy();
});

for (const choice of [null, "Other IMAP", "Gmail", "Outlook"] as const) {
  it(`audits the add-account ${choice ?? "provider chooser"} dialog`, async () => {
    fixture.values.set("clientSetupAtom", NO_CLIENTS);
    render(localized(h(AddAccountDialog, { onClose: vi.fn(), onAdded: vi.fn() })));
    if (choice) fireEvent.click(screen.getByRole("button", { name: choice }));
    await audit();
  });
}

it("account names say who sees them: Display name in OpenMail, Sender name in recipients' mail", async () => {
  const imapAccount = {
    ...account,
    id: "imap:me",
    provider: "imap" as const,
    imap: {
      preset: "custom",
      username: "me@example.com",
      imapHost: "imap.example.com",
      imapPort: 993,
      smtpHost: "smtp.example.com",
      smtpPort: 465,
      smtpSecure: true,
    },
  };
  render(
    localized(
      h(Settings, {
        initialTab: "accounts",
        accounts: [imapAccount],
        onClose: vi.fn(),
        onAddAccount: vi.fn(),
      }),
    ),
  );
  expect(
    screen.getByRole("textbox", { name: "Display name", description: "Only shown in OpenMail" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("textbox", { name: "Sender name", description: "Shown to recipients" }),
  ).toBeTruthy();
  await audit();
  cleanup();

  fixture.values.set("clientSetupAtom", NO_CLIENTS);
  render(localized(h(AddAccountDialog, { onClose: vi.fn(), onAdded: vi.fn() })));
  fireEvent.click(screen.getByRole("button", { name: "Other IMAP" }));
  expect(
    screen.getByRole("textbox", {
      name: "Sender name (optional)",
      description: "Shown to recipients",
    }),
  ).toBeTruthy();
});

it("Other IMAP fills empty server names from the email address on blur, without a lookup", async () => {
  fixture.values.set("clientSetupAtom", NO_CLIENTS);
  render(localized(h(AddAccountDialog, { onClose: vi.fn(), onAdded: vi.fn() })));
  fireEvent.click(screen.getByRole("button", { name: "Other IMAP" }));
  const field = (name: string) => screen.getByRole("textbox", { name });
  const email = field("Email address");
  fireEvent.change(email, { target: { value: "me@mail.example.org" } });
  fireEvent.blur(email);
  expect(field("IMAP server")).toHaveProperty("value", "imap.mail.example.org");
  expect(field("SMTP server")).toHaveProperty("value", "smtp.mail.example.org");
  // Two fields show "Port"; their names say which server each belongs to.
  expect(field("IMAP port")).toHaveProperty("value", "993");
  expect(field("SMTP port")).toHaveProperty("value", "465");
  expect(screen.getByText(/Server names guessed from your email address/)).toBeTruthy();
  // A server the person typed is never replaced.
  fireEvent.change(field("IMAP server"), { target: { value: "mx.example.net" } });
  fireEvent.change(email, { target: { value: "me@example.com" } });
  fireEvent.blur(email);
  expect(field("IMAP server")).toHaveProperty("value", "mx.example.net");
  expect(fixture.decide).not.toHaveBeenCalled();
  await audit();
});

it("Sign in again on an IMAP row opens on that account with its servers filled in and the password focused", async () => {
  const imapAccount = {
    ...account,
    id: "imap:me",
    provider: "imap" as const,
    email: "me@example.com",
    needsReauth: true,
    imap: {
      preset: "custom",
      username: "login-me",
      imapHost: "imap.example.com",
      imapPort: 143,
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      smtpSecure: false,
    },
  };
  const onAddAccount = vi.fn();
  render(
    localized(
      h(Settings, {
        initialTab: "accounts",
        accounts: [imapAccount],
        onClose: vi.fn(),
        onAddAccount,
      }),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Sign in again me@example.com" }));
  expect(onAddAccount).toHaveBeenCalledWith(imapAccount);
  cleanup();

  fixture.values.set("clientSetupAtom", NO_CLIENTS);
  render(
    localized(
      h(AddAccountDialog, { onClose: vi.fn(), onAdded: vi.fn(), signInAgain: imapAccount }),
    ),
  );
  const dialog = screen.getByRole("dialog", { name: "Sign in to me@example.com again" });
  expect(within(dialog).queryByRole("button", { name: "Gmail" })).toBeNull();
  const field = (name: string) => within(dialog).getByRole("textbox", { name });
  expect(field("Email address")).toHaveProperty("value", "me@example.com");
  expect(field("Username (defaults to the email address)")).toHaveProperty("value", "login-me");
  expect(field("IMAP server")).toHaveProperty("value", "imap.example.com");
  expect(field("IMAP port")).toHaveProperty("value", "143");
  expect(field("SMTP server")).toHaveProperty("value", "smtp.example.com");
  expect(field("SMTP port")).toHaveProperty("value", "587");
  expect(
    within(dialog)
      .getByRole("radio", { name: "STARTTLS (usually 587)" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  const password = dialog.querySelector('input[type="password"]');
  expect(password).toHaveProperty("value", "");
  await waitFor(() => expect(document.activeElement).toBe(password));
  // The submit button says what it does here: sign in, not add.
  expect(within(dialog).getByRole("button", { name: "Sign in" })).toBeTruthy();
  expect(within(dialog).queryByRole("button", { name: "Add" })).toBeNull();
  await audit();
});

it("after the first account, a short skippable step lists three shortcuts", async () => {
  const onClose = vi.fn();
  const onAiAccess = vi.fn();
  render(localized(h(FirstRunDone, { onClose, onAiAccess })));
  const dialog = screen.getByRole("dialog", { name: "You're set" });
  expect(
    within(dialog)
      .getAllByRole("term")
      .map((term) => term.textContent),
  ).toEqual(["New message", "Reply", "Archive"]);
  expect(
    within(dialog)
      .getAllByRole("definition")
      .map((keys) => keys.textContent),
  ).toEqual(["⌘N", "⌘R", "⌃⌘A"]);
  expect(dialog.textContent).toContain("Press ? for all shortcuts.");
  await waitFor(() =>
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Done" })),
  );
  await audit();
  // The keymap is picked here too, and AI Access is one click away.
  fireEvent.click(within(dialog).getByRole("radio", { name: "Gmail" }));
  expect(fixture.decide).toHaveBeenCalledWith(
    expect.objectContaining({ payload: { patch: { shortcutSet: "gmail" } } }),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Open AI Access" }));
  expect(onAiAccess).toHaveBeenCalledTimes(1);
  fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("without a built-in or saved client, adding Gmail asks for the user's own client", () => {
  fixture.values.set("clientSetupAtom", NO_CLIENTS);
  render(localized(h(AddAccountDialog, { onClose: vi.fn(), onAdded: vi.fn() })));
  fireEvent.click(screen.getByRole("button", { name: "Gmail" }));
  const form = screen.getByRole("form", { name: "Google client" });
  expect(within(form).getByLabelText("Client ID")).toBeTruthy();
  expect(within(form).getByLabelText("Client secret")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Sign in with Google" })).toBeNull();
  expect(screen.queryByText("Use your own OAuth client")).toBeNull();
  const steps = within(form).getByRole("link", { name: "How to register a Google OAuth client" });
  expect(steps.getAttribute("href")).toBe(
    "https://openmail-docs.vercel.app/docs/own-oauth-client#google",
  );
  expect(form.textContent).not.toContain("in the repository");
});

it("without a built-in or saved client, adding Outlook links to the Microsoft steps", () => {
  fixture.values.set("clientSetupAtom", NO_CLIENTS);
  render(localized(h(AddAccountDialog, { onClose: vi.fn(), onAdded: vi.fn() })));
  fireEvent.click(screen.getByRole("button", { name: "Outlook" }));
  const form = screen.getByRole("form", { name: "Microsoft client" });
  expect(
    within(form)
      .getByRole("link", { name: "How to register a Microsoft app" })
      .getAttribute("href"),
  ).toBe("https://openmail-docs.vercel.app/docs/own-oauth-client#microsoft");
});

for (const [choice, name] of [
  ["Gmail", "Google"],
  ["Outlook", "Microsoft"],
] as const) {
  it(`with a built-in client, adding ${choice} signs in directly and keeps own clients behind a disclosure`, async () => {
    fixture.values.set("clientSetupAtom", BUILT_IN_CLIENTS);
    render(localized(h(AddAccountDialog, { onClose: vi.fn(), onAdded: vi.fn() })));
    fireEvent.click(screen.getByRole("button", { name: choice }));
    expect(screen.getByRole("button", { name: `Sign in with ${name}` })).toBeTruthy();
    expect(screen.getByText("New sign-ins use OpenMail's built-in client.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use the built-in client" })).toBeNull();
    const summary = screen.getByRole("button", { name: "Use your own OAuth client" });
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("form", { name: `${name} client` })).toBeNull();
    fireEvent.click(summary);
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    const panel = document.getElementById(summary.getAttribute("aria-controls") ?? "");
    expect(within(panel!).getByRole("form", { name: `${name} client` })).toBeTruthy();
    await audit();
  });
}

it("the Gmail built-in sign-in says what Google's unverified-app warning asks for; Outlook and own clients don't", () => {
  const warning =
    "Google shows a warning that it hasn't verified OpenMail yet. Choose Advanced, then continue to OpenMail.";
  fixture.values.set("clientSetupAtom", BUILT_IN_CLIENTS);
  render(localized(h(AddAccountDialog, { onClose: vi.fn(), onAdded: vi.fn() })));
  fireEvent.click(screen.getByRole("button", { name: "Gmail" }));
  expect(screen.getByText(warning)).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/7 days|seven days/i);
  cleanup();
  render(localized(h(AddAccountDialog, { onClose: vi.fn(), onAdded: vi.fn() })));
  fireEvent.click(screen.getByRole("button", { name: "Outlook" }));
  expect(screen.queryByText(warning)).toBeNull();
  cleanup();
  fixture.values.set("clientSetupAtom", { ...BUILT_IN_CLIENTS, googleClient: "own" });
  render(localized(h(AddAccountDialog, { onClose: vi.fn(), onAdded: vi.fn() })));
  fireEvent.click(screen.getByRole("button", { name: "Gmail" }));
  expect(screen.queryByText(warning)).toBeNull();
});

it("with the user's own client active, the dialog says so and offers the built-in client", async () => {
  fixture.decide.mockClear();
  fixture.values.set("clientSetupAtom", { ...BUILT_IN_CLIENTS, googleClient: "own" });
  render(localized(h(AddAccountDialog, { onClose: vi.fn(), onAdded: vi.fn() })));
  fireEvent.click(screen.getByRole("button", { name: "Gmail" }));
  expect(screen.getByText("New sign-ins use your own OAuth client.")).toBeTruthy();
  expect(
    screen.getByText("Accounts you already added keep the client they signed in with."),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Use the built-in client" }));
  expect(fixture.decide).toHaveBeenCalledWith("gmail");
  await audit();
});

it("with only the user's own client, the disclosure offers to change it, not a built-in one", () => {
  fixture.values.set("clientSetupAtom", {
    ...NO_CLIENTS,
    googleClient: "own",
  });
  render(localized(h(AddAccountDialog, { onClose: vi.fn(), onAdded: vi.fn() })));
  fireEvent.click(screen.getByRole("button", { name: "Gmail" }));
  expect(screen.getByText("Change your OAuth client")).toBeTruthy();
  expect(screen.queryByText("Use your own OAuth client")).toBeNull();
  expect(screen.queryByRole("button", { name: "Use the built-in client" })).toBeNull();
  expect(screen.getByRole("button", { name: "Sign in with Google" })).toBeTruthy();
});

it("audits the settings tabs as a horizontal row in a narrow window", async () => {
  vi.stubGlobal("innerWidth", 520);
  render(
    localized(
      h(Settings, {
        initialTab: "general",
        accounts: [account],
        onClose: vi.fn(),
        onAddAccount: vi.fn(),
      }),
    ),
  );
  expect(screen.getByRole("tablist").getAttribute("data-orientation")).toBe("horizontal");
  await audit();
});

it("Organize labels its visibility columns and names every color, including one set elsewhere", async () => {
  fixture.values.set("labelsAtom", [
    {
      id: "Label_news",
      accountId: account.id,
      name: "Newsletters",
      color: "#a479e2",
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    },
    { id: "Label_work", accountId: account.id, name: "Work", color: "#16a765" },
  ]);
  render(
    localized(
      h(Settings, {
        initialTab: "organize",
        accounts: [account],
        onClose: vi.fn(),
        onAddAccount: vi.fn(),
      }),
    ),
  );
  // The visible headings name the columns; each control's name joins its row and its column,
  // so a screen reader that skips the row's group still says which label a control changes.
  expect(document.querySelector("li[aria-hidden]")?.textContent).toBe(
    "NameIn sidebarIn message listColor",
  );
  for (const column of ["In sidebar", "In message list", "Color"])
    expect(
      screen.getAllByRole("combobox").filter((box) => box.getAttribute("aria-label") === column),
    ).toHaveLength(2);
  for (const name of ["Newsletters", "Work"])
    for (const column of ["In sidebar", "In message list", "Color"])
      expect(screen.getByRole("combobox", { name: `${name} ${column}` })).toBeTruthy();
  const colors = ["Newsletters", "Work"].map((name) =>
    screen.getByRole("combobox", { name: `${name} Color` }),
  );
  expect(colors.map((color) => color.textContent)).toEqual(["Purple", "Green"]);
  for (const color of colors) expect(color.querySelector("span[aria-hidden]")).toBeTruthy();
  // Each row is a group named for its label, and the row actions name the label too.
  for (const name of ["Newsletters", "Work"]) {
    const row = screen.getByRole("group", { name });
    expect(within(row).getByRole("combobox", { name: `${name} In sidebar` })).toBeTruthy();
    expect(within(row).getByRole("checkbox", { name: "Favorite" })).toBeTruthy();
    const rename = within(row).getByRole("button", { name: `Rename ${name}` });
    const remove = within(row).getByRole("button", { name: `Delete ${name}` });
    // The visible text starts the accessible name (WCAG 2.5.3, label in name).
    expect(rename.querySelector(".sr-only")?.textContent).toBe(name);
    expect(remove.firstChild?.textContent?.trim()).toBe("Delete");
  }
  await audit();
  // An experimental rule, so the shared audit leaves it out: names must start with visible text.
  let mismatch: axe.Result[] = [];
  await act(async () => {
    mismatch = (
      await axe.run(document.body, {
        runOnly: ["label-content-name-mismatch"],
        rules: { "label-content-name-mismatch": { enabled: true } },
      })
    ).violations;
  });
  expect(mismatch.map((issue) => issue.nodes.map((node) => node.html))).toEqual([]);
});

// The sidebar truncates a long tab label ("Жесты и панель инс…"); the title carries the whole of it.
it("gives every settings tab its full label as a title", () => {
  render(localized(h(Settings, { accounts: [account], onClose: vi.fn(), onAddAccount: vi.fn() })));
  const tabs = screen.getAllByRole("tab");
  expect(tabs.length).toBeGreaterThan(10);
  for (const tab of tabs) expect(tab.getAttribute("title")).toBe(tab.textContent);
});

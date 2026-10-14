// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { act, createElement as h, createRef, useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_PREFS } from "@openmail/core/schema";
import { Assistant, AiOutput } from "../features/ai/AiPanel";
import { Proposals } from "../features/ai/Proposals";
import { Toast } from "../ui/Toast";
import { Dialog, Alert, AlertCancel } from "../ui/Dialog";
import { TriageChip } from "../features/ai/TriageChip";
import { DetectedCalendarEvents } from "../features/calendar/CalendarEvents";
import { AttachmentList } from "../features/reader/attachments/Attachments";
import { useLayoutMode } from "../lib/responsive-layout";
import { GoToFolder } from "../features/organize/GoToFolder";
import { PickerPopover } from "../ui/Picker";
import { LinkConfirmDialog } from "../features/reader/frame/LinkConfirmDialog";
import { SnoozeDialog } from "../features/organize/SnoozeDialog";
import { LabelEditor } from "../features/organize/OrganizationSettings";
import { RemoteImagesPrompt } from "../features/reader/RemoteImagesPrompt";
import {
  fixture,
  account,
  message,
  proposal,
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

it("asks once how remote images load; closing it stores Always", async () => {
  const prompt = () => render(localized(h(RemoteImagesPrompt, { hasAccounts: true })));
  const saved = () => fixture.decide.mock.lastCall?.[0]?.payload?.patch;

  const first = prompt();
  const region = screen.getByRole("region", { name: "Load images in messages?" });
  // A floating card over the panes; it leaves focus where it was.
  expect(region.className).toContain("fixed");
  expect(region.contains(document.activeElement)).toBe(false);
  const always = screen.getByRole("radio", {
    name: "Always, block trackers",
    description: "Recommended. Known tracking pixels stay blocked.",
  });
  expect(always.getAttribute("aria-checked")).toBe("true");
  expect(
    screen.getByRole("radio", {
      name: "Ask each time",
      description: "Click Load images on each message.",
    }),
  ).toBeTruthy();
  expect(screen.getByRole("radiogroup", { name: "Remote images" })).toBeTruthy();
  await audit();
  // Arrow keys move the selection inside the group.
  always.focus();
  await userEvent.setup().keyboard("{ArrowDown}");
  expect(
    screen.getByRole("radio", { name: "From people I know" }).getAttribute("aria-checked"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("radio", { name: "Ask each time" }));
  fireEvent.click(screen.getByRole("radio", { name: "From people I know" }));
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(saved()).toEqual({ remoteImages: "known" });
  expect(screen.queryByRole("region", { name: "Load images in messages?" })).toBeNull();
  first.unmount();

  const second = prompt();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(saved()).toEqual({ remoteImages: "always" });
  expect(screen.queryByRole("region")).toBeNull();
  second.unmount();

  // A stored choice, from this prompt or Settings, keeps it hidden on every later launch.
  fixture.values.set("prefsAtom", {
    ...DEFAULT_PREFS,
    remoteImages: "ask",
    remoteImagesChosen: true,
  });
  const calls = fixture.decide.mock.calls.length;
  const chosen = prompt();
  expect(chosen.container.textContent).toBe("");
  expect(fixture.decide.mock.calls.length).toBe(calls);
  chosen.unmount();

  fixture.values.set("prefsAtom", DEFAULT_PREFS);
  expect(
    render(localized(h(RemoteImagesPrompt, { hasAccounts: false }))).container.textContent,
  ).toBe("");
});

it("audits the mail assistant", async () => {
  render(
    localized(h(Assistant, { accounts: [account], proposals: [proposal], onOpenDraft: vi.fn() })),
  );
  fireEvent.keyDown(window, { key: "j", ctrlKey: true });
  expect(screen.getByRole("dialog", { name: "Mail assistant" })).toBeTruthy();
  await audit();
});

it("audits proposals and approves/rejects with the keyboard", async () => {
  const user = userEvent.setup();
  render(
    localized(
      h(Proposals, {
        accounts: [account],
        proposals: [proposal],
        onClose: vi.fn(),
        onOpenDraft: vi.fn(),
      }),
    ),
  );
  await audit();
  screen.getByRole("button", { name: "Approve" }).focus();
  await user.keyboard("{Enter}");
  expect(fixture.decide).toHaveBeenCalledWith(true);
  screen.getByRole("button", { name: "Reject" }).focus();
  await user.keyboard("{Enter}");
  expect(fixture.decide).toHaveBeenCalledWith(false);
});

it("traps dialog focus, focuses the first control, closes on Escape and restores focus", async () => {
  const user = userEvent.setup();
  function Harness() {
    const [open, setOpen] = useState(false);
    return h(
      "div",
      null,
      h("button", { onClick: () => setOpen(true) }, "Open"),
      open &&
        h(Dialog, {
          "aria-label": "Test",
          onClose: () => setOpen(false),
          children: [
            h("input", { key: "name", "aria-label": "Name" }),
            h("button", { key: "last" }, "Last"),
          ],
        }),
    );
  }
  render(h(Harness));
  await user.click(screen.getByRole("button", { name: "Open" }));
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Name" })),
  );
  await user.tab({ shift: true });
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Last" })),
  );
  await user.tab();
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Name" })),
  );
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open" })),
  );
});

it("announces undo politely and errors assertively", () => {
  const view = render(
    h(Toast, {
      toast: { id: 1, text: "Archived", action: { label: "Undo", run: vi.fn() } },
      onDone: vi.fn(),
    }),
  );
  expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
  view.rerender(
    h(Toast, { toast: { id: 2, text: "Sync failed", tone: "error" }, onDone: vi.fn() }),
  );
  expect(screen.getByRole("alert").getAttribute("aria-live")).toBe("assertive");
});

it("keeps a toast while it is hovered or focused, and returns focus when it closes", () => {
  vi.useFakeTimers();
  try {
    const onDone = vi.fn();
    const run = vi.fn();
    const origin = document.createElement("button");
    document.body.append(origin);
    render(
      h(Toast, {
        toast: { id: 1, text: "Draft discarded", action: { label: "Undo", run } },
        onDone,
      }),
    );
    const undo = screen.getByRole("button", { name: "Undo" });
    const toast = undo.parentElement!;
    fireEvent.mouseEnter(toast);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.mouseLeave(toast);
    origin.focus();
    act(() => undo.focus());
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.keyDown(undo, { key: "Escape" });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(origin);
    expect(run).not.toHaveBeenCalled();
    origin.remove();
  } finally {
    vi.useRealTimers();
  }
});

it("announces AI state changes without putting streamed text in a live region", () => {
  const result = {
    text: "First token",
    sources: [],
    model: "",
    truncated: false,
    stopped: undefined,
    coverage: undefined,
    status: "running",
    error: null,
    start: vi.fn(),
    cancel: vi.fn(),
  } satisfies Parameters<typeof AiOutput>[0]["result"];
  const view = render(localized(h(AiOutput, { result, openSource: vi.fn() })));
  const status = screen.getByRole("status");
  view.rerender(
    localized(h(AiOutput, { result: { ...result, text: "More tokens" }, openSource: vi.fn() })),
  );
  expect(screen.getByRole("status").textContent).toBe(status.textContent);
  expect(screen.getByText("More tokens").closest('[aria-live],[role="status"]')).toBeNull();
  view.rerender(
    localized(h(AiOutput, { result: { ...result, status: "done" }, openSource: vi.fn() })),
  );
  expect(screen.getByRole("status").textContent).toBe("Generation complete");
});

it("opens triage review from the keyboard and announces the dialog", async () => {
  const user = userEvent.setup();
  fixture.values.set("AiSettings", {
    keyConfigured: true,
    accounts: [{ accountId: account.id, allowed: true, autoTriage: true }],
  });
  fixture.values.set("AiTriage", {
    status: "pending",
    action: { kind: "archive" },
    reason: "No action needed",
    model: "Test model",
  });
  render(localized(h(TriageChip, { id: message.id, accountId: account.id, labels: ["INBOX"] })));
  await user.tab();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("dialog", { name: "AI suggestion" })).toBeTruthy();
  await audit();
  screen.getByRole("button", { name: "Accept" }).focus();
  await user.keyboard("{Enter}");
  expect(fixture.decide).toHaveBeenCalledWith(
    expect.objectContaining({ payload: { id: message.id, accept: true } }),
  );
});

it("opens the calendar confirmation by keyboard, traps focus and returns to its button", async () => {
  const user = userEvent.setup();
  fixture.values.set("prefsAtom", {
    ...DEFAULT_PREFS,
    labs: { ...DEFAULT_PREFS.labs, calendarDetection: true },
  });
  fixture.values.set("detectedEventsAtom", [
    {
      key: "meeting",
      title: "Planning",
      start: { kind: "date", value: "2026-10-05" },
      end: { kind: "date", value: "2026-10-06" },
      location: "Office",
      description: "Planning session",
      recurrence: [],
    },
  ]);
  render(
    localized(
      h(DetectedCalendarEvents, { message: { ...message, bodyText: "Meeting on 2026-10-05" } }),
    ),
  );
  await user.tab();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("dialog", { name: "Add this event to your calendar?" })).toBeTruthy();
  await audit();
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add to calendar" })),
  );
});

it("offers Open With in the keyboard accessible attachment menu", async () => {
  const user = userEvent.setup();
  render(
    localized(
      h(
        "main",
        null,
        h(AttachmentList, {
          messageId: message.id,
          files: [
            {
              path: [0],
              filename: "agenda.pdf",
              mimeType: "application/pdf",
              size: 128,
              embedded: false,
              decodeError: false,
            },
          ],
          notify: vi.fn(),
        }),
      ),
    ),
  );
  screen.getByRole("button", { name: "Actions for agenda.pdf" }).focus();
  await user.keyboard("{Enter}");
  const openWith = await screen.findByRole("menuitem", { name: "Open with" });
  expect(openWith.getAttribute("aria-haspopup")).toBe("menu");
  await audit();
  openWith.focus();
  await user.keyboard("{ArrowRight}");
  // The submenu lists the apps the main process found, as a React menu, not a native popup.
  const app = await screen.findByRole("menuitem", { name: "Preview" });
  await waitFor(() => expect(document.activeElement).toBe(app));
  await audit();
  await user.keyboard("{ArrowLeft}");
  await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Preview" })).toBeNull());
  expect(document.activeElement).toBe(openWith);
});

it("defaults confirmations to Cancel and restores the opener on Escape", async () => {
  const user = userEvent.setup();
  function Harness() {
    const [open, setOpen] = useState(false);
    return localized(
      h(
        "div",
        null,
        h("button", { onClick: () => setOpen(true) }, "Delete"),
        h(Alert, {
          open,
          onOpenChange: setOpen,
          title: "Delete message?",
          children: [
            h(AlertCancel, { key: "cancel", children: "Cancel" }),
            h("button", { key: "confirm" }, "Confirm"),
          ],
        }),
      ),
    );
  }
  render(h(Harness));
  await user.click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" })),
  );
  await audit();
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Delete" })),
  );
});

it("follows CSS pixels, so zoom moves the window between three, two and one pane", () => {
  let changed: (() => void) | undefined;
  vi.stubGlobal("matchMedia", () => ({
    addEventListener: (_name: string, listener: () => void) => {
      changed = listener;
    },
    removeEventListener: vi.fn(),
  }));
  const resize = (width: number) => {
    vi.stubGlobal("innerWidth", width);
    act(() => changed?.());
  };
  vi.stubGlobal("innerWidth", 1056);
  function Harness() {
    return h("output", null, useLayoutMode());
  }
  render(h(Harness));
  expect(screen.getByRole("status").textContent).toBe("wide");
  // 1056 px at 110% zoom.
  resize(960);
  expect(screen.getByRole("status").textContent).toBe("wide");
  resize(873);
  expect(screen.getByRole("status").textContent).toBe("medium");
  resize(639);
  expect(screen.getByRole("status").textContent).toBe("narrow");
});

it("audits the folder command palette and selects a result with the keyboard", async () => {
  const user = userEvent.setup();
  const onView = vi.fn();
  const onClose = vi.fn();
  render(
    localized(
      h(GoToFolder, {
        labels: [],
        accounts: [account],
        view: { space: "all", mailbox: "inbox" },
        onView,
        onClose,
      }),
    ),
  );
  const input = screen.getByRole("combobox", { name: "Go to folder" });
  await waitFor(() => expect(document.activeElement).toBe(input));
  await user.type(input, "Sent");
  await audit();
  await user.keyboard("{Enter}");
  expect(onView).toHaveBeenCalledWith({ space: "all", mailbox: "sent" });
  expect(onClose).toHaveBeenCalled();
});

it("traps picker focus, audits its controls and returns focus on Escape", async () => {
  const user = userEvent.setup();
  function Harness() {
    const [open, setOpen] = useState(false);
    return localized(
      h(
        "main",
        null,
        h(PickerPopover, {
          "aria-label": "Pick label",
          open,
          onOpenChange: setOpen,
          trigger: h("button", null, "Pick label"),
          children: [
            h("input", { key: "query", "aria-label": "Find label" }),
            h("button", { key: "label" }, "Work"),
          ],
        }),
        h("button", null, "Outside"),
      ),
    );
  }
  render(h(Harness));
  const opener = screen.getByRole("button", { name: "Pick label" });
  await user.click(opener);
  const input = screen.getByRole("textbox", { name: "Find label" });
  await waitFor(() => expect(document.activeElement).toBe(input));
  await audit();
  await user.tab({ shift: true });
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" })),
  );
  await user.tab();
  await waitFor(() => expect(document.activeElement).toBe(input));
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(opener));
});

it("audits link confirmation, defaults to Cancel and restores the source link", async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn();
  const linkRef = createRef<HTMLAnchorElement>();
  function Harness() {
    const [open, setOpen] = useState(false);
    return localized(
      h(
        "main",
        null,
        h(
          "a",
          {
            ref: linkRef,
            href: "https://example.com",
            onClick: (event) => {
              event.preventDefault();
              setOpen(true);
            },
          },
          "Displayed link",
        ),
        open &&
          h(LinkConfirmDialog, {
            url: "https://example.com/real",
            onOpen,
            onClose: () => setOpen(false),
            returnFocus: () => linkRef.current,
          }),
      ),
    );
  }
  render(h(Harness));
  await user.tab();
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" })),
  );
  await audit();
  await user.tab({ shift: true });
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open link" })),
  );
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(linkRef.current));
  expect(onOpen).not.toHaveBeenCalled();
});

it("audits the snooze form and associates invalid reminder input with its error", async () => {
  render(
    localized(h(SnoozeDialog, { threads: [message.id], onClose: vi.fn(), onStart: () => vi.fn() })),
  );
  const input = screen.getByRole("textbox", { name: "Reminder time" });
  fireEvent.change(input, { target: { value: "invalid reminder" } });
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(document.getElementById(input.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
    "Enter a future reminder time",
  );
  await audit();
});

it("snooze presets show the weekday and time they resolve to", () => {
  const now = new Date(2026, 9, 15, 14, 30).getTime();
  vi.useFakeTimers({ now, toFake: ["Date"] });
  try {
    render(
      localized(
        h(SnoozeDialog, { threads: [message.id], onClose: vi.fn(), onStart: () => vi.fn() }),
      ),
    );
    const times = {
      "In 3 hours": "Thu 5:30 PM",
      "Tomorrow morning": "Fri 9:00 AM",
      "Next week": "Thu 9:00 AM",
    };
    // The accessible name reads the preset, then its time.
    for (const [name, time] of Object.entries(times))
      expect(screen.getByRole("button", { name: `${name} ${time}` })).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});

it("audits a label editor with a server error", async () => {
  render(
    localized(
      h(LabelEditor, {
        label: "new",
        labels: [],
        busy: false,
        error: "Server unavailable",
        onClose: vi.fn(),
        onSave: vi.fn(),
      }),
    ),
  );
  const input = screen.getByRole("textbox", { name: "Name" });
  expect(document.getElementById(input.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
    "Server unavailable",
  );
  await audit();
});

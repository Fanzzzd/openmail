import { mailHref } from "../../../shared/routes";
import { Deferred, Effect, Stream } from "effect";
import { AuthError, ProviderError, PermanentError } from "@openmail/core/portable";
import { afterEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { fireEvent, screen, within } from "@testing-library/react/pure";
import { flow, eventually, incoming, row, clickButton, advance, key } from "./harness";

let current: Awaited<ReturnType<typeof flow>> | undefined;
afterEach(async () => {
  await current?.dispose();
  current = undefined;
});

it("first sync renders provider messages through RPC and persists the inbox", async () => {
  current = await flow({ messages: [] });
  const h = current;
  await eventually(() =>
    expect(screen.getByText("You're all caught up. Your Inbox is empty.")).toBeTruthy(),
  );
  const pulls = h.server.pulls.length;
  for (const id of ["one", "two"]) h.server.messages.set(id, incoming(id));
  await h.event({ _tag: "NativeAction", action: "sync", triggeredByAccelerator: false });
  await eventually(() => expect(row(h.id("one")).textContent).toContain("Flow one"));
  expect(await h.run(h.store.listThreads({ mailbox: "inbox" }))).toHaveLength(2);
  expect(h.server.connects).toEqual([{ provider: "gmail" }]);
  await eventually(() => expect(h.server.pulls.length).toBeGreaterThan(pulls));
  expect(h.requests.some((request) => request.tag === "Sync")).toBe(true);
});

it("opening a thread delays mark read and switching cancels the previous timer", async () => {
  current = await flow({ prefs: { markReadDelay: 1 } });
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  fireEvent.click(row(h.id("one")));
  await eventually(() =>
    expect(screen.getByRole("article", { name: /^Selected message/ }).textContent).toContain(
      "Original one",
    ),
  );
  await advance(500);
  expect((await h.run(h.store.getMessage(h.id("one")))).isUnread).toBe(true);
  fireEvent.click(row(h.id("two")));
  await advance(700);
  expect((await h.run(h.store.getMessage(h.id("one")))).isUnread).toBe(true);
  expect((await h.run(h.store.getMessage(h.id("two")))).isUnread).toBe(true);
  await advance(300);
  await eventually(async () =>
    expect((await h.run(h.store.getMessage(h.id("two")))).isUnread).toBe(false),
  );
  await eventually(() => expect(row(h.id("two")).textContent).not.toContain("Unread"));
  expect(h.server.pushed).toEqual([{ providerId: "two", op: { kind: "read", value: true } }]);
});

it.each([
  { button: "Archive", kind: "archive", label: "INBOX", present: false },
  { button: "Delete", kind: "trash", label: "TRASH", present: true },
] as const)(
  "$kind advances selection and Cmd+Z restores UI, provider and SQLite",
  async ({ button, kind, label, present }) => {
    current = await flow();
    const h = current;
    await eventually(() => expect(row(h.id("one"))).toBeTruthy());
    fireEvent.click(row(h.id("one")));
    await eventually(() =>
      expect(screen.getByRole("article", { name: /^Selected message/ })).toBeTruthy(),
    );
    clickButton(button);
    await eventually(() => expect(row(h.id("two")).getAttribute("aria-selected")).toBe("true"));
    expect(document.querySelector(`[data-id="${h.id("one")}"]`)).toBeNull();
    expect((await h.run(h.store.getMessage(h.id("one")))).labels.includes(label)).toBe(present);
    await eventually(() =>
      expect(h.server.pushed).toContainEqual({ providerId: "one", op: { kind } }),
    );
    key("z", { metaKey: true });
    await eventually(() => expect(row(h.id("one")).getAttribute("aria-selected")).toBe("true"));
    expect((await h.run(h.store.getMessage(h.id("one")))).labels).toContain("INBOX");
    expect((await h.run(h.store.getMessage(h.id("one")))).labels).not.toContain("TRASH");
    expect(h.server.messages.get("one")?.labels).toContain("INBOX");
    expect(h.server.pushed.length).toBeGreaterThan(1);
  },
);

it("Gmail labels remain additive and Cmd+Z removes only the added label", async () => {
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  fireEvent.click(row(h.id("one")));
  await eventually(() =>
    expect(screen.getByRole("article", { name: /^Selected message/ })).toBeTruthy(),
  );
  key("l", { metaKey: true });
  await eventually(() => expect(screen.getByRole("option", { name: "Work" })).toBeTruthy());
  fireEvent.click(screen.getByRole("option", { name: "Work" }));
  await eventually(async () =>
    expect((await h.run(h.store.getMessage(h.id("one")))).labels).toContain("Label_work"),
  );
  expect(row(h.id("one")).getAttribute("aria-selected")).toBe("true");
  expect(h.server.pushed).toContainEqual({
    providerId: "one",
    op: { kind: "label", labelId: "Label_work", value: true },
  });
  key("Escape");
  key("z", { metaKey: true });
  await eventually(async () =>
    expect((await h.run(h.store.getMessage(h.id("one")))).labels).not.toContain("Label_work"),
  );
  expect(h.server.messages.get("one")?.labels).toContain("INBOX");
});

it("snooze advances selection and Cmd+Z restores the inbox and reminder", async () => {
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  fireEvent.click(row(h.id("one")));
  await eventually(() =>
    expect(screen.getByRole("article", { name: /^Selected message/ })).toBeTruthy(),
  );
  clickButton("Conversation actions");
  fireEvent.click(await screen.findByRole("menuitem", { name: "Snooze" }));
  await eventually(() => expect(screen.getByRole("button", { name: "In 3 hours" })).toBeTruthy());
  clickButton("In 3 hours");
  await eventually(() => expect(row(h.id("two")).getAttribute("aria-selected")).toBe("true"));
  expect((await h.run(h.store.getMessage(h.id("one")))).labels).toContain("SNOOZED");
  expect(h.server.pushed).toHaveLength(0);
  expect(h.server.messages.get("one")?.labels).toContain("INBOX");
  key("z", { metaKey: true }, row(h.id("two")));
  await eventually(() => expect(row(h.id("one")).getAttribute("aria-selected")).toBe("true"));
  expect((await h.run(h.store.getMessage(h.id("one")))).labels).not.toContain("SNOOZED");
  expect(h.server.messages.get("one")?.labels).toContain("INBOX");
});

function edit(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } });
}
function writeBody(text: string) {
  const body = screen.getByRole("textbox", { name: "Body" });
  body.innerHTML = `<div>${text}</div>`;
  fireEvent.input(body);
}

it.each([
  {
    kind: "offline",
    error: new ProviderError({ message: "Bearer secret /private/provider.txt", status: 503 }),
    expected: "Can't reach the mail server right now.",
  },
  {
    kind: "auth",
    error: new AuthError({ message: "Bearer secret /private/keychain.txt" }),
    expected: "The server rejected the sign-in.",
  },
])(
  "$kind send failure keeps an actionable error through the production RPC boundary",
  async ({ error, expected }) => {
    current = await flow();
    const h = current;
    await eventually(() => expect(row(h.id("one"))).toBeTruthy());
    clickButton("New message");
    await eventually(() => expect(screen.getByRole("textbox", { name: "Subject" })).toBeTruthy());
    edit("To", "carol@example.com");
    edit("Subject", "Error recovery");
    writeBody("Keep this draft");
    // The core API produces these typed failures; exercise the real transport and UI recovery.
    const perform = h.m.perform.bind(h.m);
    vi.spyOn(h.m, "perform").mockImplementation((command, actor) =>
      command.kind === "send" ? Effect.fail(error) : perform(command, actor),
    );
    clickButton("Send");
    await eventually(() =>
      expect(
        screen.getAllByText(new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).length,
      ).toBeTruthy(),
    );
    expect(h.requests.some((request) => request.tag === "Send")).toBe(true);
    expect(document.body.textContent).not.toContain("Bearer secret");
    expect(document.body.textContent).not.toContain("/private/");
    expect(screen.getByRole("textbox", { name: "Body" }).textContent).toContain("Keep this draft");
    expect(h.server.sent).toHaveLength(0);
  },
);

it("AI key validation keeps its specific message through the production RPC boundary", async () => {
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  await h.event({ _tag: "Command", command: "settings" });
  await eventually(() => expect(screen.getByRole("tab", { name: "AI Access" })).toBeTruthy());
  fireEvent.click(screen.getByRole("tab", { name: "AI Access" }));
  await eventually(() =>
    expect(screen.getByLabelText("Anthropic API key", { exact: true })).toBeTruthy(),
  );
  edit("Anthropic API key", "x".repeat(4097));
  clickButton("Save key");
  await eventually(() =>
    expect(h.requests.some((request) => request.tag === "SetAiKey")).toBe(true),
  );
  await eventually(() => expect(screen.getByText("Enter a single API key.")).toBeTruthy());
  expect(h.requests.some((request) => request.tag === "SetAiKey")).toBe(true);
  expect((await h.run(h.m.aiSettings)).keyConfigured).toBe(false);
});

it("new compose autosaves, holds send, Cmd+Z reopens it, and the second send delivers once", async () => {
  current = await flow({ prefs: { undoSendSeconds: 5 } });
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  clickButton("New message");
  await eventually(() => expect(screen.getByRole("textbox", { name: "Subject" })).toBeTruthy());
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  edit("To", "carol@example.com");
  edit("Subject", "Flow composed");
  writeBody("A new note");
  await advance(1999);
  expect(h.server.draftLog).toHaveLength(0);
  await advance(1);
  await eventually(() => expect(h.server.draftLog).toHaveLength(1));
  const saved = h.server.draftLog[0];
  expect(saved?.kind).toBe("save");
  if (saved?.kind !== "save") throw new Error("Draft did not autosave");
  const draftId = h.requests.find((request) => request.tag === "SaveDraft")?.payload;
  expect(draftId).toBeTruthy();
  expect(saved.push.message.text).toContain("A new note");
  expect(await h.run(h.m.threads({ mailbox: "drafts" }))).toHaveLength(1);
  clickButton("Send");
  await eventually(() => expect(screen.queryByRole("textbox", { name: "Subject" })).toBeNull());
  await advance(4999);
  expect(h.server.sent).toHaveLength(0);
  key("z", { metaKey: true }, row(h.id("one")));
  await eventually(() =>
    expect(screen.getByRole("textbox", { name: "Subject" })).toHaveProperty(
      "value",
      "Flow composed",
    ),
  );
  await advance(1);
  expect(h.server.sent).toHaveLength(0);
  clickButton("Send");
  await advance(5000);
  await eventually(() => expect(h.server.sent).toHaveLength(1));
  expect(h.server.sent[0]?.message).toMatchObject({
    to: [{ address: "carol@example.com", name: "" }],
    subject: "Flow composed",
  });
  expect(h.server.sent[0]?.message.text).toContain("A new note");
  await eventually(async () =>
    expect(await h.run(h.m.threads({ mailbox: "drafts" }))).toHaveLength(0),
  );
  expect(screen.getAllByText("Sent").length).toBeGreaterThan(0);
});

it.each(["reply", "replyAll", "forward"] as const)(
  "%s carries quoted original, signature and recipients through send",
  async (mode) => {
    current = await flow();
    const h = current;
    await h.run(
      h.m.setSignature({ address: h.account.email, kind: "reply", text: "Flow signature" }),
    );
    await h.event({ _tag: "NativeAction", action: "sync", triggeredByAccelerator: false });
    await eventually(() => expect(row(h.id("one"))).toBeTruthy());
    fireEvent.click(row(h.id("one")));
    await eventually(() =>
      expect(screen.getByRole("article", { name: /^Selected message/ })).toBeTruthy(),
    );
    key(mode === "forward" ? "f" : "r", { metaKey: true, shiftKey: mode !== "reply" });
    await eventually(() =>
      expect(screen.getByRole("textbox", { name: "Body" }).textContent).toContain("Original one"),
    );
    expect(screen.getByRole("textbox", { name: "Body" }).textContent).toContain("Flow signature");
    expect(screen.getByRole("textbox", { name: "Subject" })).toHaveProperty(
      "value",
      `${mode === "forward" ? "Fwd" : "Re"}: Flow one`,
    );
    if (mode === "forward") {
      edit("To", "carol@example.com");
      await eventually(() => expect(screen.queryByText("Loading attachments…")).toBeNull());
    }
    clickButton("Send");
    await eventually(() => {
      if (h.server.sent.length !== 1) throw new Error(document.body.textContent);
    });
    const sent = h.server.sent[0];
    expect(sent?.message.mode).toBe(mode);
    expect(sent?.message.text).toContain("Original one");
    expect(sent?.message.text).toContain(
      mode === "forward" ? "Forwarded message" : "> Original one",
    );
    expect(sent?.message.text).toContain("Flow signature");
    expect(sent?.message.to.map((address) => address.address)).toEqual([
      mode === "forward" ? "carol@example.com" : "alice@example.com",
    ]);
    expect(sent?.message.cc.map((address) => address.address)).toEqual(
      mode === "replyAll" ? ["bob@example.com"] : [],
    );
    expect(sent?.original).toMatchObject({
      _tag: "Some",
      value: { providerId: "one", threadId: "t-one" },
    });
    expect(
      (await h.run(h.m.audit(10))).some(
        (entry) => entry.action === "send" && entry.actor === "user:app",
      ),
    ).toBe(true);
  },
);

it("attachment reminder blocks send until the user explicitly confirms", async () => {
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  clickButton("New message");
  await eventually(() => expect(screen.getByRole("textbox", { name: "Subject" })).toBeTruthy());
  edit("To", "carol@example.com");
  edit("Subject", "Reminder");
  writeBody("Please see the attachment.");
  clickButton("Send");
  await eventually(() =>
    expect(screen.getByText("The message mentions an attachment, but none is added.")).toBeTruthy(),
  );
  expect(h.server.sent).toHaveLength(0);
  expect(h.requests.filter((request) => request.tag === "Send")).toHaveLength(0);
  clickButton("Cancel");
  expect(screen.getByRole("textbox", { name: "Body" }).textContent).toContain("attachment");
  clickButton("Send");
  clickButton("Send anyway");
  await eventually(() => expect(h.server.sent).toHaveLength(1));
  expect(h.server.sent[0]?.message.attachments).toEqual([]);
  expect((await h.run(h.m.audit(10))).some((entry) => entry.action === "send")).toBe(true);
});

it("Gmail operators search the server and persist an uncached match", async () => {
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  h.server.searchResults = [
    incoming("remote", { subject: "Server report", labels: ["INBOX", "STARRED"], isStarred: true }),
  ];
  edit("Search mail", 'from:alice@example.com is:starred subject:"Server report"');
  await eventually(() => expect(row(h.id("remote")).textContent).toContain("Server report"));
  expect(h.server.searched.at(-1)?.search).toBe(
    'from:alice@example.com is:starred subject:"Server report"',
  );
  expect(h.requests.some((request) => request.tag === "SearchServer")).toBe(true);
  expect((await h.run(h.store.getMessage(h.id("remote")))).isStarred).toBe(true);
  expect(document.querySelector(`[data-id="${h.id("one")}"]`)).toBeNull();
});

it("server search fallback displays omitted predicates and keeps local filtering", async () => {
  current = await flow({ provider: "imap" });
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  h.server.searchResults = [incoming("remote", { subject: "Folder report", labels: ["work"] })];
  edit("Search mail", "label:Work from:alice@example.com");
  await eventually(() =>
    expect(screen.getByText(/Some server predicates were omitted/)).toBeTruthy(),
  );
  await eventually(() => expect(row(h.id("remote")).textContent).toContain("Folder report"));
  expect(h.server.searched.at(-1)?.search).toBe("label:Work from:alice@example.com");
  expect((await h.run(h.store.getMessage(h.id("remote")))).labels).toEqual(["work"]);
  expect(document.querySelector(`[data-id="${h.id("one")}"]`)).toBeNull();
});

it("offline archive survives conflicting server pull and retries the queue once", async () => {
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  fireEvent.click(row(h.id("one")));
  await eventually(() =>
    expect(screen.getByRole("article", { name: /^Selected message/ })).toBeTruthy(),
  );
  h.server.beforePush = Effect.fail(new ProviderError({ message: "offline", status: 503 }));
  clickButton("Archive");
  await eventually(() => expect(row(h.id("two")).getAttribute("aria-selected")).toBe("true"));
  expect((await h.run(h.store.getMessage(h.id("one")))).labels).not.toContain("INBOX");
  expect(await h.run(h.store.listPendingOps)).toHaveLength(1);
  expect(h.server.pushed).toHaveLength(0);
  const remote = h.server.messages.get("one");
  if (!remote) throw new Error("Missing remote message");
  h.server.messages.set("one", {
    ...remote,
    isStarred: true,
    labels: ["INBOX", "STARRED", "UNREAD"],
  });
  const pulls = h.server.pulls.length;
  await h.event({ _tag: "NativeAction", action: "sync", triggeredByAccelerator: false });
  await eventually(() => expect(h.server.pulls.length).toBeGreaterThan(pulls));
  await eventually(async () => expect((await h.run(h.m.syncState)).running).toBe(false));
  expect((await h.run(h.store.getMessage(h.id("one")))).labels).not.toContain("INBOX");
  expect((await h.run(h.store.getMessage(h.id("one")))).isStarred).toBe(true);
  expect(document.querySelector(`[data-id="${h.id("one")}"]`)).toBeNull();
  expect(await h.run(h.store.listPendingOps)).toHaveLength(1);
  h.server.beforePush = undefined;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 5000);
  await h.event({ _tag: "NativeAction", action: "sync", triggeredByAccelerator: false });
  await eventually(async () => expect(await h.run(h.store.listPendingOps)).toHaveLength(0));
  expect(h.server.pushed).toEqual([{ providerId: "one", op: { kind: "archive" } }]);
  expect(h.server.messages.get("one")?.labels).not.toContain("INBOX");
  expect(h.server.messages.get("one")?.isStarred).toBe(true);
});

it.each(["outlook", "imap"] as const)(
  "%s moves to one folder instead of applying Gmail labels, then undoes",
  async (provider) => {
    current = await flow({ provider });
    const h = current;
    await eventually(() => expect(row(h.id("one"))).toBeTruthy());
    fireEvent.click(row(h.id("one")));
    await eventually(() =>
      expect(screen.getByRole("article", { name: /^Selected message/ })).toBeTruthy(),
    );
    key("m", { metaKey: true, shiftKey: true });
    await eventually(() => expect(screen.getByRole("option", { name: "Work" })).toBeTruthy());
    fireEvent.click(screen.getByRole("option", { name: "Work" }));
    await eventually(() => expect(row(h.id("two")).getAttribute("aria-selected")).toBe("true"));
    await eventually(() =>
      expect(h.server.pushed).toContainEqual({
        providerId: "one",
        op: { kind: "move", labelId: "work", removeLabelId: "INBOX" },
      }),
    );
    expect((await h.run(h.store.getMessage(h.id("one")))).labels).toContain("work");
    expect((await h.run(h.store.getMessage(h.id("one")))).labels).not.toContain("INBOX");
    key("Escape");
    key("z", { metaKey: true }, row(h.id("two")));
    await eventually(() => expect(row(h.id("one")).getAttribute("aria-selected")).toBe("true"));
    expect(h.server.messages.get("one")?.labels).toContain("INBOX");
  },
);

it.each(["retry", "local"] as const)(
  "draft recovery %s updates the saved edits and provider sync state",
  async (action) => {
    current = await flow();
    const h = current;
    await eventually(() => expect(row(h.id("one"))).toBeTruthy());
    clickButton("New message");
    await eventually(() => expect(screen.getByRole("textbox", { name: "Subject" })).toBeTruthy());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    edit("To", "carol@example.com");
    edit("Subject", "Recover this");
    writeBody("Keep these edits");
    h.server.failNext = new PermanentError({ message: "Rejected draft" });
    await advance(2000);
    await eventually(() => expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy());
    expect(h.server.draftLog).toHaveLength(0);
    const drafts = await h.run(h.m.threads({ mailbox: "drafts" }));
    const draft = drafts[0];
    if (!draft) throw new Error("Missing local draft");
    expect((await h.run(h.m.openDraft(draft.id))).message.text).toContain("Keep these edits");
    edit("Subject", "Newest recovery edits");
    clickButton(action === "retry" ? "Retry" : "Keep local copy");
    await eventually(async () =>
      expect((await h.run(h.m.openDraft(draft.id))).message.subject).toBe("Newest recovery edits"),
    );
    if (action === "retry") {
      await eventually(() => expect(h.server.draftLog).toHaveLength(1));
      expect((await h.run(h.m.openDraft(draft.id))).synced).toBe(true);
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    } else {
      await eventually(() =>
        expect(screen.getByRole("button", { name: "Resume syncing" })).toBeTruthy(),
      );
      expect((await h.run(h.m.openDraft(draft.id))).localOnly).toBe(true);
      await advance(2000);
      expect(h.server.draftLog).toHaveLength(0);
      expect(await h.run(h.store.listPendingOps)).toHaveLength(0);
    }
  },
);

it("AI disabled keeps reading and composing off the network", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("AI must stay offline"));
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  fireEvent.click(row(h.id("one")));
  await eventually(() =>
    expect(screen.getByRole("article", { name: /^Selected message/ })).toBeTruthy(),
  );
  expect(screen.queryByRole("button", { name: "Summarize" })).toBeNull();
  key("r", { metaKey: true });
  await eventually(() => expect(screen.getByRole("textbox", { name: "Body" })).toBeTruthy());
  expect(screen.queryByRole("button", { name: "Rewrite" })).toBeNull();
  // With AI off everywhere, the composer has no disabled AI row.
  expect(screen.queryByRole("button", { name: /Write with AI/ })).toBeNull();
  await h.run(h.m.setAiAccount({ accountId: h.account.id, allowed: true, autoSummaries: false }));
  await h.event({ _tag: "Command", command: "compose" });
  await eventually(() =>
    expect(screen.getByRole("button", { name: /Write with AI/ })).toBeTruthy(),
  );
  const result = await h.run(h.m.summarize(h.id("one")).pipe(Stream.runCollect, Effect.result));
  expect(result._tag).toBe("Failure");
  expect((await h.run(h.store.getMessage(h.id("one")))).bodyText).toContain("Original one");
  expect(h.server.sent).toHaveLength(0);
  expect(fetch).not.toHaveBeenCalled();
});

it("proposals approve only the chosen change and rejection never pushes", async () => {
  current = await flow();
  const h = current;
  await h.run(h.m.setAgentWriteMode("propose"));
  for (const id of ["one", "two"])
    await h.run(
      h.m.perform(
        { kind: "modify", threads: [h.id(id)], op: { kind: "archive" } },
        { kind: "agent", surface: "mcp", name: "Flow agent", rationale: `Review ${id}` },
      ),
    );
  await h.event({ _tag: "NativeAction", action: "sync", triggeredByAccelerator: false });
  await eventually(() =>
    expect(screen.getByRole("button", { name: /AI suggestions/ })).toBeTruthy(),
  );
  clickButton(/AI suggestions/);
  await eventually(() =>
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(2),
  );
  expect(h.server.pushed).toHaveLength(0);
  const item = screen.getByText("Review one").closest("li");
  if (!item) throw new Error("Missing proposal item");
  fireEvent.click(within(item).getByRole("button", { name: "Approve" }));
  await eventually(() =>
    expect(h.server.pushed).toEqual([{ providerId: "one", op: { kind: "archive" } }]),
  );
  const reject = screen.getByText("Review two").closest("li");
  if (!reject) throw new Error("Missing proposal item");
  fireEvent.click(within(reject).getByRole("button", { name: "Reject" }));
  await eventually(() =>
    expect(screen.getByText("No suggestions waiting for review.")).toBeTruthy(),
  );
  expect(await h.run(h.m.proposals)).toEqual([]);
  expect(h.server.pushed).toHaveLength(1);
  expect((await h.run(h.store.getMessage(h.id("one")))).labels).not.toContain("INBOX");
  expect((await h.run(h.store.getMessage(h.id("two")))).labels).toContain("INBOX");
});

it("notification click event opens the requested thread and clears an active search", async () => {
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  h.server.messages.set("arrival", incoming("arrival", { date: Date.now() }));
  await h.event({ _tag: "NativeAction", action: "sync", triggeredByAccelerator: false });
  await eventually(() =>
    expect(
      h.notifications.flatMap((batch) => batch.messages).map((message) => message.id),
    ).toContain(h.id("arrival")),
  );
  edit("Search mail", "does-not-match");
  await eventually(() => expect(screen.getByText("No matching messages")).toBeTruthy());
  // Main resolves a notification's thread to its account's All Mail, as showThread does.
  await h.event({ _tag: "Navigate", href: threadRoute(h, "arrival") });
  await eventually(() =>
    expect(screen.getByRole("article", { name: /^Selected message/ }).textContent).toContain(
      "Original arrival",
    ),
  );
  expect(screen.getByLabelText("Search mail")).toHaveProperty("value", "");
  expect(row(h.id("arrival")).getAttribute("aria-selected")).toBe("true");
  expect(h.requests.filter((request) => request.tag === "Thread").length).toBeGreaterThan(0);
  expect((await h.run(h.store.getMessage(h.id("arrival")))).bodyText).toContain("Original arrival");
  expect(h.server.sent).toHaveLength(0);
});

it("keyboard-only list to reader to reply to send keeps the selected original", async () => {
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  row(h.id("one")).focus();
  key("ArrowDown");
  await eventually(() => expect(row(h.id("one")).getAttribute("aria-selected")).toBe("true"));
  key("ArrowDown");
  await eventually(() => expect(row(h.id("two")).getAttribute("aria-selected")).toBe("true"));
  await eventually(() =>
    expect(screen.getByRole("article", { name: /^Selected message/ })).toBeTruthy(),
  );
  key("ArrowRight");
  await eventually(() =>
    expect(document.activeElement?.closest('[data-mail-pane="reader"]')).toBeTruthy(),
  );
  key("r", { metaKey: true });
  await eventually(() =>
    expect(screen.getByRole("textbox", { name: "Subject" })).toHaveProperty(
      "value",
      "Re: Flow two",
    ),
  );
  const user = userEvent.setup();
  const body = screen.getByRole("textbox", { name: "Body" });
  for (let index = 0; index < 40 && document.activeElement !== body; index++) await user.tab();
  expect(document.activeElement).toBe(body);
  await user.keyboard("Keyboard reply");
  key("Enter", { metaKey: true });
  await eventually(() => expect(h.server.sent).toHaveLength(1));
  expect(h.server.sent[0]?.original).toMatchObject({ _tag: "Some", value: { providerId: "two" } });
  expect(h.server.sent[0]?.message.to[0]?.address).toBe("alice@example.com");
  expect(h.server.sent[0]?.message.text).toContain("Keyboard reply");
  expect((await h.run(h.m.audit(10))).some((entry) => entry.action === "send")).toBe(true);
  expect(screen.queryByRole("textbox", { name: "Body" })).toBeNull();
});

it("provider latency leaves the local archive and selection responsive", async () => {
  current = await flow();
  const h = current;
  const release = await Effect.runPromise(Deferred.make<void>());
  const entered = await Effect.runPromise(Deferred.make<void>());
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  fireEvent.click(row(h.id("one")));
  await eventually(() =>
    expect(screen.getByRole("article", { name: /^Selected message/ })).toBeTruthy(),
  );
  h.server.beforePush = Effect.andThen(
    Deferred.succeed(entered, undefined),
    Deferred.await(release),
  );
  clickButton("Archive");
  await eventually(async () =>
    expect(await Effect.runPromise(Deferred.isDone(entered))).toBe(true),
  );
  await eventually(() => expect(row(h.id("two")).getAttribute("aria-selected")).toBe("true"));
  expect((await h.run(h.store.getMessage(h.id("one")))).labels).not.toContain("INBOX");
  expect(h.server.pushed).toHaveLength(0);
  expect(await h.run(h.store.listPendingOps)).toHaveLength(1);
  await Effect.runPromise(Deferred.succeed(release, undefined));
  await eventually(() =>
    expect(h.server.pushed).toEqual([{ providerId: "one", op: { kind: "archive" } }]),
  );
  await eventually(async () => expect(await h.run(h.store.listPendingOps)).toHaveLength(0));
});

it("notification click followed by immediate search clears hidden selection before keyboard actions", async () => {
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  const release = await h.holdLists();
  // Main resolves a notification's thread to its account's All Mail, as showThread does.
  await h.event({ _tag: "Navigate", href: threadRoute(h, "one") });
  await eventually(() =>
    expect(screen.getByRole("article", { name: /^Selected message/ }).textContent).toContain(
      "Original one",
    ),
  );
  edit("Search mail", "does-not-match");
  await release();
  await eventually(() => expect(screen.getByText("No matching messages")).toBeTruthy());
  expect(screen.queryByRole("article", { name: /^Selected message/ })).toBeNull();
  const pushes = h.server.pushed.length;
  key("a", { metaKey: true, ctrlKey: true }, window);
  await eventually(() => expect(screen.queryByRole("button", { name: "Archive" })).toBeNull());
  expect(h.server.pushed).toHaveLength(pushes);
  expect((await h.run(h.store.getMessage(h.id("one")))).labels).toContain("INBOX");
});

it("opening and closing a never-saved composer emits no failed RPC or message lookup for its draft id", async () => {
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  const before = h.responses.length;
  clickButton("New message");
  await eventually(() => expect(screen.getByRole("textbox", { name: "Subject" })).toBeTruthy());
  await eventually(() =>
    expect(
      h.requests.some((request) => request.tag === "OpenDraft" || request.tag === "DraftStatus"),
    ).toBe(true),
  );
  key("Escape", {}, screen.getByRole("textbox", { name: "Subject" }));
  await eventually(() => expect(screen.queryByRole("textbox", { name: "Subject" })).toBeNull());
  const failures = h.responses
    .slice(before)
    .filter(
      (response) =>
        response._tag === "Exit" &&
        response.exit._tag === "Failure" &&
        response.exit.cause.some((cause) => cause._tag !== "Interrupt"),
    );
  expect(failures).toEqual([]);
  expect(h.requests.filter((request) => request.tag === "OpenDraft")).toEqual([]);
  expect(h.server.draftLog).toEqual([]);
});

it.each(["mcp", "rule", "assistant"] as const)(
  "%s replies block sending until unfamiliar Bcc and outside-thread recipients are confirmed",
  async (surface) => {
    current = await flow({
      agentDraft: {
        surface,
        message: {
          to: [{ name: "Alice", address: "alice@example.com" }],
          cc: [],
          bcc: [{ name: "", address: "outsider@example.com" }],
          subject: "Re: Flow one",
          text: "Please review this decision.",
          attachments: [],
          mode: "reply",
          inReplyTo: "gmail:me@gmail.com/one",
        },
      },
    });
    const h = current;
    await eventually(() => expect(screen.getByRole("textbox", { name: "Subject" })).toBeTruthy());
    clickButton("Send");
    await eventually(() => expect(screen.getByText("Review AI recipients")).toBeTruthy());
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("AI added unfamiliar recipients:");
    expect(dialog.textContent).toContain("Recipients outside the original conversation:");
    expect(dialog.textContent).toContain("outsider@example.com");
    expect(h.server.sent).toHaveLength(0);
    expect(h.requests.some((r) => r.tag === "Send" || r.tag === "QueueUndoSend")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(h.server.sent).toHaveLength(0);
    clickButton("Send");
    await eventually(() => expect(screen.getByText("Review AI recipients")).toBeTruthy());
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Send anyway" }),
    );
    await eventually(() => expect(h.server.sent).toHaveLength(1));
    expect(h.server.sent[0]?.message.bcc[0]?.address).toBe("outsider@example.com");
  },
);

it.each(["missing", "failed"] as const)(
  "AI recipient review handles a %s original thread",
  async (state) => {
    current = await flow({
      agentDraft: {
        surface: "mcp",
        message: {
          to: [{ name: "", address: "alice@example.com" }],
          cc: [],
          bcc: [],
          subject: "Re: original",
          text: "Reply",
          attachments: [],
          mode: "reply",
          inReplyTo: "gmail:me@gmail.com/one",
        },
      },
    });
    const h = current;
    await eventually(() => expect(screen.getByRole("textbox", { name: "Subject" })).toBeTruthy());
    await h.run(h.store.rememberMailedAddresses(h.account.id, ["alice@example.com"]));
    if (state === "missing") await h.run(h.store.deleteMessage(h.account.id, "one"));
    else
      vi.spyOn(h.m, "readerThread").mockImplementation(() =>
        Effect.fail(new ProviderError({ message: "Read failed" })),
      );
    clickButton("Send");
    if (state === "missing") {
      await eventually(() => expect(screen.getByText("Review AI recipients")).toBeTruthy());
      expect(screen.getByRole("alertdialog").textContent).toContain(
        "Recipients outside the original conversation:",
      );
      expect(screen.getByRole("alertdialog").textContent).toContain("alice@example.com");
      expect(screen.queryByText("Could not check recipients.")).toBeNull();
    } else
      await eventually(() => expect(screen.getByText("Could not check recipients.")).toBeTruthy());
    expect(h.server.sent).toHaveLength(0);
  },
);

const threadRoute = (h: Awaited<ReturnType<typeof flow>>, id: string) =>
  mailHref({ space: "all", mailbox: "all", accountId: h.account.id }, { thread: h.id(id) });

import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react/pure";
import { Deferred, Effect } from "effect";
import { ProviderError } from "@openmail/core/portable";
import { advance, clickButton, eventually, flow, incoming, row } from "./harness";

let current: Awaited<ReturnType<typeof flow>> | undefined;
afterEach(async () => {
  await current?.dispose();
  current = undefined;
});

function edit(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } });
}
function writeBody(text: string) {
  const body = screen.getByRole("textbox", { name: "Body" });
  body.innerHTML = `<div>${text}</div>`;
  fireEvent.input(body);
}
function toast() {
  const element = screen.getByText("Draft discarded").parentElement;
  if (!element) throw new Error("Missing toast");
  return element;
}
function savedDraftId(h: Awaited<ReturnType<typeof flow>>) {
  const payload = h.requests.find((request) => request.tag === "SaveDraft")?.payload;
  if (typeof payload !== "object" || payload === null || !("draft" in payload)) return "";
  const { draft } = payload;
  return typeof draft === "object" &&
    draft !== null &&
    "id" in draft &&
    typeof draft.id === "string"
    ? draft.id
    : "";
}

async function newDraft(h: Awaited<ReturnType<typeof flow>>, subject: string) {
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  clickButton("New message");
  await eventually(() => expect(screen.getByRole("textbox", { name: "Subject" })).toBeTruthy());
  edit("To", "carol@example.com");
  edit("Subject", subject);
}

it("discard holds the provider delete for Undo, which reopens the latest typing", async () => {
  current = await flow();
  const h = current;
  await newDraft(h, "Keep me");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  writeBody("First words");
  await advance(2000);
  await eventually(() => expect(h.server.drafts.size).toBe(1));
  writeBody("Unsaved words");
  clickButton("Discard draft");
  await eventually(() => expect(screen.queryByRole("textbox", { name: "Subject" })).toBeNull());
  await eventually(() =>
    expect(within(toast()).getByRole("button", { name: "Undo" })).toBeTruthy(),
  );
  await advance(7000);
  expect(h.server.drafts.size).toBe(1);
  expect(h.server.draftLog.some((entry) => entry.kind === "delete")).toBe(false);
  fireEvent.click(within(toast()).getByRole("button", { name: "Undo" }));
  await eventually(() =>
    expect(screen.getByRole("textbox", { name: "Subject" })).toHaveProperty("value", "Keep me"),
  );
  expect(screen.getByRole("textbox", { name: "Body" }).textContent).toContain("Unsaved words");
  await advance(30_000);
  expect(h.server.drafts.size).toBe(1);
  expect((await h.run(h.m.compose.openDraft(savedDraftId(h)))).message.text).toContain(
    "Unsaved words",
  );

  clickButton("Discard draft");
  await eventually(() =>
    expect(within(toast()).getByRole("button", { name: "Undo" })).toBeTruthy(),
  );
  await advance(15_000);
  await eventually(() => expect(h.server.drafts.size).toBe(0));
});

it("a failed send leaves the draft open since then and offers the failed one", async () => {
  current = await flow();
  const h = current;
  await newDraft(h, "First draft");
  writeBody("Will fail");
  const gate = Deferred.makeUnsafe<void>();
  const perform = h.m.perform.bind(h.m);
  vi.spyOn(h.m, "perform").mockImplementation((command, actor) =>
    command.kind === "send"
      ? Deferred.await(gate).pipe(
          Effect.andThen(Effect.fail(new ProviderError({ message: "down", status: 503 }))),
        )
      : perform(command, actor),
  );
  clickButton("Send");
  await eventually(() => expect(screen.queryByRole("textbox", { name: "Subject" })).toBeNull());
  clickButton("New message");
  await eventually(() => expect(screen.getByRole("textbox", { name: "Subject" })).toBeTruthy());
  edit("Subject", "Second draft");
  Effect.runSync(Deferred.succeed(gate, undefined));
  await eventually(() =>
    expect(screen.getAllByText(/Couldn't send First draft/).length).toBeTruthy(),
  );
  expect(screen.getByRole("textbox", { name: "Subject" })).toHaveProperty("value", "Second draft");
  expect(screen.getByRole("button", { name: "Open draft" })).toBeTruthy();
});

it("pagehide saves a composer's unsaved typing", async () => {
  current = await flow();
  const h = current;
  await newDraft(h, "Typed fast");
  writeBody("Not autosaved yet");
  expect(h.requests.some((request) => request.tag === "SaveDraft")).toBe(false);
  window.dispatchEvent(new Event("pagehide"));
  await eventually(async () =>
    expect(await h.run(h.m.threads({ mailbox: "drafts" }))).toHaveLength(1),
  );
});

it("before quit, the open composer saves its unsaved typing", async () => {
  current = await flow();
  const h = current;
  await newDraft(h, "Quitting");
  writeBody("Typed right before quit");
  await h.event({ _tag: "QuitCheck" });
  await eventually(() =>
    expect(h.requests.some((request) => request.tag === "SetSendState")).toBe(true),
  );
  const saveAt = h.requests.findIndex((request) => request.tag === "SaveDraft");
  const reportAt = h.requests.findLastIndex((request) => request.tag === "SetSendState");
  expect(saveAt).toBeGreaterThanOrEqual(0);
  expect(saveAt).toBeLessThan(reportAt);
});

it("archiving in a conversation window asks the main window to offer Undo", async () => {
  current = await flow({ thread: "one" });
  const h = current;
  const close = vi.spyOn(window, "close").mockImplementation(() => {
    /* The test window stays open. */
  });
  await eventually(() => expect(screen.getByRole("button", { name: "Archive" })).toBeTruthy());
  clickButton("Archive");
  await eventually(() => expect(close).toHaveBeenCalled());
  const notice = h.requests.find((request) => request.tag === "ShowUndo");
  expect(notice?.payload).toMatchObject({ text: "Archived", undo: { _tag: "Batch" } });
  const undoId = (await h.run(h.m.undoHistory))[0]?.undoId ?? "";
  expect((await h.run(h.store.getMessage(h.id("one")))).labels).not.toContain("INBOX");
  await h.run(h.m.undoBatch(undoId));
  expect((await h.run(h.store.getMessage(h.id("one")))).labels).toContain("INBOX");
});

it("discarding in a compose window holds the draft and asks the main window to offer Undo", async () => {
  const raw = new TextEncoder().encode(
    [
      "From: me@gmail.com",
      "To: carol@example.com",
      "Subject: Window draft",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Window body",
      "",
    ].join("\r\n"),
  );
  current = await flow({
    messages: [incoming("draft", { labels: ["DRAFT"], subject: "Window draft" })],
    serverDraft: { providerId: "draft", raw },
  });
  const h = current;
  await eventually(() => expect(screen.getByRole("textbox", { name: "Subject" })).toBeTruthy());
  clickButton("Discard draft");
  await eventually(() =>
    expect(h.requests.some((request) => request.tag === "ShowUndo")).toBe(true),
  );
  const notice = h.requests.find((request) => request.tag === "ShowUndo")?.payload;
  expect(notice).toMatchObject({ text: "Draft discarded", undo: { _tag: "Draft" } });
  const discard = h.requests.find((request) => request.tag === "DiscardDraft")?.payload;
  expect(discard).toMatchObject({ holdMs: 15_000 });
  const id =
    typeof discard === "object" && discard !== null && "id" in discard ? String(discard.id) : "";
  expect((await h.run(h.m.compose.restoreDraft(id))).message.subject).toBe("Window draft");
});

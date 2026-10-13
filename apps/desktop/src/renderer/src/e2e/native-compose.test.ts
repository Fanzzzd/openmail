import { afterEach, expect, it } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react/pure";
import { clickButton, eventually, flow, key, row } from "./harness";

let current: Awaited<ReturnType<typeof flow>> | undefined;
afterEach(async () => {
  await current?.dispose();
  current = undefined;
});

it("native message sharing and Photos selection use RPC only after user action, and cancellation adds nothing", async () => {
  const shared: { id: string; kind: "message" | "thread" | "web" }[] = [];
  let picked = 0;
  const file = { filename: "photo-1.jpg", mimeType: "image/jpeg", content: "YWJj" };
  current = await flow({
    native: {
      pick: () => {
        if (++picked === 1) return { status: "ok", files: [], skipped: 0 };
        return { status: "tooLarge", files: [file], skipped: 1 };
      },
      share: (request) => {
        shared.push(request);
      },
    },
  });
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  expect(picked).toBe(0);
  expect(shared).toEqual([]);
  fireEvent.click(row(h.id("one")));
  await h.event({ _tag: "NativeAction", action: "shareThreadLink", triggeredByAccelerator: false });
  await eventually(() => expect(shared).toEqual([{ id: h.id("one"), kind: "thread" }]));
  clickButton("Message actions");
  fireEvent.click(screen.getByRole("menuitem", { name: "Send message link to…" }));
  await eventually(() => expect(shared.at(-1)).toEqual({ id: h.id("one"), kind: "message" }));
  clickButton("New message");
  await eventually(() => expect(screen.getByRole("textbox", { name: "Subject" })).toBeTruthy());
  clickButton("Attach files");
  fireEvent.click(screen.getByRole("menuitem", { name: "Photos" }));
  await eventually(() => expect(picked).toBe(1));
  await eventually(() => expect(screen.queryByText("Loading attachments…")).toBeNull());
  expect(screen.queryByText(file.filename)).toBeNull();
  clickButton("Attach files");
  fireEvent.click(screen.getByRole("menuitem", { name: "Photos" }));
  await eventually(() => expect(screen.getByText(file.filename)).toBeTruthy());
  expect(
    screen.getByText("Images that exceed the 30 MB attachment limit were skipped."),
  ).toBeTruthy();
  const subject = screen.getByRole("textbox", { name: "Subject" });
  fireEvent.change(subject, { target: { value: "Native photo draft" } });
  act(() => {
    key("s", { metaKey: true }, subject);
  });
  await eventually(async () => {
    const [thread] = await h.run(h.m.threads({ mailbox: "drafts" }));
    if (!thread) throw new Error("Draft not saved");
    const draft = await h.run(h.m.openDraft(thread.id));
    expect(draft.message.attachments).toContainEqual(file);
  });
  expect(picked).toBe(2);
  expect(h.requests.filter((request) => request.tag === "PickNativeImages")).toHaveLength(2);
});

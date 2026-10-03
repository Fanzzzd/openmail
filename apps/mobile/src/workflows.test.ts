import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFS, type Message } from "@openmail/core/portable";
import {
  composeMessage,
  draftWriter,
  foregroundCoordinator,
  parseRecipients,
  searchQuery,
  swipeAction,
  swipeOperation,
  toggleSelection,
  unreadBadge,
} from "./workflows";
import { editMarks, markSelection, richTextBody } from "./rich-text";

const original: Message = {
  id: "a:m",
  accountId: "a",
  threadId: "t",
  subject: "Hello",
  from: { name: "Alice", address: "alice@example.test" },
  to: [{ name: "Me", address: "me@example.test" }],
  cc: [{ name: "Bob", address: "bob@example.test" }],
  replyTo: [{ name: "Support", address: "help@example.test" }],
  date: 1,
  snippet: "Hi",
  labels: ["INBOX"],
  isUnread: true,
  isStarred: false,
  hasAttachments: false,
  bodyText: "Hi\nthere",
  bodyHtml: "",
  attachments: [],
};
describe("mail screen view models", () => {
  it("selects short/long actions from final displacement and cancels a returned swipe", () => {
    const prefs = { ...DEFAULT_PREFS.swipeActions, rightLong: "none" as const };
    expect([-220, -80, -59, 0, 80, 220].map((distance) => swipeAction(distance, prefs))).toEqual([
      "trash",
      "archive",
      "none",
      "none",
      "read",
      "none",
    ]);
    expect(swipeOperation("read", original)).toEqual({ kind: "read", value: true });
    expect(swipeOperation("star", original)).toEqual({ kind: "star", value: true });
    expect(toggleSelection(toggleSelection([], "a"), "a")).toEqual([]);
    expect(toggleSelection(["a"], "b")).toEqual(["a", "b"]);
  });
  it("creates new/reply/reply-all/forward with core recipient rules", () => {
    expect(composeMessage("new").to).toEqual([]);
    expect(composeMessage("reply", original, ["me@example.test"]).to).toEqual(original.replyTo);
    expect(composeMessage("replyAll", original, ["me@example.test"]).cc).toEqual(original.cc);
    expect(composeMessage("replyAll", original, ["me@example.test"]).text).toBe(
      "\n\n> Hi\n> there",
    );
    expect(composeMessage("forward", original).to).toEqual([]);
    expect(composeMessage("forward", original).subject).toBe("Fwd: Hello");
    expect(parseRecipients('"Alice" <alice@example.test>; bob@example.test')).toEqual([
      { name: "Alice", address: "alice@example.test" },
      { name: "", address: "bob@example.test" },
    ]);
    expect(() => parseRecipients("bad-address")).toThrow();
  });
  it("uses the shared Gmail operator parser with account isolation", () => {
    const query = searchQuery("a", "from:alice@example.test is:unread has:attachment budget");
    expect(query.accountIds).toEqual(["a"]);
    expect(query).toMatchObject({
      criteria: { from: "alice@example.test", attachment: true },
      unreadOnly: true,
      search: "budget",
    });
  });
  it("supports mixed formatting and escapes pasted markup before the core sanitizer", () => {
    const text = "Hello <img>\nworld";
    const bold = markSelection(text, [], { start: 0, end: 5 }, "bold");
    const mixed = markSelection(text, bold, { start: 11, end: 16 }, "italic");
    const body = richTextBody(text, mixed, false);
    expect(body.html).toContain("<strong>Hello</strong>");
    expect(body.html).not.toContain("<img>");
    expect(richTextBody(text, bold, true).html).toContain("<ul>");
    expect(markSelection(text, bold, { start: 0, end: 5 }, "bold")).toEqual([]);
    expect(
      editMarks("hello world", "xxhello world", [{ start: 6, end: 11, kind: "bold" }]),
    ).toEqual([{ start: 8, end: 13, kind: "bold" }]);
  });
  it("serializes autosaves and lets send wait for the last write", async () => {
    const saved: string[] = [];
    let release: () => void = () => {
      throw new Error("not started");
    };
    const writer = draftWriter(async (message) => {
      if (message.subject === "first")
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      saved.push(message.subject);
    });
    const first = writer.save({ ...composeMessage("new"), subject: "first" });
    const second = writer.save({ ...composeMessage("new"), subject: "second" });
    await vi.waitFor(() => expect(release.toString()).not.toContain("not started"));
    expect(saved).toEqual([]);
    release();
    await Promise.all([first, second, writer.flush()]);
    expect(saved).toEqual(["first", "second"]);
  });
  it("coalesces foreground refresh, keeps offline sends queued, and stops before delivery when backgrounded", async () => {
    let active = true;
    let online = false;
    const sync = vi.fn(async () => null);
    const send = vi.fn(async () => null);
    const badge = vi.fn(async () => null);
    const run = foregroundCoordinator({
      active: () => active,
      online: async () => online,
      sync,
      send,
      badge,
    });
    await run(true);
    expect(sync).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    online = true;
    await Promise.all([run(true), run(true)]);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    sync.mockImplementationOnce(async () => {
      active = false;
      return null;
    });
    await run(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(unreadBadge({ a: 3, b: 2 })).toBe(5);
  });
});

it("does not lose a send deadline requested while badge work is in flight", async () => {
  let run: (sync: boolean) => Promise<void> = async () => {
    return;
  };
  let called = false;
  const send = vi.fn(async () => null);
  run = foregroundCoordinator({
    active: () => true,
    online: async () => true,
    sync: async () => null,
    send,
    badge: async () => {
      if (!called) {
        called = true;
        void run(false);
      }
      return null;
    },
  });
  await run(false);
  expect(send).toHaveBeenCalledTimes(2);
});

it("never autosaves initialized new/reply/forward drafts before a real edit", async () => {
  const { draftSession } = await import("./workflows");
  const save = vi.fn();
  const discard = vi.fn();
  const session = draftSession(save, discard);
  for (const mode of ["new", "reply", "replyAll", "forward"] as const)
    expect(await session.autosave(composeMessage(mode, original))).toBe(false);
  expect(save).not.toHaveBeenCalled();
  session.markEdited();
  expect(await session.autosave({ ...composeMessage("new"), text: "edited" })).toBe(true);
  expect(save).toHaveBeenCalledOnce();
  await session.discard();
  expect(discard).toHaveBeenCalledOnce();
  expect(await session.autosave(composeMessage("new"))).toBe(false);
});
it("waits for an in-flight autosave before discarding, so it cannot recreate the draft", async () => {
  const { draftSession } = await import("./workflows");
  const order: string[] = [];
  let release: () => void = () => {
    throw new Error("not started");
  };
  const session = draftSession(
    async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      order.push("save");
    },
    async () => {
      order.push("discard");
    },
  );
  session.markEdited();
  const saving = session.autosave(composeMessage("new"));
  await vi.waitFor(() => expect(release.toString()).not.toContain("not started"));
  const discarding = session.discard();
  expect(order).toEqual([]);
  release();
  await Promise.all([saving, discarding]);
  expect(order).toEqual(["save", "discard"]);
});
it("offers only actual Outlook folder destinations", async () => {
  const { labelDestinations } = await import("./workflows");
  const labels = ["INBOX", "ARCHIVE", "DRAFT", "SENT", "category:Blue", "folder:custom"].map(
    (id) => ({ id, name: id, accountId: "outlook:me", color: null }),
  );
  expect(labelDestinations("outlook", labels).map((label) => label.id)).toEqual([
    "INBOX",
    "ARCHIVE",
    "folder:custom",
  ]);
});

it("prepares foreground credentials offline before connectivity checks and skips preparation while backgrounded", async () => {
  const calls: string[] = [];
  let active = true;
  const work = foregroundCoordinator({
    active: () => active,
    online: async () => {
      calls.push("online");
      return false;
    },
    prepare: async () => {
      calls.push("migrate");
    },
    sync: async () => {
      calls.push("sync");
    },
    send: async () => {
      calls.push("send");
    },
  });
  await work(true);
  expect(calls).toEqual(["migrate", "online"]);
  active = false;
  calls.length = 0;
  await work(true);
  expect(calls).toEqual([]);
});

it("wakes foreground reminders even when offline, before checking connectivity", async () => {
  const calls: string[] = [];
  const work = foregroundCoordinator({
    active: () => true,
    wake: async () => {
      calls.push("wake");
    },
    online: async () => {
      calls.push("online");
      return false;
    },
    sync: async () => {
      calls.push("sync");
    },
    send: async () => {
      calls.push("send");
    },
  });
  await work(false);
  expect(calls).toEqual(["wake", "online"]);
});

it("foreground reminders keep waking every 30 seconds offline, stop in the background and clean up their timer", async () => {
  const { foregroundReminderTimer } = await import("./workflows");
  vi.useFakeTimers();
  let active = true;
  const wake = vi.fn(async () => null);
  const stop = foregroundReminderTimer(() => active, wake);
  try {
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wake).toHaveBeenCalledTimes(2);
    active = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wake).toHaveBeenCalledTimes(2);
    active = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(wake).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wake).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    stop();
    vi.useRealTimers();
  }
});

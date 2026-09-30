import { afterEach, expect, it, vi } from "vitest";
import { holdSend } from "@openmail/core/schema";

import { emptyDraft } from "./draft";
import { submitDraft } from "./send";

const draft = { ...emptyDraft("gmail:me@example.com"), to: "other@example.com", body: "Hello" };
afterEach(() => vi.useRealTimers());

it("canceling an empty-subject prompt creates no undo timer or queued send", () => {
  vi.useFakeTimers();
  for (const subject of ["", " \t\n "]) {
    const queue = vi.fn();
    const send = vi.fn(() => {
      holdSend(5000, queue);
    });
    expect(submitDraft({ ...draft, subject }, false, [], send)).toEqual({
      kind: "confirm",
      warning: "subject",
    });
    // Cancel dismisses the prompt; it does not submit a confirmed draft.
    vi.advanceTimersByTime(60000);
    expect(send).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(submitDraft({ ...draft, subject }, false, [], send).kind).toBe("confirm");
  }
});

it("explicit confirmation enters the undo queue once and keeps Send & Archive", () => {
  vi.useFakeTimers();
  const queue = vi.fn();
  const send = vi.fn(() => {
    holdSend(5000, queue);
  });
  const reply = { ...draft, mode: "reply" as const };
  expect(submitDraft(reply, true, ["subject"], send)).toEqual({ kind: "sent" });
  expect(send).toHaveBeenCalledExactlyOnceWith(reply, expect.objectContaining({ subject: "" }), {
    archive: true,
  });
  expect(queue).not.toHaveBeenCalled();
  vi.advanceTimersByTime(5000);
  expect(queue).toHaveBeenCalledTimes(1);
});

it("empty subject and missing attachment each need their own confirmation", () => {
  vi.useFakeTimers();
  const queue = vi.fn();
  const send = vi.fn(() => {
    holdSend(5000, queue);
  });
  const withAttachmentMention = { ...draft, body: "Please see the attached file." };
  expect(submitDraft(withAttachmentMention, false, [], send)).toEqual({
    kind: "confirm",
    warning: "subject",
  });
  expect(submitDraft(withAttachmentMention, false, ["subject"], send)).toEqual({
    kind: "confirm",
    warning: "attachment",
  });
  // Canceling the second prompt still leaves the undo/send queue untouched.
  vi.advanceTimersByTime(60000);
  expect(send).not.toHaveBeenCalled();
  expect(queue).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  expect(submitDraft(withAttachmentMention, false, [], send)).toEqual({
    kind: "confirm",
    warning: "subject",
  });
  expect(submitDraft(withAttachmentMention, false, ["subject", "attachment"], send).kind).toBe(
    "sent",
  );
  expect(send).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(5000);
  expect(queue).toHaveBeenCalledTimes(1);
});

it("validation precedes confirmation and a nonempty subject sends without it", () => {
  const send = vi.fn();
  expect(submitDraft({ ...draft, to: "bad" }, false, [], send)).toEqual({
    kind: "invalid",
    addresses: ["bad"],
  });
  expect(submitDraft({ ...draft, to: "" }, false, [], send)).toEqual({ kind: "noRecipients" });
  expect(send).not.toHaveBeenCalled();
  expect(submitDraft({ ...draft, subject: "Hello" }, true, [], send).kind).toBe("sent");
  expect(send.mock.calls[0]?.[2]).toEqual({ archive: false });
});

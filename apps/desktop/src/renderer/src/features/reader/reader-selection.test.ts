import { expect, it } from "vitest";
import type { Account, Message } from "../../../../shared/api";
import { draftFor, toMessage } from "../compose/draft";
import { readerThreadKey, readerMessageId, replySource, replyTarget } from "./reader-selection";

it("standard reply uses the selected older message's recipients, quote and threading", () => {
  const account: Account = {
    id: "gmail:me@example.com",
    provider: "gmail",
    email: "me@example.com",
    createdAt: 0,
    lastSyncedAt: null,
    lastSyncError: null,
    profileId: null,
    needsReauth: false,
  };
  const older: Message = {
    id: `${account.id}/older`,
    accountId: account.id,
    threadId: "shared",
    subject: "Old question",
    from: { name: "Alice", address: "alice@example.com" },
    to: [{ name: "Me", address: account.email }],
    cc: [],
    replyTo: [{ name: "Support", address: "support@example.com" }],
    date: 1,
    snippet: "",
    labels: [],
    bodyText: "The old question",
    bodyHtml: "",
    attachments: [],
    isUnread: false,
    isStarred: false,
    hasAttachments: false,
  };
  const newer = {
    ...older,
    id: `${account.id}/newer`,
    subject: "New question",
    bodyText: "The new question",
    date: 2,
    replyTo: [{ name: "Bob", address: "bob@example.com" }],
  };
  const id = replyTarget(
    { threadKey: readerThreadKey(older) ?? "", id: older.id },
    newer.id,
    true,
    readerThreadKey(newer),
  );
  expect(id).toBe(older.id);
  const source = id ? replySource([older, newer], id) : undefined;
  expect(source).toBe(older);
  if (!source) throw new Error("Missing selected reply source");
  for (const mode of ["reply", "replyAll"] as const) {
    const draft = draftFor(mode, source, account);
    const { message } = toMessage(draft);
    expect(message.inReplyTo).toBe(older.id);
    expect(message.to).toEqual(older.replyTo);
    expect(message.subject).toBe("Re: Old question");
    expect(draft.body.kind).toBe("rich");
    expect(message.text).toContain("The old question");
    expect(message.text).not.toContain("The new question");
    expect(message.html).toContain("The old question");
    expect(message.html).not.toContain("The new question");
  }
  expect(replySource([newer], older.id)).toBeUndefined();
});

it("stale conversation selections and grouping-off reply target the current list message", () => {
  const selection = { threadKey: "thread-a", id: "old-a" };
  expect(replyTarget(selection, "new-b", true, "thread-b")).toBe("new-b");
  expect(replyTarget(selection, "new-a", false, "thread-a")).toBe("new-a");
  expect(replyTarget(null, null, true, null)).toBeNull();
});

it("syncing a new representative preserves the chosen reply across account-scoped thread keys", () => {
  const old = { accountId: "gmail:one", threadId: "shared", id: "old" };
  const newRow = { ...old, id: "new" };
  const threadKey = readerThreadKey(old) ?? "";
  const choice = { threadKey, id: old.id };
  expect(readerThreadKey(newRow)).toBe(threadKey);
  expect(replyTarget(choice, newRow.id, true, readerThreadKey(newRow))).toBe(old.id);
  expect(readerMessageId([old, newRow], old.id, newRow.id, false)).toBe(old.id);
  expect(readerMessageId([newRow], old.id, newRow.id, false)).toBe(newRow.id);
  const otherAccount = { ...newRow, accountId: "outlook:two" };
  expect(replyTarget(choice, otherAccount.id, true, readerThreadKey(otherAccount))).toBe(newRow.id);
  expect(readerThreadKey({ accountId: "a/b", threadId: "c" })).not.toBe(
    readerThreadKey({ accountId: "a", threadId: "b/c" }),
  );
});

import { expect, it } from "vitest";
import { moveRecipient, parseRecipientDrag, replaceRecipient } from "./recipient-actions";
import { emptyDraft, fromStored, needsClosePrompt, toMessage, draftFor } from "./draft";
import { recipientLabel } from "@openmail/core/schema";
import type { Account, Message } from "../../shared/api";

it("moving a chip preserves quoted names, unfinished text and dedupes the destination", () => {
  const fields = {
    to: '"Smith, John" <j@acme.com>, alice@example.com, unfinished',
    cc: "",
    bcc: "",
  };
  expect(moveRecipient(fields, "to", "cc", 0)).toEqual({
    to: "alice@example.com, unfinished",
    cc: '"Smith, John" <j@acme.com>',
    bcc: "",
  });
  expect(moveRecipient({ ...fields, bcc: "j@acme.com" }, "to", "bcc", 0)).toEqual({
    to: "alice@example.com, unfinished",
    cc: "",
    bcc: "j@acme.com",
  });
  expect(moveRecipient(fields, "to", "cc", 2)).toBe(fields);
  expect(moveRecipient(fields, "to", "to", 0)).toBe(fields);
  expect(parseRecipientDrag('{"source":"cc","index":0,"text":"j@acme.com"}')).toEqual({
    source: "cc",
    index: 0,
    text: "j@acme.com",
  });
  for (const value of [
    "bad",
    '{"source":"body","index":0,"text":"x"}',
    '{"source":"to","index":-1,"text":"x"}',
  ])
    expect(parseRecipientDrag(value)).toBeNull();
});
it("alternate address replacement affects one chip and the full-address preference keeps names", () => {
  const alternate = { name: "John Smith", address: "john@work.com" };
  expect(replaceRecipient("John <j@acme.com>, alice@example.com", 0, alternate)).toBe(
    "John Smith <john@work.com>, alice@example.com",
  );
  expect(recipientLabel(alternate, false)).toBe("John Smith");
  expect(recipientLabel(alternate, true)).toBe("John Smith <john@work.com>");
});
it("signature selection and local-copy status survive opening a saved draft and closing cleanly", () => {
  const d = { ...emptyDraft("account"), to: "j@acme.com", subject: "Hello", signatureId: "sig:1" };
  const stored = {
    id: d.id,
    accountId: d.accountId,
    message: toMessage(d).message,
    updatedAt: 1,
    proposalId: null,
    synced: false,
    localOnly: true,
    syncError: null,
  };
  const opened = fromStored(stored);
  expect(opened.signatureId).toBe("sig:1");
  expect(opened.localOnly).toBe(true);
  expect(needsClosePrompt(opened, stored)).toBe(false);
  expect(needsClosePrompt({ ...opened, subject: "Unsaved edit" }, stored)).toBe(true);
});
it("reply draft uses the received alias before signature selection", () => {
  const account: Account = {
    id: "gmail:me@example.com",
    provider: "gmail",
    email: "me@example.com",
    createdAt: 0,
    lastSyncedAt: null,
    lastSyncError: null,
    needsReauth: false,
    profileId: null,
  };
  const alias = {
    accountId: account.id,
    address: "alias@example.com",
    name: "Alias",
    isDefault: false,
    signature: "",
  };
  const message: Message = {
    id: "one",
    accountId: account.id,
    threadId: "one",
    from: { name: "Alice", address: "alice@example.com" },
    to: [{ name: "", address: alias.address }],
    cc: [],
    subject: "Hello",
    snippet: "",
    date: 0,
    labels: [],
    bodyText: "Hello",
    bodyHtml: "",
    attachments: [],
    isUnread: false,
    isStarred: false,
    hasAttachments: false,
  };
  expect(
    draftFor("reply", message, account, false, [alias], undefined, {
      preference: "received",
      aliases: [alias],
    }).from,
  ).toEqual({ name: "Alias", address: alias.address });
  expect(
    draftFor("reply", message, account, false, [alias], undefined, {
      preference: "default",
      aliases: [alias],
    }).from?.address,
  ).toBe(account.email);
});

it("alternate-address edits use the same filtered chip index as moving a recipient", () => {
  const alternate = { name: "Jane", address: "jane@work.com" };
  const value = ", , John <j@acme.com>, , alice@example.com, ;";
  expect(replaceRecipient(value, 0, alternate)).toBe("Jane <jane@work.com>, alice@example.com");
  expect(replaceRecipient(value, 1, alternate)).toBe("John <j@acme.com>, Jane <jane@work.com>");
});

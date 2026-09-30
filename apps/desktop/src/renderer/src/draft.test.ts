import { describe, expect, it } from "vitest";
import {
  changeComposeBodyKind,
  richComposeBody,
  remoteComposeBody,
  editedComposeBody,
  composeConversion,
} from "@openmail/core/schema";
import type { Account, Message } from "../../shared/api";
import {
  draftFor,
  formatAddress,
  parseAddresses,
  toMessage,
  emptyDraft,
  fromStored,
  isEmpty,
  toDraftInput,
} from "./draft";

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
const alias = (accountId: string, address = "alias@example.com") => ({ accountId, address });
const message: Message = {
  id: `${account.id}/one`,
  accountId: account.id,
  threadId: "thread",
  subject: "Question",
  from: { name: "Sender", address: "sender@example.com" },
  to: [
    { name: "Me", address: account.email },
    { name: "Other", address: "other@example.com" },
  ],
  cc: [{ name: "Alias", address: "alias@example.com" }],
  replyTo: [{ name: 'Team, "Support"', address: "reply@example.com" }],
  date: 1000,
  snippet: "",
  labels: [],
  bodyText: "Question",
  bodyHtml: "",
  attachments: [],
  isUnread: false,
  isStarred: false,
  hasAttachments: false,
};

it("reply drafts preserve quoted names, Reply-To and original threading", () => {
  for (const mode of ["reply", "replyAll"] as const) {
    const draft = draftFor(mode, message, account, false, [alias(account.id, "ALIAS@example.com")]);
    const { message: outgoing, invalid } = toMessage(draft);
    expect(invalid).toEqual([]);
    expect(outgoing.to).toEqual(message.replyTo);
    expect(outgoing.cc).toEqual(mode === "replyAll" ? [message.to[1]] : []);
    expect(outgoing.inReplyTo).toBe(message.id);
    expect(outgoing.subject).toBe("Re: Question");
  }
});

it("replying in a second account treats the first account and its aliases as recipients", () => {
  const replyingAccount: Account = {
    ...account,
    id: "outlook:other@example.com",
    provider: "outlook",
    email: "other@example.com",
  };
  const fromFirstAccount = {
    ...message,
    accountId: replyingAccount.id,
    from: { name: "First account", address: account.email },
    to: [{ name: "Second account", address: replyingAccount.email }],
    cc: [{ name: "First alias", address: "alias@example.com" }],
    replyTo: [],
  };
  for (const mode of ["reply", "replyAll"] as const) {
    const { message: outgoing, invalid } = toMessage(
      draftFor(mode, fromFirstAccount, replyingAccount, false, [
        alias(account.id, account.email),
        alias(account.id),
        alias(replyingAccount.id, "own-alias@outlook.com"),
      ]),
    );
    expect(invalid).toEqual([]);
    expect(outgoing.to).toEqual([fromFirstAccount.from]);
    expect(outgoing.cc).toEqual(mode === "replyAll" ? fromFirstAccount.cc : []);
  }
});

it("replying from an own alias targets original recipients, and forwarding starts empty", () => {
  const self = { ...message, from: { name: "Alias", address: "ALIAS@example.com" } };
  expect(
    toMessage(draftFor("replyAll", self, account, false, [alias(account.id)])).message.to,
  ).toEqual([message.to[1]]);
  const draft = draftFor("forward", message, account, true, [alias(account.id)]);
  expect(draft.to).toBe("");
  expect(draft.cc).toBe("");
  expect(draft.forwardAsAttachment).toBe(true);
});

it("IMAP replies exclude only its login address and account aliases", () => {
  const imapAccount: Account = {
    ...account,
    id: "imap:me@example.com",
    provider: "imap",
    imap: {
      preset: "custom",
      username: "login@example.com",
      imapHost: "imap.example.com",
      imapPort: 993,
      smtpHost: "smtp.example.com",
      smtpPort: 465,
      smtpSecure: true,
    },
  };
  const incoming = {
    ...message,
    replyTo: [
      ...(message.replyTo ?? []),
      { name: "Login", address: "LOGIN@example.com" },
      { name: "Second account", address: "second@example.com" },
    ],
  };
  const { message: outgoing, invalid } = toMessage(
    draftFor("replyAll", incoming, imapAccount, false, [
      alias(imapAccount.id),
      alias("gmail:second@example.com", "second@example.com"),
    ]),
  );
  expect(invalid).toEqual([]);
  expect(outgoing.to).toEqual([
    ...(message.replyTo ?? []),
    { name: "Second account", address: "second@example.com" },
  ]);
  expect(outgoing.cc).toEqual([message.to[1]]);
});

it("formatted names round-trip through recipient parsing with all supported separators", () => {
  const addresses = [
    { name: 'Doe, "Jane"', address: "jane@example.com" },
    { name: "李；雷", address: "li@example.com" },
    { name: "Path\\Team", address: "team@example.com" },
    { name: "Support: East", address: "support@example.com" },
  ];
  for (const separator of [", ", "; ", "，", "；", "\n"]) {
    expect(parseAddresses(addresses.map(formatAddress).join(separator))).toEqual({
      addresses,
      invalid: [],
    });
  }
});

it("pasted RFC groups become sendable recipients without empty-group placeholders", () => {
  expect(parseAddresses("Team: a@x.com, Bob <b@x.com>;, undisclosed-recipients:;")).toEqual({
    addresses: [
      { name: "", address: "a@x.com" },
      { name: "Bob", address: "b@x.com" },
    ],
    invalid: [],
  });
});

const stored = (draft: ReturnType<typeof emptyDraft>) => ({
  ...toDraftInput(draft),
  updatedAt: 1,
  proposalId: null,
  synced: true,
});

describe("compose draft model", () => {
  it("editing remote HTML drops inline image files before the UI saves or sends, but keeps ordinary files", () => {
    const body = remoteComposeBody('<img src="cid:logo@example.com">before');
    const normal = { filename: "normal.png", mimeType: "image/png", content: "aGk=" };
    const inline = { ...normal, filename: "logo.png", contentId: "logo@example.com" };
    const draft = { ...emptyDraft("gmail:a"), body, attachments: [normal, inline] };
    expect(toMessage(draft).message.attachments).toEqual([normal, inline]);
    const edited = { ...draft, body: editedComposeBody(body, "after") };
    expect(toMessage(edited).message.attachments).toEqual([normal]);
    expect(toDraftInput(edited).message.attachments).toEqual([normal]);
    expect(toMessage(edited).message.originalHtml).toBeUndefined();
  });
  it("closing an image-only remote draft does not classify it as empty and discard its source", () => {
    const source = '<img src="https://example.com/logo.png">';
    const draft = { ...emptyDraft("gmail:a"), body: remoteComposeBody(source) };
    expect(draft.body.text).toBe("");
    expect(isEmpty(draft)).toBe(false);
    expect(toDraftInput(draft).message.originalHtml).toBe(source);
  });
  it("keeps remote source over recipient edits and drops it only after editing the body", () => {
    const source =
      '<p style="color:red">Hello <a href="https://example.com">details</a></p><img src="https://example.com/logo.png">';
    const body = remoteComposeBody(source);
    const draft = { ...emptyDraft("gmail:a"), body };
    const reopened = fromStored(stored(draft));
    const changedRecipients = { ...reopened, to: "bob@example.com" };
    expect(toMessage(changedRecipients).message.originalHtml).toBe(source);
    expect(
      toMessage({
        ...changedRecipients,
        body: editedComposeBody(body, body.html.replace("Hello", "Edited")),
      }).message.originalHtml,
    ).toBeUndefined();
  });
  it("a mode-change undo snapshot restores full HTML and its untouched remote source", () => {
    const original = {
      ...emptyDraft("gmail:a"),
      body: remoteComposeBody(
        '<p style="color:red"><b>Hello</b> <a href="https://example.com">details</a></p>',
      ),
    };
    const snapshot = original.body;
    const conversion = composeConversion(snapshot, "plain");
    expect(conversion.losesFormatting).toBe(true);
    const converted = { ...original, body: conversion.body };
    expect(toMessage(converted).message.text).toContain("details <https://example.com>");
    expect(toMessage(converted).message.originalHtml).toBeUndefined();
    expect(toMessage({ ...converted, body: snapshot }).message).toEqual(
      toMessage(original).message,
    );
  });
  it("saves and reopens rich formatting, including an HTML-only remote draft", () => {
    const draft = {
      ...emptyDraft("gmail:a"),
      to: "Bob <bob@example.com>",
      body: richComposeBody(
        '<b>你好</b> <i>italic</i> <u>under</u> <a href="https://example.com">link</a>',
      ),
    };
    const saved = stored(draft);
    expect(saved.message.text).toBe("你好 italic under link <https://example.com>");
    expect(fromStored(saved).body).toEqual(draft.body);
    expect(toMessage(fromStored(saved)).message).toEqual(saved.message);
    expect(
      fromStored({
        ...saved,
        message: { ...saved.message, text: "", html: "<b>remote</b><script>bad()</script>" },
      }).body,
    ).toEqual({ kind: "rich", text: "remote", html: "<strong>remote</strong>" });
  });

  it("preserves explicit plain/Markdown mode across save, reopen and send", () => {
    for (const kind of ["plain", "markdown"] as const) {
      const draft = { ...emptyDraft("gmail:a"), body: { kind, text: "**literal source**" } };
      const saved = stored(draft);
      expect(saved.message.html).toBeUndefined();
      expect(fromStored(saved).body).toEqual(draft.body);
      expect(saved.message.markdown ?? false).toBe(kind === "markdown");
    }
  });

  it("switching to plain text strips formatting; switching back escapes markup", () => {
    const rich = richComposeBody("<strong>one</strong><br>&lt;img&gt;");
    const plain = changeComposeBodyKind(rich, "plain");
    expect(plain).toEqual({ kind: "plain", text: "one\n<img>" });
    expect(changeComposeBodyKind(plain, "rich")).toEqual({
      kind: "rich",
      text: "one\n<img>",
      html: "one<br>&lt;img&gt;",
    });
  });

  it("default new drafts use rich text; empty formatting and scripts carry no body", () => {
    const draft = emptyDraft("gmail:a");
    expect(draft.body.kind).toBe("rich");
    expect(isEmpty({ ...draft, body: richComposeBody("<b></b><script>bad()</script>") })).toBe(
      true,
    );
    expect(isEmpty({ ...draft, body: richComposeBody("<u>text</u>") })).toBe(false);
  });
});

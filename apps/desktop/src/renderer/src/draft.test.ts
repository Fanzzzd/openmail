import { expect, it } from "vitest";

import type { Account, Message } from "../../shared/api";
import { draftFor, formatAddress, parseAddresses, toMessage } from "./draft";

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

import { describe, expect, it } from "vitest";
import {
  richComposeBody,
  remoteComposeBody,
  editedComposeBody,
  applySignature,
  composeConversion,
  preservedComposeHtml,
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
  needsClosePrompt,
  switchReplyMode,
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

it("forward preserves sanitized HTML while reply/forward selected quotes contain only selected text", () => {
  const source = {
    ...message,
    bodyText: "Whole message",
    bodyHtml:
      '<table><tr><td style="color:red">Whole message</td></tr></table><script>evil()</script><img src="https://evil.test/track">',
  };
  const forward = draftFor("forward", source, account);
  const sent = toMessage(forward).message;
  expect(forward.includeOriginalAttachments).toBe(true);
  const transportHtml = preservedComposeHtml(sent.originalHtml ?? sent.html ?? "");
  expect(transportHtml).toContain("<table>");
  expect(transportHtml).toContain('style="color:red"');
  expect(transportHtml).not.toContain("script");
  expect(forward.body.kind === "rich" ? forward.body.html : "").not.toContain("https://evil.test");
  for (const mode of ["reply", "replyAll", "forward"] as const) {
    const draft = draftFor(mode, source, account, false, [], "Chosen <text>");
    const outgoing = toMessage(draft).message;
    expect(outgoing.text).toContain("Chosen <text>");
    expect(outgoing.text).not.toContain("Whole message");
    expect(outgoing.html).toContain("Chosen &lt;text&gt;");
    expect(outgoing.html).not.toContain("<table>");
    expect(draft.includeOriginalAttachments).toBe(mode === "forward");
  }
});

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

it("Outlook forwards retain large originals on the server without scheduling a MIME fetch", () => {
  const outlook = { ...account, provider: "outlook" } satisfies Account;
  const draft = draftFor(
    "forward",
    {
      ...message,
      attachments: [{ filename: "large.pdf", mimeType: "application/pdf", size: 5 * 1024 * 1024 }],
    },
    outlook,
  );
  expect(draft.includeOriginalAttachments).toBeUndefined();
  expect(draft.attachments).toEqual([]);
  expect(toMessage(draft).message.includeOriginalAttachments).toBeUndefined();
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
    const plain = composeConversion(rich, "plain").body;
    expect(plain).toEqual({ kind: "plain", text: "one\n<img>" });
    expect(composeConversion(plain, "rich").body).toEqual({
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

it("switching Reply / Reply All / Forward preserves typed rich body, identity and attachments", () => {
  const draft = {
    ...draftFor("reply", message, account),
    body: richComposeBody("<p>My <b>edited</b> reply</p>"),
    attachments: [{ filename: "note.txt", mimeType: "text/plain", content: "aGk=" }],
    bcc: "private@example.com",
    from: { name: "", address: account.email },
  };
  const all = switchReplyMode(draft, "replyAll", message, account, [alias(account.id)]);
  expect(toMessage(all).message.to).toEqual(message.replyTo);
  expect(toMessage(all).message.cc).toEqual([message.to[1]]);
  expect(all.body).toBe(draft.body);
  expect(all.attachments).toBe(draft.attachments);
  expect(all.id).toBe(draft.id);
  const forward = switchReplyMode(all, "forward", message, account, []);
  expect(forward.to).toBe("");
  expect(forward.cc).toBe("");
  expect(forward.bcc).toBe(draft.bcc);
  expect(forward.subject).toBe("Fwd: Question");
  expect(forward.body).toBe(draft.body);
  const reply = switchReplyMode(forward, "reply", message, account, []);
  expect(reply.subject).toBe("Re: Question");
  expect(reply.from).toEqual(draft.from);
  expect(
    switchReplyMode({ ...draft, subject: "Edited subject" }, "forward", message, account, [])
      .subject,
  ).toBe("Edited subject");
});

it("closing asks only for nonempty, unsaved or remotely unsynced versions", () => {
  const draft = {
    ...emptyDraft(account.id),
    to: "bob@example.com",
    subject: "Saved",
    body: richComposeBody("<p>Hi</p>"),
  };
  const stored = { ...toDraftInput(draft), updatedAt: 1, proposalId: null, synced: true };
  expect(needsClosePrompt(emptyDraft(account.id), null)).toBe(false);
  expect(needsClosePrompt(draft, null)).toBe(true);
  expect(needsClosePrompt(draft, stored)).toBe(false);
  expect(needsClosePrompt(draft, { ...stored, synced: false })).toBe(true);
  expect(needsClosePrompt({ ...draft, subject: "Edited" }, stored)).toBe(true);
  expect(needsClosePrompt({ ...draft, cc: "unfinished" }, stored)).toBe(true);
  expect(needsClosePrompt({ ...draft, accountId: "another" }, stored)).toBe(true);
});

it("an empty new draft with only the automatic signature does not prompt", () => {
  const signature = "My name";
  const draft = {
    ...emptyDraft(account.id),
    body: richComposeBody(
      `<p>${applySignature("", undefined, signature).replaceAll("\n", "<br>")}</p>`,
    ),
  };
  expect(isEmpty(draft, signature)).toBe(true);
  expect(isEmpty({ ...draft, subject: "Subject" }, signature)).toBe(false);
});

it("mode switches retain manual To/Cc/Bcc, remove previous automatic recipients and deduplicate across fields", () => {
  const aliases = [alias(account.id)];
  const automatic = draftFor("replyAll", message, account, false, aliases);
  const edited = {
    ...automatic,
    to: `${automatic.to}, Manual <manual@example.com>`,
    cc: `${automatic.cc}, Extra <extra@example.com>, MANUAL@example.com`,
    bcc: "Private <private@example.com>",
  };
  const reply = switchReplyMode(edited, "reply", message, account, aliases);
  expect(parseAddresses(reply.to).addresses.map((a) => a.address)).toEqual([
    "reply@example.com",
    "manual@example.com",
  ]);
  expect(parseAddresses(reply.cc).addresses.map((a) => a.address)).toEqual(["extra@example.com"]);
  expect(reply.bcc).toBe(edited.bcc);
  const forward = switchReplyMode(reply, "forward", message, account, aliases);
  expect(parseAddresses(forward.to).addresses.map((a) => a.address)).toEqual([
    "manual@example.com",
  ]);
  expect(parseAddresses(forward.cc).addresses.map((a) => a.address)).toEqual(["extra@example.com"]);
  const all = switchReplyMode(forward, "replyAll", message, account, aliases);
  expect(parseAddresses(all.to).addresses.map((a) => a.address)).toEqual([
    "reply@example.com",
    "manual@example.com",
  ]);
  expect(parseAddresses(all.cc).addresses.map((a) => a.address)).toEqual([
    "other@example.com",
    "extra@example.com",
  ]);
  expect(all.bcc).toBe(edited.bcc);
});

it("untouched never-stored reply and forward close without a save prompt", () => {
  for (const mode of ["reply", "forward"] as const) {
    const initial = draftFor(mode, message, account);
    expect(needsClosePrompt(initial, null, { initial })).toBe(false);
    expect(needsClosePrompt({ ...initial, subject: "Edited" }, null, { initial })).toBe(true);
  }
});

it("empty drafts close quietly only when never stored or unchanged; clearing a stored draft asks", () => {
  const empty = emptyDraft(account.id);
  expect(needsClosePrompt(empty, null, { initial: empty })).toBe(false);
  const storedEmpty = { ...toDraftInput(empty), updatedAt: 1, proposalId: null, synced: true };
  expect(needsClosePrompt(empty, storedEmpty, { initial: empty })).toBe(false);
  const initial = { ...empty, to: "bob@example.com", subject: "Saved content" };
  const stored = { ...toDraftInput(initial), updatedAt: 1, proposalId: null, synced: true };
  expect(needsClosePrompt(empty, stored, { initial })).toBe(true);
  expect(needsClosePrompt(empty, storedEmpty, { initial })).toBe(true);
});

it("a signature without its separator still counts as an untouched empty compose", () => {
  const draft = emptyDraft(account.id);
  const options = { signaturePosition: "below", signatureSeparator: false } as const;
  const automatic = {
    ...draft,
    body: { kind: "plain", text: applySignature("", undefined, "Me", options) } as const,
  };
  expect(isEmpty(automatic, "Me", options)).toBe(true);
  expect(
    isEmpty({ ...automatic, body: { kind: "plain", text: "Authored\n\nMe" } }, "Me", options),
  ).toBe(false);
});

it("AI provenance survives reopening and autosave serialization", () => {
  const message = {
    to: [],
    cc: [],
    bcc: [],
    subject: "AI",
    text: "Draft",
    attachments: [],
    agentOrigin: { recipients: ["new@example.com"], replyTo: "original" },
  };
  const draft = fromStored({
    id: "ai-draft",
    accountId: "a",
    message,
    updatedAt: 1,
    synced: false,
    proposalId: 1,
  });
  expect(toMessage(draft).message.agentOrigin).toEqual(message.agentOrigin);
});

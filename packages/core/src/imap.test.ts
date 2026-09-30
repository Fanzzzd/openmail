import { assert, it, layer } from "@effect/vitest";

import { Effect, Exit, Layer, Option, Stream } from "effect";
import { vi } from "vitest";
import { ImapFlow, type ListResponse } from "imapflow";
import { simpleParser } from "mailparser";

import type { Account } from "./domain.js";
import { IMAP_PRESETS, type ImapConnectInput } from "./imap-presets.js";
import {
  attachmentNodes,
  decodeProviderId,
  FolderState,
  encodeProviderId,
  makeImap,
  makeImapWith,
  mapFolders,
  parseHeaders,
  parseUidSet,
  readCursor,
  resolveImapSettings,
  stripBcc,
  threadIdOf,
  toIncoming,
  uidSet,
} from "./imap.js";
import { Secrets } from "./services.js";

const folder = (path: string, specialUse?: string, flags: string[] = [], delimiter = "/") => ({
  path,
  delimiter,
  flags: new Set(flags),
  ...(specialUse ? { specialUse } : {}),
});

it("maps special-use folders to system labels and the rest to user labels", () => {
  const folders = mapFolders([
    folder("INBOX", "\\Inbox"),
    folder("Sent Messages", "\\Sent"),
    folder("Drafts", "\\Drafts"),
    folder("Junk", "\\Junk"),
    folder("Deleted Messages", "\\Trash"),
    folder("Archive", "\\Archive"),
    folder("[Gmail]/All Mail", "\\All"),
    folder("[Gmail]/Starred", "\\Flagged"),
    folder("[Gmail]", undefined, ["\\Noselect"]),
    folder("其他文件夹.客户.报价", undefined, [], "."),
  ]);
  assert.deepStrictEqual(
    folders.map((f) => [f.path, f.label, f.userName]),
    [
      ["INBOX", "INBOX", undefined],
      ["Sent Messages", "SENT", undefined],
      ["Drafts", "DRAFT", undefined],
      ["Junk", "SPAM", undefined],
      ["Deleted Messages", "TRASH", undefined],
      ["Archive", "ARCHIVE", undefined],
      ["其他文件夹.客户.报价", "其他文件夹.客户.报价", "其他文件夹/客户/报价"],
    ],
  );
});

it("treats INBOX as the inbox even without a special-use flag", () => {
  assert.strictEqual(mapFolders([folder("inbox")])[0]?.label, "INBOX");
});

it("thread id is the root of the reply chain", () => {
  assert.strictEqual(
    threadIdOf({
      messageId: "<c@x>",
      inReplyTo: "<b@x>",
      references: ["<a@x>", "<b@x>"],
    }),
    "a@x",
  );
  assert.strictEqual(threadIdOf({ messageId: "<c@x>", references: "<a@x> <b@x>" }), "a@x");
  assert.strictEqual(threadIdOf({ messageId: "<c@x>", inReplyTo: "<b@x>" }), "b@x");
  assert.strictEqual(threadIdOf({ messageId: "<c@x>" }), "c@x");
  assert.strictEqual(threadIdOf({ messageId: "bare@x" }), "bare@x");
  assert.strictEqual(threadIdOf({}), undefined);
});

it("provider ids round-trip, including paths with colons", () => {
  const id = encodeProviderId("Work:2026/报价", 1_700_000_000n, 42);
  assert.deepStrictEqual(
    decodeProviderId(id),
    Option.some({ uidValidity: "1700000000", uid: 42, path: "Work:2026/报价" }),
  );
  assert.ok(Option.isNone(decodeProviderId("gmail-id-abc")));
});

it("uid sets compact and expand", () => {
  assert.strictEqual(uidSet([9, 1, 2, 3, 7, 10, 3]), "1:3,7,9:10");
  assert.deepStrictEqual(parseUidSet("1:3,7,9:10"), [1, 2, 3, 7, 9, 10]);
  assert.strictEqual(uidSet([]), "");
  assert.deepStrictEqual(parseUidSet(""), []);
});

const rejects = (input: ImapConnectInput) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(resolveImapSettings(input));
    assert.ok(Exit.isFailure(exit), JSON.stringify(input));
  });

it.effect("resolves presets and validates custom servers", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(
      yield* resolveImapSettings({ preset: "qq", email: " me@qq.com ", password: "code" }),
      {
        preset: "qq",
        username: "me@qq.com",
        imapHost: "imap.qq.com",
        imapPort: 993,
        smtpHost: "smtp.qq.com",
        smtpPort: 465,
        smtpSecure: true,
      },
    );
    const icloud = yield* resolveImapSettings({
      preset: "icloud",
      email: "a@icloud.com",
      password: "p",
    });
    assert.strictEqual(icloud.smtpPort, 587);
    assert.strictEqual(icloud.smtpSecure, false);

    const custom = yield* resolveImapSettings({
      preset: "custom",
      email: "me@example.com",
      username: "me",
      password: "p",
      imapHost: "mail.example.com",
      smtpHost: "smtp.example.com",
      smtpPort: 587,
    });
    assert.strictEqual(custom.username, "me");
    assert.strictEqual(custom.imapPort, 993);
    assert.strictEqual(custom.smtpSecure, false);

    yield* rejects({ preset: "custom", email: "me@example.com", password: "p" });
    yield* rejects({ preset: "nope", email: "me@example.com", password: "p" });
    yield* rejects({ preset: "qq", email: "not-an-email", password: "p" });
    yield* rejects({ preset: "qq", email: "me@qq.com", password: "" });
    yield* rejects({ preset: "qq", email: "me@qq.com", password: "p", imapPort: 70000 });
  }),
);

it("reads cursors, and starts over on a missing or foreign one", () => {
  const folder = {
    uidValidity: "7",
    lastUid: 12,
    modseq: "99",
    uids: "1:3,12",
    unread: "2",
    starred: "12",
  };
  const cursor = { folders: { INBOX: folder } };
  assert.deepStrictEqual(readCursor(Option.some(JSON.stringify(cursor))), cursor);
  assert.deepStrictEqual(readCursor(Option.none()), { folders: {} });
  assert.deepStrictEqual(readCursor(Option.some("not json")), { folders: {} });
  assert.deepStrictEqual(readCursor(Option.some('{"historyId":"5"}')), { folders: {} });
  // Cursors written before flags were tracked have no unread/starred sets.
  const old = readCursor(
    Option.some('{"folders":{"INBOX":{"uidValidity":"7","lastUid":3,"uids":"1:3"}}}'),
  );
  assert.deepStrictEqual(old.folders.INBOX, {
    uidValidity: "7",
    lastUid: 3,
    uids: "1:3",
    unread: "",
    starred: "",
  });
});

it("every preset has hosts, a password page and a note", () => {
  for (const [key, p] of Object.entries(IMAP_PRESETS)) {
    assert.ok(p.imapHost && p.smtpHost, key);
    assert.ok(p.appPasswordUrl?.startsWith("https://"), key);
    assert.ok(p.note, key);
  }
});

const RAW = [
  "From: 王工 <wang@163.com>",
  "To: Me <me@qq.com>",
  "Bcc: secret@x.com,",
  " other@x.com",
  "Subject: =?UTF-8?B?5oql5Lu356Gu6K6k?=",
  "Message-ID: <c@x>",
  "In-Reply-To: <b@x>",
  "References: <a@x>",
  "\t<b@x>",
  "Date: Sun, 20 Sep 2026 10:30:00 +0800",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="b1"',
  "",
  "--b1",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<p>已确认<b>报价</b></p>",
  "--b1",
  'Content-Type: application/pdf; name="quote.pdf"',
  'Content-Disposition: attachment; filename="quote.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  "JVBERi0=",
  "--b1--",
  "",
].join("\r\n");

it("parses headers with folding", () => {
  const h = parseHeaders(RAW);
  assert.strictEqual(h.get("references"), "<a@x> <b@x>");
  assert.strictEqual(h.get("message-id"), "<c@x>");
  assert.strictEqual(h.get("content-transfer-encoding"), undefined);
});

it("strips Bcc and its continuation lines, leaving the rest byte for byte", () => {
  const out = stripBcc(Buffer.from(RAW, "utf8")).toString("utf8");
  assert.ok(!/bcc/i.test(out));
  assert.ok(!out.includes("other@x.com"));
  assert.strictEqual(out, RAW.replace("Bcc: secret@x.com,\r\n other@x.com\r\n", ""));
  const lastHeader = "Subject: hi\r\nBcc: a@x.com\r\n\r\nbody";
  assert.strictEqual(stripBcc(Buffer.from(lastHeader)).toString(), "Subject: hi\r\n\r\nbody");
});

it.effect("maps a parsed message onto the store shape", () =>
  Effect.gen(function* () {
    const parsed = yield* Effect.promise(() => simpleParser(Buffer.from(RAW, "utf8")));
    const m = toIncoming(parsed, {
      providerId: encodeProviderId("INBOX", 7n, 12),
      label: "INBOX",
      flags: new Set(["\\Flagged"]),
      internalDate: new Date("2026-09-20T02:31:00Z"),
    });
    assert.strictEqual(m.providerId, "7:12:INBOX");
    assert.strictEqual(m.threadId, "a@x");
    assert.strictEqual(m.subject, "报价确认");
    assert.deepStrictEqual(m.from, { name: "王工", address: "wang@163.com" });
    assert.deepStrictEqual(m.to, [{ name: "Me", address: "me@qq.com" }]);
    assert.strictEqual(m.date, Date.parse("2026-09-20T02:31:00Z"));
    assert.strictEqual(m.bodyText.trim(), "已确认报价");
    assert.strictEqual(m.snippet, "已确认报价");
    assert.deepStrictEqual(m.labels, ["INBOX", "UNREAD", "STARRED"]);
    assert.strictEqual(m.isUnread, true);
    assert.strictEqual(m.isStarred, true);
    assert.deepStrictEqual(m.attachments, [
      { filename: "quote.pdf", mimeType: "application/pdf", size: 5 },
    ]);
  }),
);

const account: Account = {
  id: "imap:me@qq.com",
  provider: "imap",
  email: "me@qq.com",
  createdAt: 0,
  lastSyncedAt: null,
  lastSyncError: null,
  profileId: null,
  needsReauth: false,
  imap: {
    preset: "qq",
    username: "me@qq.com",
    imapHost: "imap.qq.com",
    imapPort: 993,
    smtpHost: "smtp.qq.com",
    smtpPort: 465,
    smtpSecure: true,
  },
};

const errorTag = <A, E extends { _tag: string }>(exit: Exit.Exit<A, E>) =>
  Exit.findErrorOption(exit).pipe(Option.map((e) => e._tag));

// Neither test reaches the network: both stop before a connection opens.
layer(
  Layer.succeed(Secrets, {
    get: () => Effect.succeed(Option.none()),
    set: () => Effect.void,
    remove: () => Effect.void,
  }),
)("with an empty keychain", (it) => {
  it.effect("pull fails with AuthError when the keychain has no password", () =>
    Effect.gen(function* () {
      const imap = yield* makeImap;
      const exit = yield* Effect.exit(Stream.runCollect(imap.pull(account, Option.none())));
      assert.ok(Exit.isFailure(exit));
      assert.deepStrictEqual(errorTag(exit), Option.some("AuthError"));
    }),
  );

  it.effect("push rejects ids that are not IMAP ids without connecting", () =>
    Effect.gen(function* () {
      const imap = yield* makeImap;
      const exit = yield* Effect.exit(
        imap.push(account, "gmail-id", { kind: "read", value: true }),
      );
      assert.deepStrictEqual(errorTag(exit), Option.some("PermanentError"));
    }),
  );
});

it("a flag fetch turns into Deletes for gone UIDs and Flags for changed ones", () => {
  const state = FolderState.from({
    uidValidity: "7",
    lastUid: 4,
    uids: "1:4",
    unread: "1:2",
    starred: "3",
  });
  const unchanged = { unread: true, starred: false };
  const changes = state.reconcile(
    "INBOX",
    new Set([1, 2, 3]),
    new Map([
      [1, unchanged],
      // Read elsewhere.
      [2, { unread: false, starred: false }],
      // Unstarred and marked unread.
      [3, { unread: true, starred: false }],
      // Gone from `present`, so its flags are ignored.
      [4, { unread: true, starred: true }],
    ]),
  );
  assert.deepStrictEqual(changes, [
    { _tag: "Delete", providerId: "7:4:INBOX" },
    { _tag: "Flags", providerId: "7:2:INBOX", isUnread: false, isStarred: false },
    { _tag: "Flags", providerId: "7:3:INBOX", isUnread: true, isStarred: false },
  ]);
  // The cursor remembers the new state, so the next sync reports nothing.
  assert.deepStrictEqual(state.toCursor(), {
    uidValidity: "7",
    lastUid: 4,
    uids: "1:3",
    unread: "1,3",
    starred: "",
  });
  assert.deepStrictEqual(
    state.reconcile("INBOX", new Set([1, 2, 3]), new Map([[2, { unread: false, starred: false }]])),
    [],
  );
});

it("attachment parts carry their BODY[part] numbers", () => {
  const nodes = attachmentNodes({
    type: "multipart/mixed",
    childNodes: [
      {
        type: "multipart/alternative",
        part: "1",
        childNodes: [
          { type: "text/plain", part: "1.1" },
          { type: "text/html", part: "1.2" },
        ],
      },
      {
        type: "application/pdf",
        part: "2",
        disposition: "attachment",
        dispositionParameters: { filename: "报价.pdf" },
        size: 10,
      },
      { type: "image/png", part: "3", parameters: { name: "logo.png" } },
    ],
  });
  assert.deepStrictEqual(
    nodes.map((n) => [n.part, n.attachment.filename]),
    [
      ["2", "报价.pdf"],
      ["3", "logo.png"],
    ],
  );
});

it.effect("IMAP folder management uses CREATE/RENAME/DELETE with the server delimiter", () =>
  Effect.gen(function* () {
    const client = new ImapFlow({ host: "fake.invalid", port: 993, logger: false });
    const folders: ListResponse[] = [
      {
        path: "Clients",
        pathAsListed: "Clients",
        name: "Clients",
        delimiter: ".",
        parent: [],
        parentPath: "",
        flags: new Set(),
        listed: true,
        subscribed: true,
      },
    ];
    const list = vi.spyOn(client, "list").mockResolvedValue(folders);
    const create = vi
      .spyOn(client, "mailboxCreate")
      .mockResolvedValue({ path: "Clients.New", created: true });
    const rename = vi
      .spyOn(client, "mailboxRename")
      .mockResolvedValue({ path: "Clients", newPath: "Work.Clients" });
    const remove = vi.spyOn(client, "mailboxDelete").mockResolvedValue({ path: "Clients" });
    assert.ok(account.imap);
    const settings = account.imap;
    const adapter = yield* makeImapWith(() =>
      Effect.succeed({ accountId: account.id, settings, client }),
    );
    yield* adapter.changeLabel(account, { kind: "create", name: "New", parentId: "Clients" });
    yield* adapter.changeLabel(account, { kind: "rename", id: "Clients", name: "Work/Clients" });
    yield* adapter.changeLabel(account, { kind: "delete", id: "Clients" });
    assert.deepStrictEqual(create.mock.calls, [["Clients.New"]]);
    assert.deepStrictEqual(rename.mock.calls, [["Clients", "Work.Clients"]]);
    assert.deepStrictEqual(remove.mock.calls, [["Clients"]]);
    assert.strictEqual(list.mock.calls.length, 6);
  }).pipe(
    Effect.provide(
      Layer.succeed(Secrets, {
        get: () => Effect.succeed(Option.some("password")),
        set: () => Effect.void,
        remove: () => Effect.void,
      }),
    ),
  ),
);

it.effect("IMAP SEARCH scopes folders and postfilters filenames from fetched MIME", () =>
  Effect.gen(function* () {
    const client = new ImapFlow({ host: "fake.invalid", port: 993, logger: false });
    vi.spyOn(client, "list").mockResolvedValue([
      {
        path: "INBOX",
        pathAsListed: "INBOX",
        name: "INBOX",
        delimiter: "/",
        parent: [],
        parentPath: "",
        flags: new Set(),
        listed: true,
        subscribed: true,
      },
      {
        path: "Sent",
        pathAsListed: "Sent",
        name: "Sent",
        delimiter: "/",
        parent: [],
        parentPath: "",
        flags: new Set(),
        specialUse: "\\Sent",
        listed: true,
        subscribed: true,
      },
    ]);
    const open = vi.spyOn(client, "mailboxOpen").mockResolvedValue({
      path: "INBOX",
      delimiter: "/",
      flags: new Set(),
      uidValidity: 7n,
      uidNext: 2,
      exists: 1,
    });
    const search = vi.spyOn(client, "search").mockResolvedValue([1]);
    const mime = Buffer.from(
      'From: alice@example.com\r\nTo: me@qq.com\r\nSubject: Report\r\nMessage-ID: <r@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="x"\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nreport\r\n--x\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="report.pdf"\r\n\r\npdf\r\n--x--\r\n',
    );
    vi.spyOn(client, "fetchAll").mockResolvedValue([
      {
        seq: 1,
        uid: 1,
        flags: new Set(),
        internalDate: new Date("2026-09-30"),
        size: mime.length,
        source: mime,
      },
    ]);
    assert.ok(account.imap);
    const settings = account.imap;
    const adapter = yield* makeImapWith(() =>
      Effect.succeed({ accountId: account.id, settings, client }),
    );
    const page = yield* adapter.search(account, {
      search: "from:alice filename:pdf is:unread",
      searchScope: "folder",
      mailbox: "inbox",
    });
    assert.strictEqual(page.messages.length, 1);
    assert.strictEqual(page.messages[0]?.attachments[0]?.filename, "report.pdf");
    assert.deepStrictEqual(search.mock.calls, [[{ from: "alice", seen: false }, { uid: true }]]);
    assert.deepStrictEqual(open.mock.calls, [["INBOX", { readOnly: true }]]);
  }).pipe(
    Effect.provide(
      Layer.succeed(Secrets, {
        get: () => Effect.succeed(Option.some("password")),
        set: () => Effect.void,
        remove: () => Effect.void,
      }),
    ),
  ),
);

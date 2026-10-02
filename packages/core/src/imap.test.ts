import { assert, it, layer } from "@effect/vitest";

import { Effect, Exit, Layer, Option, Stream } from "effect";
import { vi } from "vitest";
import { ImapFlow, type ListResponse } from "imapflow";
import { simpleParser } from "mailparser";
import { createServer } from "node:net";
import { createTransport } from "nodemailer";

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
  trackImapBackfill,
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

it.effect(
  "SMTP SIZE rejects encoded MIME before MAIL FROM or DATA, even when raw attachments fit",
  () =>
    Effect.gen(function* () {
      const commands: string[] = [];
      const server = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const server = createServer((socket) => {
            socket.write("220 fake SMTP ready\r\n");
            let pending = "";
            socket.on("data", (bytes) => {
              pending += bytes.toString();
              let end: number;
              while ((end = pending.indexOf("\r\n")) >= 0) {
                const line = pending.slice(0, end);
                pending = pending.slice(end + 2);
                commands.push(line);
                if (line.startsWith("EHLO")) socket.write("250-fake\r\n250 SIZE 100\r\n");
                else if (line === "QUIT") socket.end("221 bye\r\n");
                else socket.write("250 OK\r\n");
              }
            });
          });
          await new Promise<void>((resolve) => {
            server.listen(0, "127.0.0.1", resolve);
          });
          return server;
        }),
        (server) =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                server.close(() => resolve());
              }),
          ),
      );
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing SMTP test port");
      const settings = account.imap;
      if (!settings) throw new Error("Missing IMAP test settings");
      const client = new ImapFlow({ host: "fake.invalid", port: 993, logger: false });
      const adapter = yield* makeImapWith(
        () => Effect.succeed({ accountId: account.id, settings, client }),
        () =>
          Effect.acquireRelease(
            Effect.sync(() =>
              createTransport({
                host: "127.0.0.1",
                port: address.port,
                secure: false,
                ignoreTLS: true,
              }),
            ),
            (transport) => Effect.sync(() => transport.close()),
          ),
      );
      const error = yield* Effect.flip(
        adapter.send(
          account,
          {
            to: [{ name: "Bob", address: "bob@example.com" }],
            cc: [],
            bcc: [],
            subject: "Small file",
            text: "Body",
            attachments: [{ filename: "a.txt", mimeType: "text/plain", content: "aGk=" }],
          },
          Option.none(),
        ),
      );
      assert.strictEqual(error._tag, "PermanentError");
      assert.include(error.message, "SMTP SIZE");
      assert.include(error.message, "100");
      assert.ok(commands.some((line) => line.startsWith("EHLO")));
      assert.ok(!commands.some((line) => /^(MAIL|RCPT|DATA)/.test(line)));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.succeed(Secrets, {
          get: () => Effect.succeed(Option.some("password")),
          set: () => Effect.void,
          remove: () => Effect.void,
        }),
      ),
    ),
);

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
    open.mockClear();
    search.mockClear();
    const limited = yield* adapter.search(account, { search: "from:alice filename:pdf", limit: 1 });
    assert.strictEqual(limited.messages.length, 1);
    assert.deepStrictEqual(open.mock.calls, [["INBOX", { readOnly: true }]]);
    assert.strictEqual(search.mock.calls.length, 1);
    open.mockClear();
    search.mockClear();
    const suggestedFolder = yield* adapter.search(account, {
      search: 'folder:"inbox" after:2026-09-01 before:2026-10-01',
    });
    assert.strictEqual(suggestedFolder.messages.length, 1);
    assert.deepStrictEqual(open.mock.calls, [["INBOX", { readOnly: true }]]);
    assert.deepStrictEqual(search.mock.calls, [
      [{ since: "2026-09-01", before: "2026-10-01" }, { uid: true }],
    ]);
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

it.effect("inbox polling opens only INBOX and skips folder discovery", () =>
  Effect.gen(function* () {
    const client = new ImapFlow({
      host: "example.com",
      port: 993,
      auth: { user: "me", pass: "fake" },
      logger: false,
    });
    const list = vi.spyOn(client, "list");
    const open = vi.spyOn(client, "mailboxOpen").mockResolvedValue({
      path: "INBOX",
      delimiter: "/",
      flags: new Set(),
      uidValidity: 7n,
      uidNext: 1,
      exists: 0,
    });
    assert.ok(account.imap);
    const settings = account.imap;
    const adapter = yield* makeImapWith(() =>
      Effect.succeed({ accountId: account.id, settings, client }),
    );
    const changes = yield* Stream.runCollect(adapter.pull(account, Option.none(), "inbox"));
    assert.strictEqual(list.mock.calls.length, 0);
    assert.isTrue(open.mock.calls.every(([path]) => path === "INBOX"));
    assert.isFalse(changes.some((change) => change._tag === "Labels"));
    assert.strictEqual(changes.at(-1)?._tag, "Cursor");
  }).pipe(
    Effect.provide(
      Layer.succeed(Secrets, {
        get: () => Effect.succeed(Option.some("fake")),
        set: () => Effect.void,
        remove: () => Effect.void,
      }),
    ),
  ),
);

it.effect("IMAP historical UID ranges resume and reset on UIDVALIDITY changes", () =>
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
    ]);
    let validity = 7n;
    vi.spyOn(client, "mailboxOpen").mockImplementation(() =>
      Promise.resolve({
        path: "INBOX",
        delimiter: "/",
        flags: new Set(),
        uidValidity: validity,
        uidNext: 12001,
        exists: 12000,
      }),
    );
    const search = vi.spyOn(client, "search").mockResolvedValue([]);
    assert.ok(account.imap);
    const settings = account.imap;
    const adapter = yield* makeImapWith(() =>
      Effect.succeed({ accountId: account.id, settings, client }),
    );
    const first = yield* adapter.backfill(account, { cursor: null, before: 1_700_000_000_000 });
    const second = yield* adapter.backfill(account, {
      cursor: first.cursor,
      before: 1_700_000_000_000,
    });
    assert.strictEqual(search.mock.calls[0]?.[0].uid, "7001:12000");
    assert.strictEqual(search.mock.calls[1]?.[0].uid, "2001:7000");
    validity = 8n;
    yield* adapter.backfill(account, { cursor: second.cursor, before: 1_700_000_000_000 });
    assert.strictEqual(search.mock.calls[2]?.[0].uid, "7001:12000");
    search.mockClear();
    const last = yield* adapter.backfill(account, {
      cursor: JSON.stringify({ path: "INBOX", validity: "8", upper: 0 }),
      before: 1_700_000_000_000,
    });
    assert.strictEqual(last.cursor, null);
    assert.strictEqual(search.mock.calls.length, 0);
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

it("historical IMAP tracking preserves checkpoints and detects subsequent flags/deletes", async () => {
  const cursor = Option.some(
    JSON.stringify({
      folders: {
        INBOX: {
          uidValidity: "7",
          lastUid: 120,
          modseq: "100",
          uids: "120",
          unread: "",
          starred: "",
        },
      },
    }),
  );
  const parsed = await simpleParser(Buffer.from("From: a@example.com\r\nSubject: Old\r\n\r\nold"));
  const message = toIncoming(parsed, {
    providerId: encodeProviderId("INBOX", "7", 1),
    label: "INBOX",
    flags: new Set(),
    internalDate: new Date(0),
  });
  const tracked = readCursor(trackImapBackfill(cursor, [message]));
  const folder = tracked.folders["INBOX"];
  assert.ok(folder);
  assert.strictEqual(folder.lastUid, 120);
  assert.strictEqual(folder.modseq, "100");
  assert.strictEqual(folder.uids, "1,120");
  const state = FolderState.from(folder);
  assert.deepStrictEqual(
    state.reconcile("INBOX", new Set([1, 120]), new Map([[1, { unread: false, starred: true }]])),
    [
      {
        _tag: "Flags",
        providerId: encodeProviderId("INBOX", "7", 1),
        isUnread: false,
        isStarred: true,
      },
    ],
  );
  assert.deepStrictEqual(state.reconcile("INBOX", new Set([120]), new Map()), [
    { _tag: "Delete", providerId: encodeProviderId("INBOX", "7", 1) },
  ]);
});

it.effect("IMAP excludes cached and pending UIDs before fetching MIME", () =>
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
    ]);
    vi.spyOn(client, "mailboxOpen").mockResolvedValue({
      path: "INBOX",
      delimiter: "/",
      flags: new Set(),
      uidValidity: 7n,
      uidNext: 4,
      exists: 3,
    });
    vi.spyOn(client, "search").mockResolvedValue([1, 2, 3]);
    const mime = Buffer.from(
      "From: a@example.com\r\nSubject: Old\r\nContent-Type: text/plain\r\n\r\nhello",
    );
    const fetch = vi.spyOn(client, "fetchAll").mockResolvedValue([
      {
        seq: 2,
        uid: 2,
        flags: new Set(),
        internalDate: new Date(0),
        size: mime.length,
        source: mime,
      },
    ]);
    assert.ok(account.imap);
    const settings = account.imap;
    const adapter = yield* makeImapWith(() =>
      Effect.succeed({ accountId: account.id, settings, client }),
    );
    const page = yield* adapter.backfill(
      account,
      { cursor: null, before: 1_700_000_000_000 },
      (ids) => {
        assert.deepStrictEqual(
          ids,
          [3, 2, 1].map((uid) => encodeProviderId("INBOX", "7", uid)),
        );
        return Effect.succeed([encodeProviderId("INBOX", "7", 2)]);
      },
    );
    assert.strictEqual(page.scanned, 3);
    assert.strictEqual(page.messages.length, 1);
    assert.ok(fetch.mock.calls.every((call) => call[0] === "2"));
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

it.effect("IMAP MIME preserves folded and encoded Reply-To names and multiple addresses", () =>
  Effect.gen(function* () {
    for (const header of [
      'Reply-To: =?UTF-8?B?UmVwbHksIFRlYW0=?= <reply@example.com>,\r\n "Doe, Jane" <jane@example.com>\r\n',
      "Reply-To:\r\n",
      "",
    ]) {
      const parsed = yield* Effect.promise(() =>
        simpleParser(
          `From: sender@example.com\r\nTo: me@example.com\r\n${header}Subject: Reply\r\n\r\nHello`,
        ),
      );
      const incoming = toIncoming(parsed, { providerId: "one", label: "INBOX", flags: new Set() });
      assert.deepStrictEqual(
        incoming.replyTo,
        header.includes("reply@example.com")
          ? [
              { name: "Reply, Team", address: "reply@example.com" },
              { name: "Doe, Jane", address: "jane@example.com" },
            ]
          : [],
      );
    }
  }),
);

it.effect("folder ids page across UIDs and permanent deletion requires targeted expunge", () =>
  Effect.gen(function* () {
    const client = new ImapFlow({ host: "fake.invalid", port: 993, logger: false });
    vi.spyOn(client, "list").mockResolvedValue([
      {
        path: "INBOX",
        pathAsListed: "INBOX",
        name: "INBOX",
        parent: [],
        delimiter: "/",
        parentPath: "",
        flags: new Set(),
        specialUse: "\\Inbox",
        listed: true,
        subscribed: true,
      },
      {
        path: "Trash",
        pathAsListed: "Trash",
        name: "Trash",
        parent: [],
        delimiter: "/",
        parentPath: "",
        flags: new Set(),
        specialUse: "\\Trash",
        listed: true,
        subscribed: true,
      },
    ]);
    const open = vi.spyOn(client, "mailboxOpen").mockResolvedValue({
      path: "Trash",
      delimiter: "/",
      flags: new Set(),
      uidValidity: 7n,
      uidNext: 205,
      exists: 204,
    });
    const search = vi
      .spyOn(client, "search")
      .mockResolvedValue(Array.from({ length: 204 }, (_, i) => i + 1));
    const deletion = vi.spyOn(client, "messageDelete").mockResolvedValue(true);
    const flags = vi.spyOn(client, "messageFlagsAdd").mockResolvedValue(true);
    assert.ok(account.imap);
    const settings = account.imap;
    const adapter = yield* makeImapWith(() =>
      Effect.succeed({ accountId: account.id, settings, client }),
    );
    const first = yield* adapter.listFolderMessages(account, { mailbox: "trash" }, null);
    assert.strictEqual(first.ids.length, 100);
    const second = yield* adapter.listFolderMessages(account, { mailbox: "trash" }, first.next);
    assert.strictEqual(second.ids.length, 100);
    const third = yield* adapter.listFolderMessages(account, { mailbox: "trash" }, second.next);
    assert.strictEqual(third.ids.length, 4);
    assert.strictEqual(third.next, null);
    assert.strictEqual(new Set([...first.ids, ...second.ids, ...third.ids]).size, 204);
    assert.ok(open.mock.calls.every(([path]) => path === "Trash"));
    yield* adapter.listFolderMessages(account, { mailbox: "trash" }, null, { unreadOnly: true });
    assert.ok(search.mock.calls.some(([query]) => query.seen === false));
    yield* adapter.markReadBatch(account, first.ids);
    assert.deepStrictEqual(flags.mock.calls, [
      [Array.from({ length: 100 }, (_, i) => i + 1), ["\\Seen"], { uid: true }],
    ]);
    yield* adapter.markReadBatch(account, [
      encodeProviderId("INBOX", "7", 5),
      encodeProviderId("Trash", "7", 9),
    ]);
    assert.strictEqual(flags.mock.calls.length, 3);
    assert.strictEqual(
      (yield* adapter
        .permanentlyDelete(account, first.ids.slice(0, 1), "trash")
        .pipe(Effect.result))._tag,
      "Failure",
    );
    assert.strictEqual(deletion.mock.calls.length, 0);
    client.capabilities.set("UIDPLUS", true);
    yield* adapter.permanentlyDelete(account, first.ids.slice(0, 2), "trash");
    assert.deepStrictEqual(deletion.mock.calls, [[[1, 2], { uid: true }]]);
    assert.strictEqual(
      (yield* adapter
        .permanentlyDelete(account, [...first.ids, ...second.ids], "trash")
        .pipe(Effect.result))._tag,
      "Failure",
    );
    open.mockResolvedValue({
      path: "Trash",
      delimiter: "/",
      flags: new Set(),
      uidValidity: 8n,
      uidNext: 205,
      exists: 204,
    });
    assert.strictEqual(
      (yield* adapter
        .listFolderMessages(account, { mailbox: "trash" }, first.next)
        .pipe(Effect.result))._tag,
      "Failure",
    );
    yield* adapter.permanentlyDelete(account, first.ids.slice(0, 1), "trash");
    assert.strictEqual(deletion.mock.calls.length, 1);
    search.mockResolvedValue(false);
    assert.strictEqual(
      (yield* adapter.listFolderMessages(account, { mailbox: "trash" }, null).pipe(Effect.result))
        ._tag,
      "Failure",
    );
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

it.effect(
  "IMAP capability precheck and a whole deletion page each use one session, returning successful IDs on partial failure",
  () =>
    Effect.gen(function* () {
      const client = new ImapFlow({ host: "fake.invalid", port: 993, logger: false });
      client.capabilities.set("UIDPLUS", true);
      vi.spyOn(client, "mailboxOpen").mockResolvedValue({
        path: "Trash",
        delimiter: "/",
        flags: new Set(),
        uidValidity: 7n,
        uidNext: 101,
        exists: 100,
      });
      const deletion = vi.spyOn(client, "messageDelete").mockResolvedValue(true);
      assert.ok(account.imap);
      const settings = account.imap;
      let sessions = 0;
      const adapter = yield* makeImapWith(() =>
        Effect.sync(() => {
          sessions++;
          return { accountId: account.id, settings, client };
        }),
      );
      yield* adapter.checkPermanentDelete(account, "trash");
      assert.strictEqual(sessions, 1);
      const ids = Array.from({ length: 100 }, (_, i) => encodeProviderId("Trash", "7", i + 1));
      assert.deepStrictEqual(yield* adapter.permanentlyDelete(account, ids, "trash"), {
        kind: "complete",
        ids,
      });
      assert.strictEqual(sessions, 2);
      assert.strictEqual(deletion.mock.calls.length, 1);
      deletion.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      const first = encodeProviderId("Trash", "7", 1);
      const second = encodeProviderId("TrashTwo", "7", 2);
      const partial = yield* adapter.permanentlyDelete(account, [first, second], "trash");
      assert.strictEqual(partial.kind, "partial");
      assert.deepStrictEqual(partial.ids, [first]);
      if (partial.kind === "partial") assert.strictEqual(partial.error._tag, "PermanentError");
      assert.strictEqual(sessions, 3);
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

it.effect("IMAP reparenting honors the server delimiter and supports moving back to root", () =>
  Effect.gen(function* () {
    const client = new ImapFlow({
      host: "imap.example.com",
      port: 993,
      secure: true,
      auth: { user: "me", pass: "password" },
      logger: false,
    });
    const folders: ListResponse[] = [
      {
        path: "Clients.Reports",
        pathAsListed: "Clients.Reports",
        name: "Reports",
        delimiter: ".",
        parent: ["Clients"],
        parentPath: "Clients",
        flags: new Set(),
        listed: true,
        subscribed: true,
      },
      {
        path: "Work",
        pathAsListed: "Work",
        name: "Work",
        delimiter: ".",
        parent: [],
        parentPath: "",
        flags: new Set(),
        listed: true,
        subscribed: true,
      },
    ];
    vi.spyOn(client, "list").mockResolvedValue(folders);
    const rename = vi
      .spyOn(client, "mailboxRename")
      .mockResolvedValue({ path: "Clients.Reports", newPath: "Work.Reports" });
    assert.ok(account.imap);
    const settings = account.imap;
    const adapter = yield* makeImapWith(() =>
      Effect.succeed({ accountId: account.id, settings, client }),
    );
    yield* adapter.changeLabel(account, {
      kind: "parent",
      id: "Clients.Reports",
      parentId: "Work",
    });
    yield* adapter.changeLabel(account, { kind: "parent", id: "Clients.Reports", parentId: null });
    assert.deepStrictEqual(rename.mock.calls, [
      ["Clients.Reports", "Work.Reports"],
      ["Clients.Reports", "Reports"],
    ]);
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

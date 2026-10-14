import { ImapFlow, type ListResponse } from "imapflow";
import { draftCreation } from "../../platform/node/draft-create-fixture.js";
import { MailCodec } from "../../platform/mail-codec.js";
import { nodeMailCodec } from "../../platform/node/mail-codec.js";
import { assert, it, layer } from "@effect/vitest";
import { Clock, Effect, Exit, Fiber, Layer, Option, Stream } from "effect";
import { vi } from "vitest";
import { TestClock } from "effect/testing";
import { simpleParser } from "mailparser";
import { createServer } from "node:net";
import { createTransport } from "nodemailer";
import type { Account } from "../../domain/account.js";
import { IMAP_PRESETS, type ImapConnectInput } from "./imap-presets.js";
import {
  attachmentNodes,
  mapFolders,
  parseHeaders,
  stripBcc,
  threadIdOf,
  toIncoming,
} from "../../platform/node/imap/parse.js";
import {
  decodeProviderId,
  FolderState,
  encodeProviderId,
  parseUidSet,
  readCursor,
  recordPushedFlags,
  trackImapBackfill,
  uidSet,
} from "./imap-cursor.js";
import {
  makeImap as unboundMakeImap,
  makeImapWith as unboundMakeImapWith,
} from "../../platform/node/imap/adapter.js";
import { imapSettingsKey, resolveImapSettings } from "./imap-settings.js";
import { fetchMessages } from "../../platform/node/imap/pull.js";
import { HtmlText } from "../../platform/html-text.js";
import { Providers } from "../adapter.js";
import { Secrets } from "../../platform/auth.js";
import { Store } from "../../store/service.js";
import { Mailbox } from "../../mailbox/mailbox.js";
import { MailboxLive } from "../../mailbox/mailbox-live.js";
import { StoreLive } from "../../store/store.js";
import { MemoryPlatform } from "../../platform/node/platform-memory.js";
import { incoming } from "../../platform/node/testing.js";
const makeImap = unboundMakeImap.pipe(Effect.provideService(MailCodec, nodeMailCodec));
const makeImapWith = (...args: Parameters<typeof unboundMakeImapWith>) =>
  unboundMakeImapWith(...args).pipe(Effect.provideService(MailCodec, nodeMailCodec));

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

it.effect("MIME batches fetch source through the iterator and keep attachment metadata", () =>
  Effect.gen(function* () {
    const client = fakeImapClient({ host: "fake.invalid", port: 993, logger: false });
    assert.ok(account.imap);
    const source = Buffer.from(
      "From: alice@example.com\r\nSubject: Report\r\nContent-Type: text/plain\r\n\r\nReport",
    );
    const heads = vi.spyOn(client, "fetchAll").mockImplementation(async (_range, query) => {
      assert.isUndefined(query.source, "raw sources must never be collected into an array");
      return [
        { seq: 1, uid: 1, size: source.length },
        { seq: 2, uid: 2, size: 11 * 1024 * 1024 },
      ];
    });
    const fetch = vi.spyOn(client, "fetch").mockImplementation(async function* (range) {
      yield { seq: Number(range), uid: Number(range), source, flags: new Set<string>() };
    });
    const result = yield* fetchMessages(
      { accountId: account.id, settings: account.imap, client, htmlText: yield* HtmlText },
      { path: "INBOX", label: "INBOX" },
      "7",
      [1, 2],
    );
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0]?.message.bodyText.trim(), "Report");
    assert.strictEqual(heads.mock.calls.length, 1);
    assert.strictEqual(fetch.mock.calls.length, 2);
    assert.strictEqual(fetch.mock.calls[0]?.[1].source, true);
    assert.deepStrictEqual(fetch.mock.calls[1]?.[1].source, { maxLength: 512 * 1024 });
  }),
);

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
      const client = fakeImapClient({ host: "fake.invalid", port: 993, logger: false });
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
    const client = fakeImapClient({ host: "fake.invalid", port: 993, logger: false });
    const folders: ListResponse[] = [
      {
        path: "Clients",
        pathAsListed: "Clients",
        name: "Clients",
        delimiter: ".",
        parent: [],
        parentPath: "",
        flags: new Set<string>(),
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
    const client = fakeImapClient({ host: "fake.invalid", port: 993, logger: false });
    vi.spyOn(client, "list").mockResolvedValue([
      {
        path: "INBOX",
        pathAsListed: "INBOX",
        name: "INBOX",
        delimiter: "/",
        parent: [],
        parentPath: "",
        flags: new Set<string>(),
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
        flags: new Set<string>(),
        specialUse: "\\Sent",
        listed: true,
        subscribed: true,
      },
    ]);
    const open = vi.spyOn(client, "mailboxOpen").mockResolvedValue({
      path: "INBOX",
      delimiter: "/",
      flags: new Set<string>(),
      uidValidity: 7n,
      uidNext: 2,
      exists: 1,
    });
    const search = vi.spyOn(client, "search").mockResolvedValue([1]);
    const mime = Buffer.from(
      'From: alice@example.com\r\nTo: me@qq.com\r\nSubject: Report\r\nMessage-ID: <r@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="x"\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nreport\r\n--x\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="report.pdf"\r\n\r\npdf\r\n--x--\r\n',
    );
    const fetched = [
      {
        seq: 1,
        uid: 1,
        flags: new Set<string>(),
        internalDate: new Date("2026-09-30"),
        size: mime.length,
        source: mime,
      },
    ];
    vi.spyOn(client, "fetchAll").mockResolvedValue(fetched);
    vi.spyOn(client, "fetch").mockImplementation(async function* () {
      yield* fetched;
    });
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
    assert.deepStrictEqual(search.mock.calls, [
      [{ from: "alice", seen: false, deleted: false }, { uid: true }],
    ]);
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
      [{ since: "2026-09-01", before: "2026-10-01", deleted: false }, { uid: true }],
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
    const client = fakeImapClient({
      host: "example.com",
      port: 993,
      auth: { user: "me", pass: "fake" },
      logger: false,
    });
    const list = vi.spyOn(client, "list");
    const open = vi.spyOn(client, "mailboxOpen").mockResolvedValue({
      path: "INBOX",
      delimiter: "/",
      flags: new Set<string>(),
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
    const client = fakeImapClient({ host: "fake.invalid", port: 993, logger: false });
    vi.spyOn(client, "list").mockResolvedValue([
      {
        path: "INBOX",
        pathAsListed: "INBOX",
        name: "INBOX",
        delimiter: "/",
        parent: [],
        parentPath: "",
        flags: new Set<string>(),
        listed: true,
        subscribed: true,
      },
    ]);
    let validity = 7n;
    vi.spyOn(client, "mailboxOpen").mockImplementation(() =>
      Promise.resolve({
        path: "INBOX",
        delimiter: "/",
        flags: new Set<string>(),
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
    flags: new Set<string>(),
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
    const client = fakeImapClient({ host: "fake.invalid", port: 993, logger: false });
    vi.spyOn(client, "list").mockResolvedValue([
      {
        path: "INBOX",
        pathAsListed: "INBOX",
        name: "INBOX",
        delimiter: "/",
        parent: [],
        parentPath: "",
        flags: new Set<string>(),
        listed: true,
        subscribed: true,
      },
    ]);
    vi.spyOn(client, "mailboxOpen").mockResolvedValue({
      path: "INBOX",
      delimiter: "/",
      flags: new Set<string>(),
      uidValidity: 7n,
      uidNext: 4,
      exists: 3,
    });
    vi.spyOn(client, "search").mockResolvedValue([1, 2, 3]);
    const mime = Buffer.from(
      "From: a@example.com\r\nSubject: Old\r\nContent-Type: text/plain\r\n\r\nhello",
    );
    const fetched = [
      {
        seq: 2,
        uid: 2,
        flags: new Set<string>(),
        internalDate: new Date(0),
        size: mime.length,
        source: mime,
      },
    ];
    const fetch = vi.spyOn(client, "fetchAll").mockResolvedValue(fetched);
    vi.spyOn(client, "fetch").mockImplementation(async function* () {
      yield* fetched;
    });
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
    const client = fakeImapClient({ host: "fake.invalid", port: 993, logger: false });
    vi.spyOn(client, "list").mockResolvedValue([
      {
        path: "INBOX",
        pathAsListed: "INBOX",
        name: "INBOX",
        parent: [],
        delimiter: "/",
        parentPath: "",
        flags: new Set<string>(),
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
        flags: new Set<string>(),
        specialUse: "\\Trash",
        listed: true,
        subscribed: true,
      },
    ]);
    const open = vi.spyOn(client, "mailboxOpen").mockResolvedValue({
      path: "Trash",
      delimiter: "/",
      flags: new Set<string>(),
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
      flags: new Set<string>(),
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
      const client = fakeImapClient({ host: "fake.invalid", port: 993, logger: false });
      client.capabilities.set("UIDPLUS", true);
      vi.spyOn(client, "mailboxOpen").mockResolvedValue({
        path: "Trash",
        delimiter: "/",
        flags: new Set<string>(),
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
    const client = fakeImapClient({
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
        flags: new Set<string>(),
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
        flags: new Set<string>(),
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

it.effect("composer draft keywords and star use IMAP flags while staying in Drafts", () =>
  Effect.gen(function* () {
    const client = fakeImapClient({ host: "fake.invalid", port: 993, logger: false });
    vi.spyOn(client, "list").mockResolvedValue([
      {
        path: "Drafts",
        pathAsListed: "Drafts",
        name: "Drafts",
        delimiter: "/",
        parent: [],
        parentPath: "",
        flags: new Set<string>(),
        listed: true,
        subscribed: true,
        specialUse: "\\Drafts",
      },
    ]);
    const append = vi
      .spyOn(client, "append")
      .mockResolvedValue({ destination: "Drafts", uid: 42, uidValidity: 7n, seq: 42 });
    assert.ok(account.imap);
    const settings = account.imap;
    const adapter = yield* makeImapWith(() =>
      Effect.succeed({ accountId: account.id, settings, client }),
    );
    const remote = yield* adapter.saveDraft(account, {
      creation: draftCreation(),
      remote: null,
      original: Option.none(),
      replaceAttachments: true,
      message: {
        to: [],
        cc: [],
        bcc: [],
        subject: "Draft",
        text: "Body",
        attachments: [],
        draftOrganization: { labels: ["Work", "$Project"], starred: true },
      },
    });
    assert.strictEqual(remote.messageId, encodeProviderId("Drafts", "7", 42));
    assert.deepStrictEqual(append.mock.calls[0]?.[2], [
      "\\Draft",
      "\\Seen",
      "\\Flagged",
      "Work",
      "$Project",
    ]);
    assert.strictEqual(append.mock.calls[0]?.[0], "Drafts");
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
  "body-only IMAP draft replacement keeps keywords and star changed in another client",
  () =>
    Effect.gen(function* () {
      const client = fakeImapClient({ host: "fake.invalid", port: 993, logger: false });
      vi.spyOn(client, "list").mockResolvedValue([
        {
          path: "Drafts",
          pathAsListed: "Drafts",
          name: "Drafts",
          delimiter: "/",
          parent: [],
          parentPath: "",
          flags: new Set<string>(),
          listed: true,
          subscribed: true,
          specialUse: "\\Drafts",
        },
      ]);
      vi.spyOn(client, "mailboxOpen").mockResolvedValue({
        path: "Drafts",
        delimiter: "/",
        flags: new Set<string>(),
        uidValidity: 7n,
        uidNext: 43,
        exists: 1,
      });
      vi.spyOn(client, "fetchOne").mockResolvedValue({
        seq: 1,
        uid: 1,
        flags: new Set(["\\Draft", "\\Seen", "\\Flagged", "Other"]),
      });
      client.capabilities.set("UIDPLUS", true);
      vi.spyOn(client, "messageDelete").mockResolvedValue(true);
      const append = vi
        .spyOn(client, "append")
        .mockResolvedValue({ destination: "Drafts", uid: 42, uidValidity: 7n, seq: 42 });
      assert.ok(account.imap);
      const settings = account.imap;
      const adapter = yield* makeImapWith(() =>
        Effect.succeed({ accountId: account.id, settings, client }),
      );
      yield* adapter.saveDraft(account, {
        creation: draftCreation(),
        remote: { draftId: null, messageId: encodeProviderId("Drafts", "7", 1) },
        original: Option.none(),
        replaceAttachments: false,
        message: { to: [], cc: [], bcc: [], subject: "Edited", text: "Body", attachments: [] },
      });
      assert.deepStrictEqual(append.mock.calls[0]?.[2], [
        "\\Draft",
        "\\Seen",
        "\\Flagged",
        "Other",
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

it.effect(
  "multi-folder copies verify UIDVALIDITY and destinations, and never move or delete the original",
  () =>
    Effect.gen(function* () {
      const client = fakeImapClient({ host: "fake.invalid", port: 993, logger: false });
      vi.spyOn(client, "list").mockResolvedValue(
        ["INBOX", "A", "B"].map((path) => ({
          path,
          pathAsListed: path,
          name: path,
          delimiter: "/",
          parent: [],
          parentPath: "",
          flags: new Set<string>(),
          listed: true,
          subscribed: true,
        })),
      );
      const open = vi.spyOn(client, "mailboxOpen").mockResolvedValue({
        path: "INBOX",
        delimiter: "/",
        flags: new Set<string>(),
        uidValidity: 7n,
        uidNext: 2,
        exists: 1,
      });
      vi.spyOn(client, "search").mockResolvedValue([1]);
      const copy = vi.spyOn(client, "messageCopy").mockResolvedValue({
        path: "INBOX",
        destination: "A",
        uidValidity: 7n,
        uidMap: new Map([[1, 2]]),
      });
      const move = vi.spyOn(client, "messageMove"),
        remove = vi.spyOn(client, "messageDelete");
      assert.ok(account.imap);
      const settings = account.imap;
      const adapter = yield* makeImapWith(() =>
        Effect.succeed({ accountId: account.id, settings, client }),
      );
      yield* adapter.push(account, encodeProviderId("INBOX", "7", 1), {
        kind: "copy",
        labelIds: ["A", "B", "A", "INBOX"],
      });
      assert.deepStrictEqual(copy.mock.calls, [
        ["1", "A", { uid: true }],
        ["1", "B", { uid: true }],
      ]);
      const invalid = yield* Effect.flip(
        adapter.push(account, encodeProviderId("INBOX", "7", 1), {
          kind: "copy",
          labelIds: ["A", "Gone"],
        }),
      );
      assert.strictEqual(invalid._tag, "PermanentError");
      assert.strictEqual(copy.mock.calls.length, 2);
      open.mockResolvedValue({
        path: "INBOX",
        delimiter: "/",
        flags: new Set<string>(),
        uidValidity: 8n,
        uidNext: 2,
        exists: 1,
      });
      const stale = yield* Effect.flip(
        adapter.push(account, encodeProviderId("INBOX", "7", 1), { kind: "copy", labelIds: ["A"] }),
      );
      assert.strictEqual(stale._tag, "ProviderError");
      assert.strictEqual(copy.mock.calls.length, 2);
      assert.strictEqual(move.mock.calls.length, 0);
      assert.strictEqual(remove.mock.calls.length, 0);
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

function testImap<A, E>(
  work: (
    adapter: import("../adapter.js").ProviderAdapter,
    client: ImapFlow,
    opens: () => number,
  ) => Effect.Effect<A, E>,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const client = fakeImapClient({ host: "fake.invalid", port: 993, logger: false });
      client.usable = true;
      vi.spyOn(client, "noop").mockResolvedValue(undefined);
      vi.spyOn(client, "list").mockResolvedValue(
        ["INBOX", "Archive"].map((path) => ({
          path,
          pathAsListed: path,
          name: path,
          parent: [],
          parentPath: "",
          delimiter: "/",
          flags: new Set<string>(),
          listed: true,
          subscribed: true,
          specialUse: path === "INBOX" ? "\\Inbox" : "\\Archive",
        })),
      );
      vi.spyOn(client, "mailboxOpen").mockResolvedValue({
        path: "INBOX",
        delimiter: "/",
        flags: new Set<string>(),
        uidValidity: 7n,
        uidNext: 3,
        exists: 2,
      });
      vi.spyOn(client, "search").mockResolvedValue([1, 2]);
      vi.spyOn(client, "fetchAll").mockResolvedValue(
        [1, 2].map((uid) => ({ seq: uid, uid, flags: new Set<string>(), size: 100 })),
      );
      vi.spyOn(client, "fetch").mockImplementation(async function* (range) {
        for (const uid of typeof range === "string"
          ? parseUidSet(range)
          : Array.isArray(range)
            ? range
            : [])
          yield {
            seq: uid,
            uid,
            flags: new Set<string>(),
            source: Buffer.from(`Message-ID: <m${uid}@x>\r\nSubject: test\r\n\r\nbody`),
          };
      });
      let opens = 0;
      assert.ok(account.imap);
      const settings = account.imap;
      const adapter = yield* makeImapWith(
        () =>
          Effect.acquireRelease(
            Effect.sync(() => {
              opens++;
              return { accountId: account.id, settings, client };
            }),
            () => Effect.void,
          ),
        () =>
          Effect.sync(() => {
            const transport = createTransport({ host: "fake.invalid", port: 25 });
            vi.spyOn(transport, "sendMail").mockImplementation(() =>
              Promise.resolve({
                envelope: { from: "me@example.com", to: ["bob@example.com"] },
                accepted: ["bob@example.com"],
                rejected: [],
                pending: [],
                response: "250 accepted",
                messageId: "sent",
                envelopeTime: 0,
                messageTime: 0,
                messageSize: 100,
              }),
            );
            return transport;
          }),
      );
      return yield* work(adapter, client, () => opens);
    }),
  ).pipe(
    Effect.provide(
      Layer.succeed(Secrets, {
        get: () => Effect.succeed(Option.some("fake")),
        set: () => Effect.void,
        remove: () => Effect.void,
      }),
    ),
  );
}
const testCursor = (extra: Partial<import("./imap-cursor.js").FolderCursor> = {}) =>
  Option.some(
    JSON.stringify({
      folders: {
        INBOX: { uidValidity: "7", lastUid: 1, uids: "1", unread: "1", starred: "", ...extra },
      },
    }),
  );

it.effect("IMAP does not advance past the pass-one UIDNEXT snapshot", () =>
  testImap((a, client) =>
    Effect.gen(function* () {
      vi.spyOn(client, "mailboxOpen")
        .mockResolvedValueOnce({
          path: "INBOX",
          delimiter: "/",
          flags: new Set<string>(),
          uidValidity: 7n,
          uidNext: 3,
          exists: 2,
        })
        .mockResolvedValue({
          path: "INBOX",
          delimiter: "/",
          flags: new Set<string>(),
          uidValidity: 7n,
          uidNext: 4,
          exists: 3,
        });
      const changes = yield* Stream.runCollect(a.pull(account, testCursor(), "inbox"));
      const cursor = changes.findLast((c) => c._tag === "Cursor");
      assert.ok(cursor?._tag === "Cursor");
      assert.strictEqual(readCursor(Option.some(cursor.cursor)).folders.INBOX?.lastUid, 2);
    }),
  ),
);

it.effect("a regressed UIDNEXT does a full UID and flag rescan", () =>
  testImap((a, client) =>
    Effect.gen(function* () {
      const changes = yield* Stream.runCollect(
        a.pull(account, testCursor({ lastUid: 100 }), "inbox"),
      );
      assert.ok(vi.spyOn(client, "search").mock.calls.some(([query]) => query.since));
      assert.ok(
        changes.some(
          (c) =>
            (c._tag === "Upsert" || c._tag === "Remap") && c.message.providerId === "7:2:INBOX",
        ),
      );
      const cursor = changes.findLast((c) => c._tag === "Cursor");
      assert.ok(cursor?._tag === "Cursor");
      assert.strictEqual(readCursor(Option.some(cursor.cursor)).folders.INBOX?.lastUid, 2);
    }),
  ),
);

it.effect("lowered HIGHESTMODSEQ fetches all flags and resets the cursor", () =>
  testImap((a, client) =>
    Effect.gen(function* () {
      client.enabled.add("CONDSTORE");
      vi.spyOn(client, "mailboxOpen").mockResolvedValue({
        path: "INBOX",
        delimiter: "/",
        flags: new Set<string>(),
        uidValidity: 7n,
        uidNext: 2,
        exists: 1,
        highestModseq: 5n,
      });
      vi.spyOn(client, "fetchAll").mockResolvedValue([
        { seq: 1, uid: 1, flags: new Set(["\\Seen"]) },
      ]);
      const changes = yield* Stream.runCollect(
        a.pull(account, testCursor({ modseq: "10" }), "inbox"),
      );
      assert.ok(changes.some((c) => c._tag === "Flags" && !c.isUnread));
      assert.isUndefined(vi.spyOn(client, "fetchAll").mock.calls[0]?.[2]?.changedSince);
      const cursor = changes.findLast((c) => c._tag === "Cursor");
      assert.ok(cursor?._tag === "Cursor");
      assert.strictEqual(readCursor(Option.some(cursor.cursor)).folders.INBOX?.modseq, "5");
    }),
  ),
);

it.effect("UIDVALIDITY reset remaps before deleting old provider IDs", () =>
  testImap((a) =>
    Effect.gen(function* () {
      const changes = yield* Stream.runCollect(
        a.pull(account, testCursor({ uidValidity: "6" }), "inbox"),
      );
      const remap = changes.find((c) => c._tag === "Remap");
      assert.ok(remap?._tag === "Remap");
      assert.deepStrictEqual(remap.previous, { path: "INBOX", uidValidity: "6" });
      assert.isAbove(
        changes.findIndex((c) => c._tag === "RebuildFolder"),
        changes.findIndex((c) => c._tag === "Remap"),
      );
    }),
  ),
);

it.effect("non-CONDSTORE polling skips a recent full flag scan", () =>
  testImap((a, client) =>
    Effect.gen(function* () {
      const clock = yield* Clock.currentTimeMillis;
      vi.spyOn(client, "mailboxOpen").mockResolvedValue({
        path: "INBOX",
        delimiter: "/",
        flags: new Set<string>(),
        uidValidity: 7n,
        uidNext: 2,
        exists: 1,
      });
      yield* Stream.runCollect(a.pull(account, testCursor({ flagScanAt: clock }), "inbox"));
      assert.strictEqual(vi.spyOn(client, "fetchAll").mock.calls.length, 0);
    }),
  ),
);

it.effect("pooled pushes compact folder UID sets and return COPYUID mappings", () =>
  testImap((a, client, opens) =>
    Effect.gen(function* () {
      client.capabilities.set("UIDPLUS", true);
      client.capabilities.set("MOVE", true);
      vi.spyOn(client, "messageFlagsAdd").mockResolvedValue(true);
      vi.spyOn(client, "messageDelete").mockResolvedValue(true);
      vi.spyOn(client, "messageCopy").mockResolvedValue({
        path: "INBOX",
        destination: "Archive",
        uidValidity: 8n,
        uidMap: new Map([
          [1, 11],
          [2, 12],
        ]),
      });
      assert.ok(a.pushBatch);
      yield* a.pushBatch(account, ["7:1:INBOX", "7:2:INBOX"], { kind: "read", value: true });
      const moved = yield* a.pushBatch(account, ["7:1:INBOX", "7:2:INBOX"], { kind: "archive" });
      assert.strictEqual(opens(), 1);
      assert.deepStrictEqual(vi.spyOn(client, "messageFlagsAdd").mock.calls[0], [
        "1:2",
        ["\\Seen"],
        { uid: true },
      ]);
      assert.deepStrictEqual(moved, [
        { from: "7:1:INBOX", to: "8:11:Archive" },
        { from: "7:2:INBOX", to: "8:12:Archive" },
      ]);
    }),
  ),
);

it.effect("no UIDPLUS moves and draft deletion mark Deleted without EXPUNGE", () =>
  testImap((a, client) =>
    Effect.gen(function* () {
      const copy = vi.spyOn(client, "messageCopy").mockResolvedValue({
        path: "INBOX",
        destination: "Archive",
        uidValidity: 7n,
        uidMap: new Map([[1, 9]]),
      });
      const move = vi.spyOn(client, "messageMove");
      const deletion = vi.spyOn(client, "messageDelete");
      const flags = vi.spyOn(client, "messageFlagsAdd").mockResolvedValue(true);
      yield* a.push(account, "7:1:INBOX", { kind: "archive" });
      yield* a.deleteDraft(account, { draftId: null, messageId: "7:1:INBOX" });
      assert.strictEqual(copy.mock.calls.length, 1);
      assert.strictEqual(move.mock.calls.length, 0);
      assert.strictEqual(deletion.mock.calls.length, 0);
      assert.ok(flags.mock.calls.every((call) => call[1][0] === "\\Deleted"));
    }),
  ),
);

it.effect("custom SMTP sent-copy inference waits twelve seconds and remembers server copies", () =>
  testImap((a, client) =>
    Effect.gen(function* () {
      assert.ok(account.imap);
      vi.spyOn(client, "list").mockResolvedValue([
        {
          path: "Sent",
          pathAsListed: "Sent",
          name: "Sent",
          parent: [],
          parentPath: "",
          delimiter: "/",
          flags: new Set<string>(),
          listed: true,
          subscribed: true,
          specialUse: "\\Sent",
        },
      ]);
      const search = vi.spyOn(client, "search");
      search
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValue([1]);
      const append = vi.spyOn(client, "append");
      const message = {
        to: [{ name: "", address: "bob@example.com" }],
        cc: [],
        bcc: [],
        subject: "Sent copy",
        text: "hello",
        attachments: [],
      };
      const first = yield* a
        .send(
          {
            ...account,
            imap: { ...account.imap, preset: "custom", smtpHost: "smtp.office365.com" },
          },
          message,
          Option.none(),
        )
        .pipe(Effect.forkChild);
      while (!search.mock.calls.length) yield* Effect.yieldNow;
      yield* TestClock.adjust("12 seconds");
      yield* Fiber.join(first);
      assert.strictEqual(search.mock.calls.length, 4);
      assert.strictEqual(append.mock.calls.length, 0);
      search.mockClear();
      search
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValue([1]);
      const second = yield* a
        .send(
          {
            ...account,
            imap: { ...account.imap, preset: "custom", smtpHost: "smtp.unknown.example" },
          },
          message,
          Option.none(),
        )
        .pipe(Effect.forkChild);
      while (!search.mock.calls.length) yield* Effect.yieldNow;
      yield* TestClock.adjust("12 seconds");
      yield* Fiber.join(second);
      assert.strictEqual(search.mock.calls.length, 4);
      assert.strictEqual(append.mock.calls.length, 0);
    }),
  ),
);

it("descending COPYUID ranges retain server order", () => {
  assert.deepStrictEqual(parseUidSet("4:2,9"), [4, 3, 2, 9]);
});
it("a nonlocal In-Reply-To is the fallback thread key", () => {
  assert.strictEqual(threadIdOf({ messageId: "<child@x>", inReplyTo: "<parent@x>" }), "parent@x");
});

it.effect("rebuilds keep the initial window instead of fetching every UID", () =>
  testImap((a, client) =>
    Effect.gen(function* () {
      const search = vi
        .spyOn(client, "search")
        // One UID past the 1000-message initial window.
        .mockResolvedValue(Array.from({ length: 1001 }, (_, i) => i + 1));
      vi.spyOn(client, "fetchAll").mockImplementation(async (range) =>
        (typeof range === "string" ? parseUidSet(range) : []).map((uid) => ({
          seq: uid,
          uid,
          flags: new Set<string>(),
          size: 100,
        })),
      );
      const changes = yield* Stream.runCollect(
        a.pull(account, testCursor({ uidValidity: "6" }), "inbox"),
      );
      assert.ok(search.mock.calls.some(([query]) => query.since));
      assert.strictEqual(changes.filter((change) => change._tag === "Remap").length, 1000);
    }),
  ),
);

it.effect("stale pooled sessions are checked and replaced before pushing", () =>
  testImap((a, client, opens) =>
    Effect.gen(function* () {
      vi.spyOn(client, "messageFlagsAdd").mockResolvedValue(true);
      yield* a.push(account, "7:1:INBOX", { kind: "read", value: true });
      vi.spyOn(client, "noop").mockRejectedValueOnce(new Error("socket closed"));
      yield* a.push(account, "7:1:INBOX", { kind: "star", value: true });
      assert.strictEqual(opens(), 2);
      assert.ok(account.imap);
      yield* a.push(
        { ...account, imap: { ...account.imap, imapHost: "changed.example.test" } },
        "7:1:INBOX",
        { kind: "read", value: true },
      );
      assert.strictEqual(opens(), 3);
      if (!a.closeSessions) throw new Error("Missing session lifecycle");
      yield* a.closeSessions(account.id);
      yield* a.push(account, "7:1:INBOX", { kind: "read", value: true });
      assert.strictEqual(opens(), 4);
    }),
  ),
);

it.effect("unchanged UIDVALIDITY regression invalidates before refetch, without remaps", () =>
  testImap((a) =>
    Effect.gen(function* () {
      const changes = yield* Stream.runCollect(
        a.pull(account, testCursor({ lastUid: 100 }), "inbox"),
      );
      assert.isFalse(changes.some((c) => c._tag === "Remap"));
      const invalidate = changes.findIndex((c) => c._tag === "InvalidateFolder");
      assert.isAtLeast(invalidate, 0);
      assert.isAbove(
        changes.findIndex((c) => c._tag === "Upsert"),
        invalidate,
      );
    }),
  ),
);

it.effect("sync treats Deleted UIDs as absent", () =>
  testImap((a, client) =>
    Effect.gen(function* () {
      vi.spyOn(client, "fetchAll").mockResolvedValue([
        { seq: 1, uid: 1, flags: new Set(["\\Deleted"]) },
      ]);
      const changes = yield* Stream.runCollect(a.pull(account, testCursor(), "inbox"));
      assert.ok(
        changes.some((c) => c._tag === "RebuildFolder" && c.candidates?.includes("7:1:INBOX")),
      );
      assert.isFalse(changes.some((c) => c._tag === "Flags" && c.providerId === "7:1:INBOX"));
    }),
  ),
);

for (const condstore of [false, true])
  it.effect(
    `an undeleted message comes back${condstore ? " with CONDSTORE" : ""}, and an expunged one is forgotten`,
    () =>
      testImap((a, client) =>
        Effect.gen(function* () {
          // A small stateful folder: UID -> flags, with a MODSEQ per change.
          const mail = new Map<number, { flags: Set<string>; modseq: number }>();
          let modseq = 1;
          const put = (uid: number, ...flags: string[]) =>
            mail.set(uid, { flags: new Set(flags), modseq: ++modseq });
          const uidNext = () => Math.max(0, ...mail.keys()) + 1;
          const uids = (range: unknown) =>
            String(range)
              .replaceAll("*", String(Math.max(uidNext() - 1, 1)))
              .split(",")
              .flatMap((part) => {
                const [from = 0, to = from] = part.split(":").map(Number);
                return [...mail.keys()].filter(
                  (uid) => uid >= Math.min(from, to) && uid <= Math.max(from, to),
                );
              });
          if (condstore) client.enabled.add("CONDSTORE");
          vi.spyOn(client, "mailboxOpen").mockImplementation(async () => ({
            path: "INBOX",
            delimiter: "/",
            flags: new Set<string>(),
            uidValidity: 7n,
            uidNext: uidNext(),
            exists: mail.size,
            ...(condstore ? { highestModseq: BigInt(modseq) } : {}),
          }));
          vi.spyOn(client, "search").mockImplementation(async (query) =>
            (query.uid ? uids(query.uid) : [...mail.keys()]).filter(
              (uid) =>
                query.deleted === undefined ||
                mail.get(uid)!.flags.has("\\Deleted") === query.deleted,
            ),
          );
          vi.spyOn(client, "fetchAll").mockImplementation(async (range, _query, options) =>
            uids(range)
              .filter(
                (uid) => !options?.changedSince || mail.get(uid)!.modseq > options.changedSince,
              )
              .map((uid) => ({ seq: uid, uid, flags: new Set(mail.get(uid)!.flags), size: 100 })),
          );
          vi.spyOn(client, "fetch").mockImplementation(async function* (range) {
            for (const uid of uids(range))
              yield {
                seq: uid,
                uid,
                flags: new Set(mail.get(uid)!.flags),
                source: Buffer.from(`Message-ID: <m${uid}@x>\r\nSubject: test\r\n\r\nbody`),
              };
          });
          let cursor = Option.none<string>();
          const sync = Effect.gen(function* () {
            yield* TestClock.adjust("11 minutes");
            const changes = yield* Stream.runCollect(a.pull(account, cursor, "inbox"));
            const last = changes.findLast((c) => c._tag === "Cursor");
            assert.ok(last?._tag === "Cursor");
            cursor = Option.some(last.cursor);
            return {
              upserts: changes.flatMap((c) => (c._tag === "Upsert" ? [c.message.providerId] : [])),
              deletes: changes.flatMap((c) =>
                c._tag === "RebuildFolder" ? (c.candidates ?? []) : [],
              ),
              watched: readCursor(cursor).folders.INBOX?.deleted ?? "",
            };
          });

          put(1);
          put(2);
          assert.deepStrictEqual((yield* sync).upserts, ["7:1:INBOX", "7:2:INBOX"]);

          // Another client deletes 2 without expunging; 3 arrives already deleted.
          put(2, "\\Deleted");
          put(3, "\\Deleted");
          const deleted = yield* sync;
          assert.deepStrictEqual(deleted.deletes, ["7:2:INBOX"]);
          assert.deepStrictEqual(deleted.upserts, []);
          assert.strictEqual(deleted.watched, "2:3");

          // Both are undeleted: they come back although their UIDs are below lastUid.
          put(2);
          put(3);
          const restored = yield* sync;
          assert.deepStrictEqual(restored.upserts, ["7:2:INBOX", "7:3:INBOX"]);
          assert.strictEqual(restored.watched, "");
          assert.strictEqual(readCursor(cursor).folders.INBOX?.uids, "1:3");

          // Deleted, then expunged: watched once, then forgotten.
          put(1, "\\Deleted");
          assert.strictEqual((yield* sync).watched, "1");
          mail.delete(1);
          const expunged = yield* sync;
          assert.strictEqual(expunged.watched, "");
          assert.deepStrictEqual(expunged.upserts, []);
        }),
      ),
  );

it.effect("interrupted pooled move closes and evicts its connection", () =>
  testImap((a, client, opens) =>
    Effect.gen(function* () {
      client.capabilities.set("MOVE", true);
      const closed = vi.spyOn(client, "close").mockImplementation(() => {
        // Record the closure without an actual network connection.
      });
      vi.spyOn(client, "messageFlagsAdd").mockResolvedValue(true);
      let started = false;
      vi.spyOn(client, "messageCopy").mockImplementationOnce(() => {
        started = true;
        return new Promise(() => {
          // The server never acknowledges this move; only interruption releases the caller.
        });
      });
      const fiber = yield* a.push(account, "7:1:INBOX", { kind: "archive" }).pipe(Effect.forkChild);
      while ((() => !started)()) yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
      assert.isAbove(closed.mock.calls.length, 0);
      yield* a.push(account, "7:1:INBOX", { kind: "read", value: true });
      assert.strictEqual(opens(), 2);
    }),
  ),
);

it.effect("UIDVALIDITY changing during a regressed pull still remaps old identities", () =>
  testImap((a, client) =>
    Effect.gen(function* () {
      const mailbox = {
        path: "INBOX",
        delimiter: "/",
        flags: new Set<string>(),
        uidValidity: 7n,
        uidNext: 3,
        exists: 2,
      };
      vi.spyOn(client, "mailboxOpen")
        .mockResolvedValueOnce(mailbox)
        .mockResolvedValue({ ...mailbox, uidValidity: 8n });
      const changes = yield* Stream.runCollect(
        a.pull(account, testCursor({ lastUid: 100 }), "inbox"),
      );
      assert.isFalse(changes.some((c) => c._tag === "InvalidateFolder"));
      assert.ok(
        changes.some(
          (c) =>
            c._tag === "Remap" &&
            c.previous.uidValidity === "7" &&
            c.message.providerId.startsWith("8:"),
        ),
      );
    }),
  ),
);

for (const batched of [false, true])
  it.effect(
    `${batched ? "batch" : "single"} push refuses a UIDNEXT regression before mutating`,
    () =>
      testImap((a, client) =>
        Effect.gen(function* () {
          const flags = vi.spyOn(client, "messageFlagsAdd").mockResolvedValue(true);
          const cursor = testCursor({ lastUid: 100 });
          assert.ok(Option.isSome(cursor));
          const result = yield* (
            batched && a.pushBatch
              ? a.pushBatch(
                  account,
                  ["7:1:INBOX", "7:2:INBOX"],
                  { kind: "star", value: true },
                  cursor.value,
                )
              : a.push(account, "7:1:INBOX", { kind: "star", value: true }, cursor.value)
          ).pipe(Effect.result);
          assert.strictEqual(result._tag, "Failure");
          if (result._tag === "Failure") assert.strictEqual(result.failure._tag, "PermanentError");
          assert.strictEqual(flags.mock.calls.length, 0);
        }),
      ),
  );

it.effect("IMAP sync health uses STATUS without opening, listing or fetching the folder", () =>
  Effect.gen(function* () {
    const settings = account.imap;
    assert.ok(settings);
    const client = fakeImapClient({ host: "fake.invalid", port: 993, logger: false });
    const status = vi.spyOn(client, "status").mockResolvedValue({
      path: "INBOX",
      messages: 12,
      unseen: 3,
      uidNext: 100,
      uidValidity: 99n,
    });
    const open = vi.spyOn(client, "mailboxOpen");
    const list = vi.spyOn(client, "list");
    const adapter = yield* makeImapWith(() =>
      Effect.succeed({ accountId: account.id, settings, client }),
    );
    assert.deepStrictEqual(yield* adapter.folderStatus(account, "INBOX"), {
      total: 12,
      unread: 3,
      threads: null,
      uidNext: 100,
      uidValidity: "99",
    });
    assert.deepStrictEqual(status.mock.calls, [
      ["INBOX", { messages: true, unseen: true, uidNext: true, uidValidity: true }],
    ]);
    assert.strictEqual(open.mock.calls.length, 0);
    assert.strictEqual(list.mock.calls.length, 0);
  }).pipe(
    Effect.provideService(
      Secrets,
      Secrets.of({
        get: () => Effect.succeed(Option.some("password")),
        set: () => Effect.void,
        remove: () => Effect.void,
      }),
    ),
  ),
);

for (const result of [false, undefined] as const) {
  for (const mode of [
    "initial",
    "incremental",
    "regressed",
    "rebuilt",
    "condstore",
    "search",
    "backfill",
    "push",
    "sent",
  ] as const) {
    it.effect(`failed IMAP SEARCH (${result}) stops ${mode} without deletion or progress`, () =>
      testImap((adapter, client) =>
        Effect.gen(function* () {
          vi.spyOn(client, "search").mockResolvedValue(result);
          const append = vi.spyOn(client, "append").mockResolvedValue(false);
          const emitted: import("../adapter.js").Change[] = [];
          let operation;
          if (mode === "search") operation = adapter.search(account, { search: "test" });
          else if (mode === "backfill")
            operation = adapter.backfill(account, { cursor: null, before: 1000 });
          else if (mode === "push")
            operation = adapter.push(account, "7:1:INBOX", { kind: "read", value: true });
          else if (mode === "sent") {
            vi.spyOn(client, "list").mockResolvedValue([
              {
                path: "Sent",
                pathAsListed: "Sent",
                name: "Sent",
                parent: [],
                parentPath: "",
                delimiter: "/",
                flags: new Set<string>(),
                listed: true,
                subscribed: true,
                specialUse: "\\Sent",
              },
            ]);
            assert.ok(account.imap);
            operation = adapter.send(
              {
                ...account,
                imap: { ...account.imap, preset: "custom", smtpHost: "fake.invalid" },
              },
              {
                to: [{ name: "Bob", address: "bob@example.com" }],
                cc: [],
                bcc: [],
                subject: "Test",
                text: "body",
                attachments: [],
              },
              Option.none(),
            );
          } else {
            if (mode === "condstore") {
              client.enabled.add("CONDSTORE");
              vi.spyOn(client, "mailboxOpen").mockResolvedValue({
                path: "INBOX",
                delimiter: "/",
                flags: new Set<string>(),
                uidValidity: 7n,
                uidNext: 3,
                exists: 2,
                highestModseq: 10n,
              });
            }
            const cursor =
              mode === "initial"
                ? Option.none()
                : testCursor({
                    lastUid: mode === "incremental" ? 1 : mode === "regressed" ? 100 : 2,
                    uidValidity: mode === "rebuilt" ? "6" : "7",
                    modseq: "10",
                  });
            operation = adapter
              .pull(account, cursor, "inbox")
              .pipe(Stream.runForEach((change) => Effect.sync(() => emitted.push(change))));
          }
          const exit = yield* Effect.exit<
            unknown,
            | import("../../domain/errors.js").ProviderFailure
            | import("../../domain/errors.js").SendUncertain,
            never
          >(operation);
          assert.deepStrictEqual(
            errorTag(exit),
            mode === "sent" ? Option.none() : Option.some("ProviderError"),
          );
          assert.isFalse(
            emitted.some((change) =>
              ["RebuildFolder", "Delete", "Cursor", "Progress"].includes(change._tag),
            ),
          );
          assert.strictEqual(append.mock.calls.length, 0);
        }),
      ),
    );
  }
}

it.effect("IMAP reconcile missing UIDs always produces a partial rebuild", () =>
  testImap((adapter, client) =>
    Effect.gen(function* () {
      vi.spyOn(client, "fetchAll").mockResolvedValue([]);
      const changes = yield* Stream.runCollect(
        adapter.pull(account, testCursor({ lastUid: 2 }), "inbox"),
      );
      const rebuild = changes.find((change) => change._tag === "RebuildFolder");
      assert.ok(rebuild?._tag === "RebuildFolder");
      assert.isTrue(rebuild.partial);
    }),
  ),
);

it.effect("a folder omitted by LIST but confirmed by STATUS keeps its cursor and mail", () =>
  testImap((adapter, client) =>
    Effect.gen(function* () {
      vi.spyOn(client, "list").mockResolvedValue([]);
      vi.spyOn(client, "status").mockResolvedValue({ path: "INBOX", uidValidity: 7n });
      const changes = yield* Stream.runCollect(adapter.pull(account, testCursor({ lastUid: 2 })));
      assert.isFalse(
        changes.some((change) => change._tag === "RebuildFolder" || change._tag === "DeleteLabel"),
      );
      const cursor = changes.findLast((change) => change._tag === "Cursor");
      assert.ok(cursor?._tag === "Cursor");
      assert.strictEqual(readCursor(Option.some(cursor.cursor)).folders.INBOX?.lastUid, 2);
    }),
  ),
);

for (const outcome of ["gone", "failed", "denied", "relisted"] as const) {
  it.effect(`IMAP folder removal requires confirmed NotFound and LIST absence (${outcome})`, () =>
    testImap((adapter, client) =>
      Effect.gen(function* () {
        const list = vi.spyOn(client, "list").mockResolvedValue([]);
        if (outcome === "relisted")
          list.mockResolvedValueOnce([]).mockResolvedValue([
            {
              path: "INBOX",
              pathAsListed: "INBOX",
              name: "INBOX",
              parent: [],
              parentPath: "",
              delimiter: "/",
              flags: new Set<string>(),
              listed: true,
              subscribed: true,
            },
          ]);
        const status = vi.spyOn(client, "status");
        if (outcome === "failed") status.mockResolvedValue(false);
        else
          status.mockRejectedValue(
            Object.assign(new Error("STATUS failed"), {
              code: outcome === "denied" ? "AccessDenied" : "NotFound",
            }),
          );
        const changes = yield* Stream.runCollect(adapter.pull(account, testCursor({ lastUid: 2 })));
        assert.strictEqual(
          changes.some((change) => change._tag === "RebuildFolder"),
          outcome === "gone",
        );
        const cursor = changes.findLast((change) => change._tag === "Cursor");
        assert.ok(cursor?._tag === "Cursor");
        assert.strictEqual(
          readCursor(Option.some(cursor.cursor)).folders.INBOX?.lastUid,
          outcome === "gone" ? undefined : 2,
        );
      }),
    ),
  );
}

it.effect(
  "desktop IMAP header backfill groups folders, uses UID/PEEK headers and skips unsafe namespaces",
  () =>
    Effect.gen(function* () {
      assert.ok(account.imap);
      const client = fakeImapClient({ host: "fake.invalid", port: 993, logger: false });
      const opened = vi.spyOn(client, "mailboxOpen").mockImplementation(async (path) => ({
        path: String(path),
        delimiter: "/",
        flags: new Set<string>(),
        uidValidity: 7n,
        uidNext: 10,
        exists: 2,
      }));
      const fetched = vi
        .spyOn(client, "fetchAll")
        .mockImplementation(async (range, query, options) => {
          assert.deepStrictEqual(options, { uid: true });
          assert.isUndefined(query.flags);
          assert.isUndefined(query.source);
          assert.isTrue(Array.isArray(query.headers));
          return range === "1:2"
            ? [
                {
                  seq: 1,
                  uid: 1,
                  headers: Buffer.from(
                    "Message-ID: <one@example.test>\r\nList-ID: List\r\n folded\r\nDelivered-To: a\r\nDelivered-To: b\r\n",
                  ),
                },
              ]
            : [];
        });
      const settings = account.imap;
      const adapter = yield* makeImapWith(() =>
        Effect.succeed({ accountId: account.id, settings, client }),
      );
      assert.strictEqual(typeof adapter.fetchCachedHeaders, "function");
      if (!adapter.fetchCachedHeaders) throw new Error("Missing header reader");
      const results = yield* adapter.fetchCachedHeaders(account, [
        "7:1:INBOX",
        "7:2:INBOX",
        "6:3:Archive",
        "quarantined",
      ]);
      assert.deepStrictEqual(results, [
        { kind: "unavailable", id: "quarantined" },
        {
          kind: "headers",
          id: "7:1:INBOX",
          rfcMessageId: "<one@example.test>",
          headers: [
            { name: "message-id", value: "<one@example.test>" },
            { name: "list-id", value: "List folded" },
            { name: "delivered-to", value: "a" },
            { name: "delivered-to", value: "b" },
          ],
        },
        { kind: "unavailable", id: "7:2:INBOX" },
        { kind: "unavailable", id: "6:3:Archive" },
      ]);
      assert.strictEqual(fetched.mock.calls.length, 1);
      assert.isTrue(opened.mock.calls.every((call) => call[1]?.readOnly === true));
    }).pipe(
      Effect.provideService(Secrets, {
        get: () => Effect.succeed(Option.some("password")),
        set: () => Effect.void,
        remove: () => Effect.void,
      }),
    ),
);

function fakeImapClient(
  options: ConstructorParameters<typeof ImapFlow>[0] = {
    host: "fake.invalid",
    port: 993,
    logger: false,
  },
) {
  return new ImapFlow(options);
}

it.effect("a pushed read flag updates the UID record, so a later unread elsewhere syncs", () =>
  testImap((adapter, client) => {
    // One INBOX message; the server has no CONDSTORE, so each sync after ten
    // minutes compares a full flag scan against the per-UID record.
    const server = new Set<string>();
    vi.spyOn(client, "list").mockResolvedValue([
      {
        path: "INBOX",
        pathAsListed: "INBOX",
        name: "INBOX",
        parent: [],
        parentPath: "",
        delimiter: "/",
        flags: new Set<string>(),
        listed: true,
        subscribed: true,
        specialUse: "\\Inbox",
      },
    ]);
    vi.spyOn(client, "mailboxOpen").mockResolvedValue({
      path: "INBOX",
      delimiter: "/",
      flags: new Set<string>(),
      uidValidity: 7n,
      uidNext: 2,
      exists: 1,
    });
    vi.spyOn(client, "search").mockResolvedValue([1]);
    vi.spyOn(client, "fetchAll").mockImplementation(() =>
      Promise.resolve([{ seq: 1, uid: 1, flags: new Set(server), size: 100 }]),
    );
    vi.spyOn(client, "messageFlagsAdd").mockImplementation((_range, flags) => {
      for (const flag of flags) server.add(flag);
      return Promise.resolve(true);
    });
    vi.spyOn(client, "messageFlagsRemove").mockImplementation((_range, flags) => {
      for (const flag of flags) server.delete(flag);
      return Promise.resolve(true);
    });
    return Effect.gen(function* () {
      const store = yield* Store;
      const mailbox = yield* Mailbox;
      const saved = yield* store.upsertAccount("imap", account.email);
      assert.ok(account.imap);
      yield* store.setImapSettings(saved.id, account.imap);
      yield* store.saveSyncCursor(saved.id, Option.getOrThrow(testCursor()));
      yield* store.upsertMessage(saved.id, incoming("7:1:INBOX"));
      const id = yield* store.messageIdForProvider(saved.id, "7:1:INBOX");
      assert.ok(id);
      yield* mailbox.organize.perform(
        { kind: "modify", threads: [id], op: { kind: "read", value: true } },
        { kind: "user", surface: "app" },
      );
      // perform pushes at once; no flag scan runs between the push and the change below.
      assert.isTrue(server.has("\\Seen"));
      assert.deepStrictEqual(yield* store.listPendingOps, []);
      assert.strictEqual(
        readCursor(yield* store.getSyncCursor(saved.id)).folders.INBOX?.unread,
        "",
      );
      // Another device marks it unread before the next flag scan.
      server.delete("\\Seen");
      yield* TestClock.adjust("11 minutes");
      yield* mailbox.sync.sync(saved.id);
      assert.isTrue((yield* store.getMessage(id)).isUnread);
    }).pipe(
      Effect.provide(
        MailboxLive({ backgroundFlush: false, imapIdle: false }).pipe(
          Layer.provideMerge(
            Layer.mergeAll(StoreLive, Layer.succeed(Providers, { get: () => adapter })).pipe(
              Layer.provideMerge(MemoryPlatform()),
            ),
          ),
        ),
      ),
    );
  }),
);

it("pushed flags update only tracked UIDs in a folder with the same UIDVALIDITY", () => {
  const cursor = Option.some(
    JSON.stringify({
      folders: {
        INBOX: { uidValidity: "7", lastUid: 3, uids: "1:2", unread: "1:2", starred: "" },
      },
    }),
  );
  const starred = recordPushedFlags(cursor, ["7:1:INBOX", "7:3:INBOX"], "star", true);
  assert.deepStrictEqual(readCursor(starred).folders.INBOX, {
    uidValidity: "7",
    lastUid: 3,
    uids: "1:2",
    unread: "1:2",
    starred: "1",
  });
  const read = recordPushedFlags(starred, ["7:2:INBOX"], "read", true);
  assert.strictEqual(readCursor(read).folders.INBOX?.unread, "1");
  assert.isTrue(Option.isNone(recordPushedFlags(cursor, ["6:1:INBOX"], "read", true)));
  assert.isTrue(Option.isNone(recordPushedFlags(Option.none(), ["7:1:INBOX"], "read", true)));
});

it.effect("stores the sender name from setup and keeps it out of the session key", () =>
  Effect.gen(function* () {
    const named = yield* resolveImapSettings({
      preset: "qq",
      email: "me@qq.com",
      password: "code",
      senderName: "  Jane  Doe ",
    });
    assert.strictEqual(named.senderName, "Jane Doe");
    const { senderName: _name, ...plain } = named;
    assert.strictEqual(imapSettingsKey(named), imapSettingsKey(plain));
    const blank = yield* resolveImapSettings({
      preset: "qq",
      email: "me@qq.com",
      password: "code",
      senderName: " ",
    });
    assert.isFalse("senderName" in blank);
    yield* rejects({ preset: "qq", email: "me@qq.com", password: "code", senderName: "a\u0000b" });
    yield* rejects({
      preset: "qq",
      email: "me@qq.com",
      password: "code",
      senderName: "x".repeat(201),
    });
  }),
);

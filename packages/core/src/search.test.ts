import { incoming as makeIncoming, TestMailbox, fakeServer } from "./platform/node/testing.js";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, FileSystem, Path } from "effect";
import { type IncomingMessage } from "./domain.js";
import { imapSearch } from "./platform/node/imap-search.js";
import {
  gmailSearch,
  graphSearch,
  matchesSearch,
  mergeSearchResults,
  parseSearchQuery,
  searchFieldParts,
  serializeSearchField,
  selectSearchOperator,
  searchDateSuggestions,
  searchValueSuggestions,
  modifySearchToken,
  ATTACHMENT_TYPES,
  parseSearchExpression,
  relativeSearchDate,
  serverSearchIgnored,
  quoteSearchValue,
} from "./search.js";
import { fuzzyFolders } from "./organization.js";
import { MemoryPlatform } from "./platform/node/platform-memory.js";
import { Store } from "./services.js";
import { StoreLive } from "./store.js";
import { ImapFlow } from "imapflow";
import { searchCompiler } from "imapflow/lib/search-compiler.js";
import { Mailbox } from "./mailbox.js";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { SqlClient } from "effect/sql";
import { databaseLayer } from "./platform/node/db.js";
import { NodeSystem } from "./platform/node/platform-node.js";
import { InvalidInput } from "./errors.js";
import { type DerivedChunk } from "./media.js";
{
  const message: IncomingMessage = makeIncoming("m1", {
    threadId: "t1",
    subject: "Report",
    to: [{ name: "Bob", address: "bob@example.com" }],
    date: Date.parse("2026-09-20T12:00:00Z"),
    bodyText: "sales report",
    labels: ["INBOX", "UNREAD", "IMPORTANT", "Label_1"],
    attachments: [{ filename: "report.pdf", mimeType: "application/pdf", size: 30 }],
  });

  it("parses every common chip, quoted folder names and inclusive/exclusive dates", () => {
    const q = parseSearchQuery({
      search:
        'from:alice to:bob label:"Work mail" is:unread is:starred is:important has:attachment filename:pdf after:2026-09-01 before:2026-10-01 sales',
    });
    assert.strictEqual(q.search, "sales");
    assert.strictEqual(q.unreadOnly, true);
    assert.strictEqual(q.starredOnly, true);
    assert.deepStrictEqual(q.criteria, {
      from: "alice",
      to: "bob",
      labels: ["Work mail"],
      important: true,
      attachment: true,
      filename: "pdf",
      dateAfter: new Date(2026, 8, 1).getTime(),
      dateBefore: new Date(2026, 9, 1).getTime(),
    });
    assert.strictEqual(
      parseSearchQuery({ search: "before:2026-02-30 from: has:banana" }).search,
      "before:2026-02-30 from: has:banana",
    );
  });

  it("compiles provider syntax and keeps Gmail advanced operators", () => {
    assert.strictEqual(
      gmailSearch(
        {
          search: "from:alice newer_than:2y folder:Label_1",
          searchScope: "folder",
          mailbox: "inbox",
        },
        [{ id: "Label_1", name: "Work mail" }],
      ),
      'from:alice newer_than:2y label:"Work mail" label:"INBOX"',
    );
    assert.strictEqual(
      graphSearch({ search: "from:alice has:attachment after:2026-09-01 before:2026-10-01" }),
      `from:"alice" AND hasAttachments:true AND received>=${new Date(2026, 8, 1).toISOString()} AND received<${new Date(2026, 9, 1).toISOString()}`,
    );
    assert.deepStrictEqual(
      imapSearch({ search: "from:alice is:unread is:starred after:2026-09-01 before:2026-10-01" }),
      {
        from: "alice",
        seen: false,
        flagged: true,
        since: "2026-09-01",
        before: "2026-10-01",
      },
    );
  });

  it("postfilters fetched MIME and applies folder scope", () => {
    assert.ok(
      matchesSearch(message, { search: "from:alice to:bob filename:pdf label:Work" }, [
        { id: "Label_1", name: "Work" },
      ]),
    );
    assert.ok(
      !matchesSearch(message, { search: "report", searchScope: "folder", mailbox: "sent" }),
    );
    assert.ok(!matchesSearch(message, { search: "before:2026-09-20" }));
    assert.ok(!matchesSearch(message, { search: "filename:doc" }));
  });

  it("fuzzy folder navigation ranks exact names over subsequences", () => {
    assert.deepStrictEqual(
      fuzzyFolders(["Customers", "Archive", "Custom mail", "Inbox"], "cstm", (s) => s),
      ["Customers", "Custom mail"],
    );
  });

  it.effect("local FTS combines tokens, scoping and thread dedup without changing rowids", () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount("gmail", "me@gmail.com");
      yield* store.replaceLabels(account.id, [{ id: "Label_1", name: "Work", color: null }]);
      yield* store.upsertMessage(account.id, message);
      yield* store.upsertMessage(account.id, {
        ...message,
        providerId: "m2",
        date: message.date + 1,
        labels: ["SENT", "Label_1"],
      });
      const query = {
        search:
          "report from:alice to:bob label:Work is:unread is:important has:attachment filename:pdf after:2026-09-01 before:2026-10-01",
      };
      assert.strictEqual((yield* store.listThreads(query)).length, 1);
      assert.strictEqual((yield* store.listThreads({ search: "report", flat: true })).length, 2);
      assert.strictEqual(
        (yield* store.listThreads({ search: "report", searchScope: "folder", mailbox: "inbox" }))
          .length,
        1,
      );
      assert.strictEqual((yield* store.listThreads({ search: "report from:nobody" })).length, 0);
      yield* store.upsertMessage(account.id, { ...message, bodyText: "updated report" });
      assert.strictEqual((yield* store.listThreads({ search: "updated" })).length, 1);
      const [row] = yield* store.listThreads({ search: "updated" });
      assert.ok(row);
      assert.strictEqual(mergeSearchResults([row], [row]).length, 1);
    }).pipe(Effect.provide(StoreLive.pipe(Layer.provide(MemoryPlatform())))),
  );

  it.effect(
    "authoritative provider hits can include spam, while ordinary all-mail search excludes it",
    () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const account = yield* store.upsertAccount("gmail", "me@gmail.com");
        yield* store.upsertMessage(account.id, { ...message, labels: ["SPAM"] });
        assert.deepStrictEqual(yield* store.listThreads({ search: "report" }), []);
        assert.strictEqual(
          (yield* store.listThreads({ mailbox: "all", messageIds: [`${account.id}/m1`] })).length,
          1,
        );
      }).pipe(Effect.provide(StoreLive.pipe(Layer.provide(MemoryPlatform())))),
  );

  it("search chips preserve quoted values while typing and stay committed after removal", () => {
    assert.deepStrictEqual(searchFieldParts('from:"Alice '), {
      chips: [],
      text: 'from:"Alice ',
      pending: 'from:"Alice ',
    });
    assert.deepStrictEqual(searchFieldParts('from:"Alice Smith" invoice'), {
      chips: ['from:"Alice Smith"'],
      text: "invoice",
      pending: "invoice",
    });
    assert.deepStrictEqual(searchFieldParts("is:unread from:alice "), {
      chips: ["is:unread", "from:alice"],
      text: "",
      pending: "",
    });
    assert.strictEqual(serializeSearchField(["from:alice"], ""), "from:alice ");
    assert.deepStrictEqual(searchFieldParts(serializeSearchField(["from:alice"], "")).chips, [
      "from:alice",
    ]);
    assert.strictEqual(
      parseSearchQuery({ search: 'from:"Alice Smith"' }).criteria?.from,
      "Alice Smith",
    );
    assert.strictEqual(selectSearchOperator("invoice ", "is:unread"), "invoice is:unread ");
    assert.strictEqual(
      selectSearchOperator('from:alice "annual report" to:', "to:"),
      'from:alice "annual report" to:',
    );
    assert.strictEqual(selectSearchOperator("from:alice ", "filename:"), "from:alice filename:");
  });
}

{
  const incoming = (providerId: string, date: number): IncomingMessage =>
    makeIncoming(providerId, {
      threadId: providerId,
      subject: "Report",
      to: [],
      date,
      bodyText: "report",
      labels: ["INBOX"],
      isUnread: false,
    });

  it.effect("system folder suggestions and modifier switches match local cached mail", () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount("gmail", "me@example.com");
      yield* store.upsertMessage(account.id, incoming("inbox", Date.now()));
      for (const name of ["constructor", "__proto__"]) {
        assert.deepStrictEqual(parseSearchQuery({ search: `folder:"${name}"` }).criteria?.labels, [
          name,
        ]);
        assert.strictEqual(gmailSearch({ search: `label:"${name}"` }), `label:"${name}"`);
      }
      const token = searchValueSuggestions("folder:in", [], [])[0]?.token;
      assert.strictEqual(token, 'folder:"inbox"');
      for (const search of [token, 'label:"inbox"', modifySearchToken('in:"inbox"', "folder")]) {
        assert.deepStrictEqual(parseSearchQuery({ search }).criteria?.labels, ["INBOX"]);
        assert.strictEqual((yield* store.listThreads({ search })).length, 1);
      }
    }).pipe(Effect.provide(StoreLive.pipe(Layer.provide(MemoryPlatform())))),
  );

  it.effect(
    "local-day date tokens include midnight and exclude the next day in every timezone",
    () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const account = yield* store.upsertAccount("gmail", "me@example.com");
        const start = new Date(2026, 9, 2).getTime();
        const end = new Date(2026, 9, 3).getTime();
        for (const [id, date] of [
          ["previous", start - 1],
          ["midnight", start],
          ["last", end - 1],
          ["next", end],
        ] as const)
          yield* store.upsertMessage(account.id, incoming(id, date));
        const search = "after:2026-10-02 before:2026-10-03";
        assert.strictEqual(parseSearchQuery({ search }).criteria?.dateAfter, start);
        assert.strictEqual(parseSearchQuery({ search }).criteria?.dateBefore, end);
        assert.deepStrictEqual(
          (yield* store.listThreads({ search })).map((row) => row.threadId).toSorted(),
          ["last", "midnight"],
        );
        assert.strictEqual(
          graphSearch({ search }),
          `received>=${new Date(start).toISOString()} AND received<${new Date(end).toISOString()}`,
        );
        assert.strictEqual(gmailSearch({ search }), `after:${start / 1000} before:${end / 1000}`);
        const client = new ImapFlow({ host: "fake.invalid", port: 993, logger: false });
        assert.deepStrictEqual(searchCompiler(client, imapSearch({ search })), [
          { type: "ATOM", value: "SINCE" },
          { type: "ATOM", value: "02-Oct-2026" },
          { type: "ATOM", value: "BEFORE" },
          { type: "ATOM", value: "03-Oct-2026" },
        ]);
      }).pipe(Effect.provide(StoreLive.pipe(Layer.provide(MemoryPlatform())))),
  );

  it("each negated and repeated Gmail date token uses its own local midnight", () => {
    const early = new Date(2026, 9, 1).getTime() / 1000;
    const late = new Date(2026, 9, 2).getTime() / 1000;
    assert.strictEqual(
      gmailSearch({
        search:
          "before:2026-10-01 -before:2026-10-02 after:2026/10/01 -after:2026-10-02 before:2026-10-02",
      }),
      `before:${early} -before:${late} after:${early} -after:${late} before:${late}`,
    );
    assert.strictEqual(parseSearchQuery({ search: "after:2026-02-30" }).search, "after:2026-02-30");
  });

  it("Gmail narrows attachment types and includes native Drive document types before paging", () => {
    for (const type of ["pdf", "image", "document", "spreadsheet", "presentation"] as const) {
      const query = gmailSearch({ search: `has:${type}` });
      assert.ok(query.includes("has:attachment"));
      assert.strictEqual(
        query.includes(`has:${type}`),
        ["document", "spreadsheet", "presentation"].includes(type),
      );
      for (const extension of ATTACHMENT_TYPES[type].extensions)
        assert.ok(query.includes(`filename:${extension}`));
      const negated = gmailSearch({ search: `-has:${type}` });
      assert.ok(!negated.includes("has:attachment"));
      for (const extension of ATTACHMENT_TYPES[type].extensions)
        assert.ok(negated.includes(`-filename:${extension}`));
    }
  });

  it("relative dates follow calendar days across the Los Angeles DST transition", () => {
    const range = searchDateSuggestions("after:", new Date(2026, 10, 2, 12))[2]?.token;
    const parsed = parseSearchQuery({ search: range });
    assert.strictEqual(parsed.criteria?.dateAfter, new Date(2026, 9, 27).getTime());
    assert.strictEqual(parsed.criteria?.dateBefore, new Date(2026, 10, 3).getTime());
  });

  it.effect("remote post-filter accepts normalized system-folder tokens", () => {
    const inbox = incoming("inbox", Date.now());
    const sent = { ...incoming("sent", Date.now()), labels: ["SENT"] };
    const server = fakeServer("me@gmail.com", [inbox, sent]);
    server.searchResults = [inbox, sent];
    return Effect.gen(function* () {
      const mail = yield* Mailbox;
      yield* mail.connect({ provider: "gmail" });
      const results = yield* mail.searchServer({ search: 'folder:"inbox"' });
      assert.deepStrictEqual(
        results.threads.map((thread) => thread.threadId),
        ["inbox"],
      );
      assert.deepStrictEqual(yield* mail.suggestContacts("Alice", { accountIds: [] }), []);
      const account = (yield* mail.accounts)[0];
      assert.ok(account);
      yield* mail.setAccountSettings(account.id, { enabled: false, description: "", color: null });
      const calls = server.searched.length;
      const disabled = yield* mail.searchServer({
        accountIds: [account.id],
        search: 'folder:"inbox"',
      });
      assert.deepStrictEqual(disabled.threads, []);
      assert.strictEqual(server.searched.length, calls);
      assert.deepStrictEqual(
        yield* mail.suggestContacts("Alice", { accountIds: [account.id] }),
        [],
      );
    }).pipe(Effect.provide(TestMailbox({ gmail: server })));
  });
}

{
  const fixture = (providerId: string, overrides: Partial<IncomingMessage> = {}): IncomingMessage =>
    makeIncoming(providerId, {
      threadId: providerId,
      subject: "Project report",
      to: [{ name: "Bob", address: "bob@example.com" }],
      cc: [{ name: "Carol", address: "carol@example.com" }],
      bcc: [{ name: "Hidden", address: "hidden@example.com" }],
      rfcMessageId: `<${providerId}@example.com>`,
      size: 2_000_000,
      date: new Date(2026, 8, 20).getTime(),
      bodyText: "red fox budget",
      labels: ["INBOX", "UNREAD", "IMPORTANT", "CATEGORY_PERSONAL", "work"],
      attachments: [{ filename: "budget.pdf", mimeType: "application/pdf", size: 42 }],
      ...overrides,
    });

  const fixtures = [
    fixture("a"),
    fixture("b", {
      from: { name: "Dana", address: "dana@example.com" },
      subject: "Reporting",
      bodyText: "red foxes",
      size: 100,
      labels: ["INBOX"],
      isUnread: false,
      attachments: [],
    }),
    fixture("c", {
      bodyText: "blue bird",
      labels: ["INBOX", "STARRED"],
      isStarred: true,
      isUnread: false,
    }),
  ];

  const cases: [string, string[]][] = [
    ["report", ["a", "c"]],
    ["repor", []],
    ["report*", ["a", "b", "c"]],
    ["fox", ["a"]],
    ["fox*", ["a", "b"]],
    ['"red fox"', ["a"]],
    ["(from:alice OR subject:reporting) -bird", ["a", "b"]],
    ["-(from:dana OR bird)", ["a"]],
    ["from:alice from:dana", []],
    ["from:(alice OR dana) -bird", ["a", "b"]],
    ["subject:report", ["a", "c"]],
    ["subject:report*", ["a", "b", "c"]],
    ["to:bob cc:carol bcc:hidden", ["a", "b", "c"]],
    ["is:read", ["b", "c"]],
    ["is:starred OR is:important", ["a", "c"]],
    ["label:work in:inbox category:primary", ["a"]],
    ["has:pdf filename:budget", ["a", "c"]],
    ["larger:1M smaller:3M", ["a", "c"]],
    ["before:2026-10-01 after:2026-09-01", ["a", "b", "c"]],
    ["rfc822msgid:a@example.com", ["a"]],
    ["{from:dana bird}", ["b", "c"]],
    ["-has:attachment", ["b"]],
    ["(has:pdf OR report) -from:dana", ["a", "c"]],
  ];

  it.effect(
    "boolean operators, phrases, flags, dates, size and whole words agree in SQLite and provider postfilter after reopening",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const folder = yield* fs.makeTempDirectoryScoped({ prefix: "openmail-" });
        const database = paths.join(folder, "mail.sqlite");
        const layer = StoreLive.pipe(
          Layer.provideMerge(databaseLayer(database).pipe(Layer.provide(NodeSystem))),
        );
        yield* Effect.gen(function* () {
          const store = yield* Store;
          const account = yield* store.upsertAccount("gmail", "me@example.com");
          for (const message of fixtures) yield* store.upsertMessage(account.id, message);
          yield* store.replaceLabels(account.id, [{ id: "work", name: "Work", color: null }]);
        }).pipe(Effect.provide(layer));
        yield* Effect.gen(function* () {
          const store = yield* Store;
          const sql = yield* SqlClient.SqlClient;
          for (const [search, expected] of cases) {
            const local = (yield* store.listThreads({ search, flat: true }))
              .map((row) => row.id.split("/").at(-1))
              .toSorted((a, b) => (a ?? "").localeCompare(b ?? ""));
            assert.deepStrictEqual(local, expected, search);
            assert.strictEqual(
              yield* store.countThreads({ search, flat: true }),
              expected.length,
              search,
            );
            assert.deepStrictEqual(
              fixtures.filter((m) => matchesSearch(m, { search })).map((m) => m.providerId),
              expected,
              search,
            );
          }
          for (const value of [
            '"',
            '" OR 1=1 --',
            "report) OR messages_fts:*",
            "NEAR(report budget)",
            "a'b",
            "***",
            "(",
            "foo:bar",
            'foo "unclosed',
          ]) {
            yield* store.listThreads({ search: quoteSearchValue(value) });
            yield* store.listThreads({ search: value });
          }
          const before = yield* sql`SELECT rowid FROM messages WHERE provider_id='a'`;
          yield* store.upsertMessage(
            "gmail:me@example.com",
            fixture("a", { subject: "Invoice", bodyText: "new text" }),
          );
          assert.deepStrictEqual(
            yield* sql`SELECT rowid FROM messages WHERE provider_id='a'`,
            before,
          );
          assert.strictEqual((yield* store.listThreads({ search: "invoice" })).length, 1);
          yield* sql`INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')`;
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
    20_000,
  );

  it.effect(
    "Drive and native document type tokens match official links in both cached and fetched mail",
    () => {
      const messages = [
        fixture("doc", {
          bodyText: "https://docs.google.com/document/d/abc/edit",
          attachments: [],
        }),
        fixture("sheet", {
          bodyHtml: '<a href="https://docs.google.com/spreadsheets/d/abc">Sheet</a>',
          attachments: [],
        }),
        fixture("slides", {
          bodyText: "https://docs.google.com/presentation/d/abc/edit",
          attachments: [],
        }),
        fixture("drive", { bodyText: "https://drive.google.com/file/d/abc/view", attachments: [] }),
        fixture("spoof", {
          bodyText: "https://docs.google.com.evil.example/document/d/abc",
          attachments: [],
        }),
      ];
      return Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        yield* mailbox.connect({ provider: "gmail" });
        yield* mailbox.sync();
        for (const [query, ids] of [
          ["has:drive", ["doc", "drive", "sheet", "slides"]],
          ["has:document", ["doc"]],
          ["has:spreadsheet", ["sheet"]],
          ["has:presentation", ["slides"]],
          ["has:drive -has:document", ["drive", "sheet", "slides"]],
          ["-has:drive", ["spoof"]],
        ] satisfies [string, string[]][]) {
          assert.deepStrictEqual(
            (yield* mailbox.threads({ search: query }))
              .map((m) => m.id.split("/").at(-1))
              .toSorted((a, b) => (a ?? "").localeCompare(b ?? "")),
            ids,
          );
          assert.deepStrictEqual(
            messages
              .filter((m) => matchesSearch(m, { search: query }))
              .map((m) => m.providerId)
              .toSorted((a, b) => a.localeCompare(b)),
            ids,
          );
        }
      }).pipe(Effect.provide(TestMailbox({ gmail: fakeServer("me@gmail.com", messages) })));
    },
  );

  it("server searches keep boolean shape, escape values and report unsupported predicates", () => {
    const query = { search: '(from:alice OR to:bob) -subject:"private draft" has:drive larger:1M' };
    const graph = graphSearch(query);
    assert.ok(graph.includes(" OR ") && graph.includes("NOT ") && !graph.includes("has:drive"));
    assert.deepStrictEqual(serverSearchIgnored(query, "outlook"), ["has:drive", "larger:1M"]);
    assert.deepStrictEqual(serverSearchIgnored(query, "imap"), ["has:drive"]);
    const imap = imapSearch(query);
    assert.ok(imap.not);
    assert.strictEqual(graphSearch({ search: "from:alice OR has:drive" }), "");
    assert.deepStrictEqual(parseSearchExpression('"a OR b"'), {
      kind: "and",
      children: [{ kind: "term", value: '"a OR b"' }],
    });
    const parts = searchFieldParts(query.search);
    assert.strictEqual(serializeSearchField(parts.chips, parts.text), query.search);
    assert.ok(parseSearchQuery({ search: "older_than:1y" }).criteria?.dateBefore);
    assert.strictEqual(
      relativeSearchDate("2d", new Date(2026, 9, 2).getTime()),
      new Date(2026, 8, 30).getTime(),
    );
  });
}

{
  const message: IncomingMessage = makeIncoming("m", {
    threadId: "t",
    subject: "Review",
    from: { name: "Bob", address: "bob@example.com" },
    to: [],
    date: 1,
    bodyText: "请查收附件中的季度报告 budget",
    labels: ["INBOX"],
  });

  const withStore = <A, E>(program: Effect.Effect<A, E, Store>) =>
    program.pipe(Effect.provide(StoreLive.pipe(Layer.provide(MemoryPlatform()))));

  it.effect(
    "Chinese substrings and mixed Chinese/Latin search preserve the original behavior",
    () =>
      withStore(
        Effect.gen(function* () {
          const store = yield* Store;
          const account = yield* store.upsertAccount("gmail", "me@example.com");
          yield* store.upsertMessage(account.id, message);
          for (const search of ["报告", "季度报告", "季度报告 budget", "报告 budget"]) {
            assert.strictEqual((yield* store.listThreads({ search })).length, 1, search);
            assert.ok(matchesSearch(message, { search }), search);
          }
        }),
      ),
  );

  it("negation of an inexact AND never narrows the server query", () => {
    assert.strictEqual(graphSearch({ search: "-(from:bob has:pdf)" }), "");
    assert.deepStrictEqual(imapSearch({ search: "-(from:bob has:pdf)" }), { all: true });
  });

  it("oversized queries fail with InvalidInput before building SQL", () => {
    assert.throws(
      () => parseSearchExpression(Array.from({ length: 1000 }, () => "from:bob").join(" OR ")),
      InvalidInput,
    );
  });

  it.effect("unknown size predicates and punctuation do not remove matches", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const account = yield* store.upsertAccount("outlook", "me@example.com");
        yield* store.upsertMessage(account.id, message);
        for (const search of [
          "larger:1M",
          "smaller:1",
          "-larger:1M",
          "-(from:bob larger:1M)",
          "!!!",
          "-!!!",
          "budget !!!",
        ]) {
          assert.strictEqual((yield* store.listThreads({ search })).length, 1, search);
          assert.ok(matchesSearch(message, { search }), search);
        }
      }),
    ),
  );

  it.effect("1000-term public searches return a typed failure instead of a SQL defect", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const search = Array.from({ length: 1000 }, (_, index) => `term${index}`).join(" OR ");
        const listed = yield* store.listThreads({ search }).pipe(Effect.result);
        const counted = yield* store.countThreads({ search }).pipe(Effect.result);
        assert.strictEqual(listed._tag, "Failure");
        assert.strictEqual(counted._tag, "Failure");
        if (listed._tag === "Failure") assert.strictEqual(listed.failure._tag, "InvalidInput");
        if (counted._tag === "Failure") assert.strictEqual(counted.failure._tag, "InvalidInput");
      }),
    ),
  );

  it.effect(
    "structured criteria also return InvalidInput before oversized SQL is constructed",
    () =>
      withStore(
        Effect.gen(function* () {
          const store = yield* Store;
          const result = yield* store
            .listThreads({
              criteria: { excluded: Array.from({ length: 1000 }, () => ({ subject: "budget" })) },
            })
            .pipe(Effect.result);
          assert.strictEqual(result._tag, "Failure");
          if (result._tag === "Failure") assert.strictEqual(result.failure._tag, "InvalidInput");
        }),
      ),
  );

  it("ignored search notices include supported operators dropped with an inexact negation", () => {
    for (const provider of ["imap", "outlook"] as const) {
      assert.deepStrictEqual(serverSearchIgnored({ search: "-(from:bob has:pdf)" }, provider), [
        "from:bob",
        "has:pdf",
      ]);
      assert.deepStrictEqual(serverSearchIgnored({ search: "from:bob has:pdf" }, provider), [
        "has:pdf",
      ]);
      assert.deepStrictEqual(
        serverSearchIgnored({ search: "-(from:bob OR to:alice)" }, provider),
        [],
      );
      assert.deepStrictEqual(
        serverSearchIgnored({ search: "subject:budget -(from:bob has:pdf)" }, provider),
        ["from:bob", "has:pdf"],
      );
    }
  });
}

{
  const layer = StoreLive.pipe(Layer.provideMerge(MemoryPlatform()));

  const message = (id: string, bodyText: string): IncomingMessage =>
    makeIncoming(id, {
      threadId: id,
      from: { name: "Sender", address: "sender@example.com" },
      to: [],
      subject: "Report",
      bodyText,
      labels: ["INBOX"],
    });

  it("older/newer date aliases stay equivalent through local, Gmail and Graph search", () => {
    for (const [alias, canonical] of [
      ["older", "before"],
      ["newer", "after"],
    ] as const) {
      const search = `${alias}:2026/10/01`;
      assert.deepStrictEqual(
        parseSearchQuery({ search }).criteria,
        parseSearchQuery({ search: `${canonical}:2026/10/01` }).criteria,
      );
      assert.strictEqual(
        gmailSearch({ search }),
        gmailSearch({ search: `${canonical}:2026/10/01` }),
      );
      assert.strictEqual(
        graphSearch({ search }),
        graphSearch({ search: `${canonical}:2026/10/01` }),
      );
      assert.deepStrictEqual(serverSearchIgnored({ search }, "imap"), []);
      assert.deepStrictEqual(serverSearchIgnored({ search }, "outlook"), []);
    }
  });

  it.effect(
    "boolean search includes indexed attachments and excludes a forbidden term across body and chunks",
    () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const sql = yield* SqlClient.SqlClient;
        const account = yield* store.upsertAccount("gmail", "me@example.com");
        for (const [id, text, attachment] of [
          ["good", "budget", "invoice"],
          ["bad", "budget", "invoice secret"],
          ["body", "invoice budget", ""],
          ["none", "unrelated", ""],
        ]) {
          if (!id || text === undefined || attachment === undefined)
            throw new Error("Incomplete fixture");
          yield* store.upsertMessage(account.id, message(id, text));
          if (attachment) {
            const chunk: DerivedChunk = {
              messageId: `${account.id}/${id}`,
              text: attachment,
              source: {
                kind: "attachment",
                index: 0,
                name: "scan.pdf",
                mimeType: "application/pdf",
              },
              page: 1,
              region: null,
              pipelineVersion: "fixture",
              visionRevision: null,
            };
            yield* sql`INSERT INTO derived_chunks(message_id,text,provenance_json) VALUES(${chunk.messageId},${chunk.text},${JSON.stringify(chunk)})`;
          }
        }
        const ids = (search: string) =>
          store
            .listThreads({ search, flat: true })
            .pipe(
              Effect.map((rows) =>
                rows
                  .map((row) => row.id.split("/").at(-1))
                  .toSorted((a, b) => (a ?? "").localeCompare(b ?? "")),
              ),
            );
        assert.deepStrictEqual(yield* ids("(invoice OR contract) budget -secret"), [
          "body",
          "good",
        ]);
        assert.deepStrictEqual(yield* ids("invoice -secret"), ["body", "good"]);
        assert.deepStrictEqual(yield* ids("in:attachment (invoice OR contract) -secret"), ["good"]);
        assert.deepStrictEqual(yield* ids("in:attachment invoice -secret"), ["good"]);
        assert.deepStrictEqual(yield* ids("-(in:attachment invoice)"), ["body", "none"]);
        assert.deepStrictEqual(yield* ids("in:attachment -secret"), ["good"]);
        assert.deepStrictEqual(yield* ids("-(invoice OR contract)"), ["none"]);
        // Verify both the trigram fallback and the completed unicode61 index.
        while (!(yield* store.backfillWordIndex(200)).ready) {
          /* bounded fixture */
        }
        assert.deepStrictEqual(yield* ids("(invoice OR contract) budget -secret"), [
          "body",
          "good",
        ]);
      }).pipe(Effect.provide(layer)),
  );
}

{
  const message = (id: string, bodyText = "alpha one beta"): IncomingMessage =>
    makeIncoming(id, {
      threadId: id,
      subject: "Travel",
      from: { name: "Sender", address: "sender@example.com" },
      to: [],
      date: 1,
      bodyText,
      labels: ["INBOX"],
      isUnread: false,
    });

  it.effect(
    "local Gmail header, user label and AROUND operators agree with SQLite and preserve rowid",
    () => {
      const fixtures = [
        message("forward", "alpha one beta"),
        message("reverse", "beta alpha"),
        message("far", "alpha one two beta"),
        message("unknown", "nothing"),
      ];
      fixtures[0] = {
        ...message("forward", "alpha one beta"),
        headers: [
          { name: "List-ID", value: "News <list.example.com>" },
          { name: "delivered-to", value: "alias@example.com" },
          { name: "x-test", value: "100%_literal" },
        ],
        labels: ["INBOX", "Label_one"],
      };
      const server = fakeServer("me@gmail.com", fixtures);
      server.labels = [{ id: "Label_one", name: "User label", color: null }];
      return Effect.gen(function* () {
        const mailbox = yield* Mailbox,
          store = yield* Store;
        const account = yield* mailbox.connect({ provider: "gmail" });
        yield* mailbox.sync();
        const searches: [string, string[]][] = [
          ["alpha AROUND 1 beta", ["forward", "reverse"]],
          ["alpha AROUND 0 beta", ["reverse"]],
          ['"alpha AROUND 1 beta"', ["forward"]],
          ["(alpha AROUND 0 beta) OR list:list.example.com", ["forward", "reverse"]],
          ["-(alpha AROUND 0 beta)", ["far", "forward", "unknown"]],
          ["list:list.example.com", ["forward"]],
          ["deliveredto:alias@example.com", ["forward"]],
          ['header:"x-test:100%_literal"', ["forward"]],
          ["header:x-test", ["forward"]],
          ["has:userlabels", ["forward"]],
          ["has:nouserlabels", ["far", "reverse", "unknown"]],
          ["list:list.example.com deliveredto:alias@example.com", ["forward"]],
        ];
        for (const [search, expected] of searches) {
          const ids = (yield* store.listThreads({ search, flat: true }))
            .map((m) => m.id.slice(account.id.length + 1))
            .toSorted();
          assert.deepStrictEqual(ids, expected, search);
          assert.strictEqual(
            yield* store.countThreads({ search, flat: true }),
            expected.length,
            search,
          );
          assert.deepStrictEqual(
            fixtures
              .filter((m) => matchesSearch(m, { search }, server.labels))
              .map((m) => m.providerId)
              .toSorted(),
            expected,
            search,
          );
        }
        yield* store.upsertMessage(account.id, {
          ...message("forward"),
          providerId: "forward",
          threadId: "forward",
          headers: [{ name: "x-test", value: "updated" }],
        });
        assert.deepStrictEqual((yield* store.getMessage(`${account.id}/forward`)).headers, [
          { name: "x-test", value: "updated" },
        ]);
      }).pipe(Effect.provide(TestMailbox({ gmail: server })));
    },
  );

  it.effect(
    "zero-distance AROUND preserves order, phrases, repeated tokens and column/chunk boundaries",
    () =>
      Effect.gen(function* () {
        const store = yield* Store,
          sql = yield* SqlClient.SqlClient;
        const account = yield* store.upsertAccount("gmail", "adjacent@example.com");
        const fixtures = [
          message("forward", "red fox blue bird"),
          message("reverse", "blue bird red fox"),
          message("gap", "red fox near blue bird"),
          message("overlap", "red fox blue"),
          message("repeated", "alpha alpha"),
          message("single", "alpha"),
          { ...message("columns", "blue bird"), subject: "red fox" },
          message("ocr", "unrelated"),
          message("chunks", "unrelated"),
        ];
        for (const fixture of fixtures) yield* store.upsertMessage(account.id, fixture);
        for (const [id, text] of [
          ["ocr", "red fox blue bird"],
          ["chunks", "red fox"],
          ["chunks", "blue bird"],
        ])
          yield* sql`INSERT INTO derived_chunks(message_id,text,provenance_json) VALUES(${`${account.id}/${id}`},${text},'{}')`;
        while (!(yield* store.backfillWordIndex(500)).ready) {
          /* Complete both indexes before checking adjacency. */
        }
        for (const [search, expected] of [
          ['"red fox AROUND 0 blue bird"', ["forward", "ocr"]],
          ['"red fox" AROUND 0 "blue bird"', ["forward", "ocr", "reverse"]],
          ['"RÉD, fox AROUND 0 blue-bird"', ["forward", "ocr"]],
          ['"red fox" AROUND 0 "fox blue"', []],
          ['"alpha AROUND 0 alpha"', ["repeated"]],
          ["alpha AROUND 0 alpha", ["repeated"]],
          ['in:attachment "red fox AROUND 0 blue bird"', ["ocr"]],
          [
            '-("red fox AROUND 0 blue bird")',
            ["chunks", "columns", "gap", "overlap", "repeated", "reverse", "single"],
          ],
        ] as const) {
          const rows = yield* store.listThreads({ search, flat: true });
          assert.deepStrictEqual(
            rows.map((row) => row.id.slice(account.id.length + 1)).toSorted(),
            [...expected],
            search,
          );
          assert.strictEqual(
            yield* store.countThreads({ search, flat: true }),
            expected.length,
            search,
          );
        }
      }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
  );

  it.effect(
    "AROUND degrades to AND without writes during indexing, then checks phrases within each chunk",
    () =>
      Effect.gen(function* () {
        const store = yield* Store,
          sql = yield* SqlClient.SqlClient;
        const account = yield* store.upsertAccount("gmail", "old@example.com");
        for (const [id, body] of [
          ["body", "red fox near blue bird"],
          ["ocr", "unrelated"],
          ["split", "unrelated"],
        ]) {
          yield* store.upsertMessage(account.id, message(id ?? "", body));
        }
        for (const [id, text] of [
          ["ocr", "red fox near blue bird"],
          ["split", "red fox"],
          ["split", "blue bird"],
        ]) {
          yield* sql`INSERT INTO derived_chunks(message_id,text,provenance_json) VALUES(${`${account.id}/${id}`},${text},'{}')`;
        }
        yield* sql`INSERT INTO messages_words(messages_words) VALUES('delete-all')`;
        yield* sql`INSERT INTO derived_words(derived_words) VALUES('delete-all')`;
        yield* sql`DELETE FROM search_word_rows`;
        yield* sql`UPDATE search_word_index SET cursor=0,end_rowid=CASE WHEN kind='messages' THEN (SELECT MAX(rowid) FROM messages) ELSE (SELECT MAX(id) FROM derived_chunks) END,ready=0`;
        const before = yield* sql`SELECT * FROM search_word_index`;
        assert.strictEqual(
          yield* store.countThreads({ search: '"red fox" AROUND 0 "blue bird"', flat: true }),
          2,
        );
        yield* store.listThreads({ search: '"red fox" AROUND 0 "blue bird"', flat: true });
        assert.deepStrictEqual(yield* sql`SELECT * FROM search_word_index`, before);
        while (!(yield* store.backfillWordIndex(500)).ready) {
          /* Background indexer equivalent. */
        }
        for (const [query, expected] of [
          ['"red fox" AROUND 1 "blue bird"', ["body", "ocr"]],
          ['in:attachment "red fox" AROUND 1 "blue bird"', ["ocr"]],
          ['-("red fox" AROUND 1 "blue bird")', ["split"]],
          ['"red fox AROUND 1 blue bird"', ["body", "ocr"]],
        ] as const) {
          assert.deepStrictEqual(
            (yield* store.listThreads({ search: query, flat: true }))
              .map((m) => m.id.slice(account.id.length + 1))
              .toSorted(),
            [...expected],
            query,
          );
        }
        assert.strictEqual((yield* store.wordIndexReady).messages, true);
        assert.ok(
          gmailSearch({ search: "(alpha AROUND 2 beta) OR list:news@example.com" }).includes(
            '"alpha" AROUND 2 "beta"',
          ),
        );
      }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
  );
}

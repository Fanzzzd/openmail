import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import type { IncomingMessage } from "./domain.js";
import { imapSearch } from "./imap-search.js";
import {
  gmailSearch,
  graphSearch,
  matchesSearch,
  mergeSearchResults,
  parseSearchQuery,
  searchFieldParts,
  serializeSearchField,
  selectSearchOperator,
} from "./search.js";
import { fuzzyFolders } from "./organization.js";
import { MemoryPlatform } from "./platform-memory.js";
import { Store } from "./services.js";
import { StoreLive } from "./store.js";

const message: IncomingMessage = {
  providerId: "m1",
  threadId: "t1",
  subject: "Report",
  from: { name: "Alice", address: "alice@example.com" },
  to: [{ name: "Bob", address: "bob@example.com" }],
  cc: [],
  date: Date.parse("2026-09-20T12:00:00Z"),
  snippet: "",
  bodyText: "sales report",
  bodyHtml: "",
  labels: ["INBOX", "UNREAD", "IMPORTANT", "Label_1"],
  attachments: [{ filename: "report.pdf", mimeType: "application/pdf", size: 30 }],
  isUnread: true,
  isStarred: false,
};

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
    dateAfter: Date.parse("2026-09-01"),
    dateBefore: Date.parse("2026-10-01"),
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
    'from:"alice" AND hasAttachments:true AND received>=2026-09-01 AND received<2026-10-01',
  );
  assert.deepStrictEqual(
    imapSearch({ search: "from:alice is:unread is:starred after:2026-09-01 before:2026-10-01" }),
    {
      from: "alice",
      seen: false,
      flagged: true,
      since: new Date("2026-09-01"),
      before: new Date("2026-10-01"),
    },
  );
});
it("postfilters fetched MIME and applies folder scope", () => {
  assert.ok(
    matchesSearch(message, { search: "from:alice to:bob filename:pdf label:Work" }, [
      { id: "Label_1", name: "Work" },
    ]),
  );
  assert.ok(!matchesSearch(message, { search: "report", searchScope: "folder", mailbox: "sent" }));
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

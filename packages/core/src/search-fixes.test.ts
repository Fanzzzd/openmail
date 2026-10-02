import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { ImapFlow } from "imapflow";
import { searchCompiler } from "imapflow/lib/search-compiler.js";
import {
  gmailSearch,
  graphSearch,
  parseSearchQuery,
  searchDateSuggestions,
  searchValueSuggestions,
  modifySearchToken,
  ATTACHMENT_TYPES,
} from "./search.js";
import { imapSearch } from "./imap-search.js";
import { Mailbox } from "./mailbox.js";
import { TestMailbox, fakeServer } from "./testing.js";
import { Store } from "./services.js";
import { StoreLive } from "./store.js";
import { MemoryPlatform } from "./platform-memory.js";
import type { IncomingMessage } from "./domain.js";

const incoming = (providerId: string, date: number): IncomingMessage => ({
  providerId,
  threadId: providerId,
  subject: "Report",
  from: { name: "Alice", address: "alice@example.com" },
  to: [],
  cc: [],
  date,
  snippet: "",
  bodyText: "report",
  bodyHtml: "",
  labels: ["INBOX"],
  attachments: [],
  isUnread: false,
  isStarred: false,
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

it.effect("local-day date tokens include midnight and exclude the next day in every timezone", () =>
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

it("Gmail narrows every attachment type before paging without Drive type operators", () => {
  for (const type of ["pdf", "image", "document", "spreadsheet", "presentation"] as const) {
    const query = gmailSearch({ search: `has:${type}` });
    assert.ok(query.includes("has:attachment"));
    assert.ok(!query.includes(`has:${type}`));
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
    assert.deepStrictEqual(yield* mail.suggestContacts("Alice", { accountIds: [account.id] }), []);
  }).pipe(Effect.provide(TestMailbox({ gmail: server })));
});

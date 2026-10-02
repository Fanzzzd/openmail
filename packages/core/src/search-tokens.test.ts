import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { NodeSystem } from "./platform-node.js";
import { databaseLayer } from "./db.js";
import type { AttachmentType, IncomingMessage } from "./domain.js";
import { makeFakeProvider, fakeServer } from "./fake-provider.js";
import { MailboxLive } from "./mailbox-live.js";
import { Mailbox } from "./mailbox.js";
import { MemoryPlatform } from "./platform-memory.js";
import { Providers, Store } from "./services.js";
import { StoreLive } from "./store.js";
import {
  SEARCH_OPERATORS,
  attachmentHasType,
  editSearchToken,
  gmailSearch,
  graphSearch,
  matchesSearch,
  modifySearchToken,
  negateSearchToken,
  parseSearchQuery,
  quoteSearchValue,
  searchDateSuggestions,
  searchFieldParts,
  searchTokenModifiers,
  searchValueSuggestions,
  selectSearchOperator,
} from "./search.js";
import { imapSearch } from "./imap-search.js";

const incoming = (
  id: string,
  filename: string,
  mimeType = "application/octet-stream",
): IncomingMessage => ({
  providerId: id,
  threadId: id,
  subject: 'Quarterly "report"',
  from: { name: 'Alice "A" Smith', address: "alice+reports@example.com" },
  to: [{ name: "Bob", address: "bob@example.com" }],
  cc: [{ name: "Carol", address: "carol@example.com" }],
  date: Date.parse("2026-10-01T12:00:00Z"),
  snippet: "",
  bodyText: "sales report",
  bodyHtml: "",
  labels: ["INBOX", "work"],
  attachments: filename ? [{ filename, mimeType, size: 12 }] : [],
  isUnread: true,
  isStarred: false,
});
const fixtures: { type: AttachmentType; filename: string; mimeType: string }[] = [
  { type: "pdf", filename: "report.PDF", mimeType: "application/octet-stream" },
  { type: "image", filename: "no-extension", mimeType: "IMAGE/JPEG; name=photo" },
  { type: "document", filename: "report.DOCX", mimeType: "application/octet-stream" },
  {
    type: "spreadsheet",
    filename: "sheet",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
  { type: "presentation", filename: "slides.PPTX", mimeType: "application/octet-stream" },
];

it("suggests address and folder values losslessly and includes subject and all local types", () => {
  for (const operator of ["from", "to", "cc"]) {
    const address = 'a" quoted\\box@example.com';
    const [suggestion] = searchValueSuggestions(
      `${operator}:Ali`,
      [{ name: "Alice", address }],
      [],
    );
    assert.ok(suggestion);
    assert.strictEqual(
      parseSearchQuery({ search: suggestion.token }).criteria?.[
        operator === "from" ? "from" : operator === "to" ? "to" : "cc"
      ],
      address,
    );
  }
  const name = 'Work "quoted" \\ archive';
  for (const operator of ["label", "in", "folder"]) {
    const [suggestion] = searchValueSuggestions(`${operator}:"Work `, [], [{ id: "work", name }]);
    assert.ok(suggestion);
    assert.deepStrictEqual(parseSearchQuery({ search: suggestion.token }).criteria?.labels, [name]);
  }
  assert.strictEqual(
    searchValueSuggestions('label:"Work \\"', [], [{ id: "work", name: 'Work "private"' }]).length,
    1,
  );
  assert.ok(!attachmentHasType({ filename: "pdf", mimeType: "application/octet-stream" }, "pdf"));
  assert.ok(SEARCH_OPERATORS.includes("subject:"));
  for (const { type } of fixtures) assert.ok(SEARCH_OPERATORS.includes(`has:${type}`));
  assert.deepStrictEqual(parseSearchQuery({ search: "in:inbox" }).criteria?.labels, ["INBOX"]);
});

it("edits, negates and changes token modifiers without losing other terms or quoted values", () => {
  const token = `from:${quoteSearchValue('Alice "A" Smith')}`;
  const value = `${token} has:pdf invoice`;
  const edited = editSearchToken(value, 0);
  assert.deepStrictEqual(searchFieldParts(edited), {
    chips: ["has:pdf"],
    text: `invoice ${token}`,
    pending: token,
  });
  const changed = modifySearchToken(negateSearchToken(token), "cc");
  assert.strictEqual(
    parseSearchQuery({ search: changed }).criteria?.excluded?.[0]?.cc,
    'Alice "A" Smith',
  );
  assert.strictEqual(negateSearchToken(changed), `cc:${quoteSearchValue('Alice "A" Smith')}`);
  assert.deepStrictEqual(searchTokenModifiers(token), ["from", "to", "cc"]);
  assert.deepStrictEqual(searchTokenModifiers("after:2026-10-01"), ["before", "after"]);
  assert.strictEqual(selectSearchOperator(edited, "to:"), "has:pdf invoice to:");
  assert.strictEqual(
    parseSearchQuery({ search: "-from: -before:invalid --to:alice" }).search,
    "-from: -before:invalid --to:alice",
  );
});

it("suggests calendar dates across month boundaries with an inclusive seven-day range", () => {
  const dates = searchDateSuggestions("after:", new Date(2026, 9, 2, 12));
  assert.deepStrictEqual(
    dates.map((date) => date.token),
    ["after:2026-10-02", "after:2026-10-01", "after:2026-09-26 before:2026-10-03"],
  );
  assert.strictEqual(
    searchDateSuggestions("before:", new Date(2026, 0, 1, 12))[1]?.token,
    "before:2025-12-31",
  );
  const range = parseSearchQuery({ search: dates[2]?.token });
  assert.strictEqual(range.criteria?.dateAfter, new Date(2026, 8, 26).getTime());
  assert.strictEqual(range.criteria?.dateBefore, new Date(2026, 9, 3).getTime());
});

it("provider searches preserve escaped values and leave local types and negation to metadata", () => {
  const address = 'alice" OR from:mallory \\@example.com';
  const label = 'Work "private" \\ archive';
  const query = {
    search: `cc:${quoteSearchValue(address)} label:${quoteSearchValue(label)} has:document -has:spreadsheet`,
  };
  assert.strictEqual(
    gmailSearch(query),
    `cc:${quoteSearchValue(address)} label:${quoteSearchValue(label)} (has:attachment {filename:doc filename:docx filename:odt filename:rtf filename:txt} OR has:document) -filename:xls -filename:xlsx -filename:ods -filename:csv -filename:tsv -has:spreadsheet`,
  );
  assert.strictEqual(graphSearch(query), `cc:${quoteSearchValue(address)}`);
  assert.deepStrictEqual(imapSearch(query), { cc: address });
  assert.strictEqual(graphSearch({ search: '"annual report"' }), '"annual report"');
  assert.strictEqual(
    gmailSearch({ search: "in:anywhere newer_than:2y" }),
    "in:anywhere newer_than:2y",
  );
});

for (const { type, filename, mimeType } of fixtures) {
  it(`classifies ${type} from MIME or extension and applies negation`, () => {
    const message = incoming(type, filename, mimeType);
    assert.ok(attachmentHasType(message.attachments[0] ?? { filename: "", mimeType: "" }, type));
    assert.ok(matchesSearch(message, { search: `has:${type} cc:carol` }));
    assert.ok(!matchesSearch(message, { search: `-has:${type}` }));
    assert.ok(!matchesSearch(incoming("none", ""), { search: `has:${type}` }));
  });
}

it.effect(
  "temporary SQLite keeps local types, cc, exclusions, escaping and FTS rowids consistent after reopening",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "openmail-search-" });
      const file = path.join(directory, "mail.db");
      const layer = () =>
        StoreLive.pipe(Layer.provideMerge(databaseLayer(file).pipe(Layer.provide(NodeSystem))));
      const name = 'Work "private" \\ archive';
      yield* Effect.gen(function* () {
        const store = yield* Store;
        const sql = yield* SqlClient.SqlClient;
        const account = yield* store.upsertAccount("gmail", "me@gmail.com");
        yield* store.replaceLabels(account.id, [{ id: "work", name, color: null }]);
        for (const fixture of fixtures)
          yield* store.upsertMessage(
            account.id,
            incoming(fixture.type, fixture.filename, fixture.mimeType),
          );
        yield* store.upsertMessage(account.id, incoming("none", ""));
        for (const { type } of fixtures) {
          assert.strictEqual((yield* store.listThreads({ search: `has:${type}` })).length, 1);
          assert.strictEqual(yield* store.countThreads({ search: `-has:${type}` }), 5);
        }
        assert.strictEqual(
          (yield* store.listThreads({
            search: `cc:carol label:${quoteSearchValue(name)} -is:starred -before:2026-10-01 report`,
          })).length,
          6,
        );
        assert.strictEqual((yield* store.listThreads({ search: "-is:unread" })).length, 0);
        assert.strictEqual(
          (yield* store.listThreads({ search: `-label:${quoteSearchValue(name)}` })).length,
          0,
        );
        assert.strictEqual((yield* store.listThreads({ search: 'cc:"%\' OR 1=1 --"' })).length, 0);
        for (const literal of [
          'report" OR "missing',
          "report) OR messages_fts:*",
          "report' OR 1=1 --",
        ]) {
          assert.deepStrictEqual(
            yield* store.listThreads({ search: quoteSearchValue(literal) }),
            [],
          );
        }
        const rowSchema = Schema.Array(Schema.Struct({ rowid: Schema.Int }));
        const before = yield* Schema.decodeUnknownEffect(rowSchema)(
          yield* sql`SELECT rowid FROM messages WHERE provider_id='pdf'`,
        );
        yield* store.upsertMessage(account.id, {
          ...incoming("pdf", "report.PDF"),
          bodyText: "updated report",
        });
        const after = yield* Schema.decodeUnknownEffect(rowSchema)(
          yield* sql`SELECT rowid FROM messages WHERE provider_id='pdf'`,
        );
        assert.deepStrictEqual(after, before);
        assert.strictEqual((yield* store.listThreads({ search: "updated has:pdf" })).length, 1);
      }).pipe(Effect.provide(layer()));
      yield* Effect.gen(function* () {
        const store = yield* Store;
        assert.strictEqual(
          (yield* store.listThreads({ search: "updated has:pdf -cc:nobody" })).length,
          1,
        );
      }).pipe(Effect.provide(layer()));
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
);

it.effect(
  "all provider hits are filtered by local attachment metadata even when a provider returns broad results",
  () => {
    const messages = [
      ...fixtures.map((fixture) => incoming(fixture.type, fixture.filename, fixture.mimeType)),
      incoming("none", ""),
    ];
    const server = fakeServer("me@example.com", messages);
    server.searchResults = messages;
    const adapters = {
      gmail: makeFakeProvider(server),
      outlook: makeFakeProvider(server),
      imap: makeFakeProvider(server),
    };
    const platform = MemoryPlatform();
    const services = Layer.mergeAll(
      StoreLive,
      Layer.succeed(Providers, Providers.of({ get: (provider) => adapters[provider] })),
    ).pipe(Layer.provideMerge(platform));
    return Effect.gen(function* () {
      const store = yield* Store;
      const mail = yield* Mailbox;
      const ids: string[] = [];
      for (const provider of ["gmail", "outlook", "imap"] as const) {
        const account = yield* store.upsertAccount(provider, `me@${provider}.example.com`);
        ids.push(account.id);
        yield* store.replaceLabels(account.id, [
          { id: "work", name: 'Work "private"', color: null },
        ]);
      }
      for (const accountId of ids)
        for (const { type } of fixtures) {
          const result = yield* mail.searchServer({
            accountIds: [accountId],
            search: `has:${type} cc:carol -from:mallory label:"Work \\"private\\""`,
          });
          assert.deepStrictEqual(
            result.threads.map((thread) => thread.id),
            [`${accountId}/${type}`],
          );
          assert.deepStrictEqual(result.errors, []);
        }
      const excluded = yield* mail.searchServer({ search: "-has:pdf" });
      assert.strictEqual(excluded.threads.length, 15);
      assert.strictEqual(server.searched.length, 18);
    }).pipe(
      Effect.provide(MailboxLive({ backgroundFlush: false }).pipe(Layer.provideMerge(services))),
    );
  },
);

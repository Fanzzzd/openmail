import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { SqlClient } from "effect/sql";
import { databaseLayer } from "./db.js";
import type { IncomingMessage } from "./domain.js";
import { inviteHistory } from "./calendar.js";
import { parseCalendar, inviteReply } from "./invites.js";
import { Mailbox } from "./mailbox.js";
import { Store } from "./services.js";
import { StoreLive } from "./store.js";
import { NodeSystem } from "./platform-node.js";
import { TestMailbox, fakeServer } from "./testing.js";
import { parseAppLink, parseStableReference, privateMailLink } from "./system.js";
import { EMPTY_FILTER } from "./organization.js";
import {
  graphSearch,
  matchesSearch,
  parseSearchExpression,
  parseSearchQuery,
  relativeSearchDate,
  serverSearchIgnored,
  quoteSearchValue,
  searchFieldParts,
  serializeSearchField,
} from "./search.js";
import { imapSearch } from "./imap-search.js";

const fixture = (
  providerId: string,
  overrides: Partial<IncomingMessage> = {},
): IncomingMessage => ({
  providerId,
  threadId: providerId,
  subject: "Project report",
  from: { name: "Alice", address: "alice@example.com" },
  to: [{ name: "Bob", address: "bob@example.com" }],
  cc: [{ name: "Carol", address: "carol@example.com" }],
  bcc: [{ name: "Hidden", address: "hidden@example.com" }],
  rfcMessageId: `<${providerId}@example.com>`,
  size: 2_000_000,
  date: new Date(2026, 8, 20).getTime(),
  snippet: "",
  bodyText: "red fox budget",
  bodyHtml: "",
  labels: ["INBOX", "UNREAD", "IMPORTANT", "CATEGORY_PERSONAL", "work"],
  attachments: [{ filename: "budget.pdf", mimeType: "application/pdf", size: 42 }],
  isUnread: true,
  isStarred: false,
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
      const folder = yield* fs.makeTempDirectoryScoped({ prefix: "openmail-slice27-" });
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
      fixture("doc", { bodyText: "https://docs.google.com/document/d/abc/edit", attachments: [] }),
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

it.effect(
  "category choices stay per account and folder badges distinguish totals, unread, conversations and messages",
  () =>
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const account = yield* mailbox.connect({ provider: "gmail" });
      yield* mailbox.sync();
      yield* mailbox.setOrganization({
        accountId: account.id,
        categories: true,
        selectedCategories: ["CATEGORY_PERSONAL", "CATEGORY_UPDATES"],
      });
      assert.deepStrictEqual((yield* mailbox.organization)[0]?.selectedCategories, [
        "CATEGORY_PERSONAL",
        "CATEGORY_UPDATES",
      ]);
      const messages = yield* mailbox.unreadByLabel([account.id], undefined, false);
      const conversations = yield* mailbox.unreadByLabel([account.id], undefined, true);
      assert.strictEqual(messages["INBOX"], 2);
      assert.strictEqual(conversations["INBOX"], 1);
      assert.strictEqual(messages["STARRED"], 2);
      assert.strictEqual(conversations["STARRED"], 1);
      assert.strictEqual(messages["DRAFT"], 1);
      assert.strictEqual((yield* mailbox.unreadCounts)[account.id], 1);
      yield* mailbox.setPrefs({ threadGrouping: false });
      assert.strictEqual((yield* mailbox.unreadCounts)[account.id], 2);
    }).pipe(
      Effect.provide(
        TestMailbox({
          gmail: fakeServer("me@example.com", [
            fixture("a", {
              threadId: "same",
              labels: ["INBOX", "STARRED", "UNREAD"],
              isStarred: true,
            }),
            fixture("b", { threadId: "same", labels: ["INBOX", "UNREAD"] }),
            fixture("c", {
              threadId: "same",
              labels: ["STARRED"],
              isUnread: false,
              isStarred: true,
            }),
            fixture("d", { labels: ["DRAFT"], isUnread: false }),
          ]),
        }),
      ),
    ),
);

it.effect(
  "Important writes Gmail labels and Outlook importance and changes local list filters immediately",
  () =>
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      for (const provider of ["gmail", "outlook"] as const) {
        const account = yield* mailbox.connect({ provider });
        yield* mailbox.sync(account.id);
        const id = `${account.id}/m`;
        yield* mailbox.modifyWithUndo([id], { kind: "important", value: true });
        assert.strictEqual(
          (yield* mailbox.threads({ accountIds: [account.id], search: "is:important" })).length,
          1,
        );
        yield* mailbox.modifyWithUndo([id], { kind: "important", value: false });
        assert.strictEqual(
          (yield* mailbox.threads({ accountIds: [account.id], search: "is:important" })).length,
          0,
        );
      }
    }).pipe(
      Effect.provide(
        TestMailbox({
          gmail: fakeServer("me@gmail.com", [fixture("m", { labels: ["INBOX"] })]),
          outlook: fakeServer("me@outlook.com", [fixture("m", { labels: ["INBOX"] })]),
        }),
      ),
    ),
);

it.effect(
  "private message and conversation links survive an IMAP UID change and can recover uncached mail by Message-ID",
  () => {
    const server = fakeServer("me@example.com", [
      fixture("old", { rfcMessageId: "<stable@example.com>" }),
    ]);
    return Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const account = yield* mailbox.connect({
        provider: "imap",
        input: {
          preset: "custom",
          email: server.email,
          password: "secret",
          imapHost: "fake.invalid",
          smtpHost: "fake.invalid",
        },
      });
      yield* mailbox.sync();
      const link = yield* mailbox.privateMailLink(`${account.id}/old`, "message");
      const parsed = parseAppLink(link);
      assert.ok(parsed?.kind === "message");
      assert.deepStrictEqual(parseStableReference(parsed.id), {
        accountId: account.id,
        messageId: "stable@example.com",
      });
      const thread = parseAppLink(
        privateMailLink(
          { id: "old", accountId: account.id, rfcMessageId: "<stable@example.com>" },
          "thread",
        ),
      );
      assert.ok(thread?.kind === "message" && thread.single === false);
      server.messages.delete("old");
      server.messages.set("new", fixture("new", { rfcMessageId: "<stable@example.com>" }));
      yield* mailbox.sync();
      assert.strictEqual(yield* mailbox.resolveMailLink(parsed.id), `${account.id}/new`);
      server.messages.set(
        "uncached",
        fixture("uncached", { rfcMessageId: "<uncached@example.com>" }),
      );
      const uncached = privateMailLink(
        { id: "unused", accountId: account.id, rfcMessageId: "<uncached@example.com>" },
        "message",
      );
      const target = parseAppLink(uncached);
      assert.ok(target?.kind === "message");
      assert.strictEqual(yield* mailbox.resolveMailLink(target.id), `${account.id}/uncached`);
      assert.ok(server.searched.some((q) => q.search?.includes("rfc822msgid:")));
    }).pipe(Effect.provide(TestMailbox({ imap: server })));
  },
);

const invitation = (
  sequence: number,
  start: string,
  location: string,
  method = "REQUEST",
  status = "NEEDS-ACTION",
) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:${method}\r\nBEGIN:VEVENT\r\nUID:event@example.com\r\nSEQUENCE:${sequence}\r\nDTSTART:${start}\r\nDTEND:20261003T110000Z\r\nSUMMARY:Meeting\r\nLOCATION:${location}\r\nORGANIZER:mailto:org@example.com\r\nATTENDEE;ROLE=OPT-PARTICIPANT;PARTSTAT=${status}:mailto:me@example.com\r\nEND:VEVENT\r\nEND:VCALENDAR`;
it("optional attendees survive replies and invite history compares time/location and summarizes responses", () => {
  const old = parseCalendar(invitation(1, "20261003T090000Z", "Old room"))[0];
  const next = parseCalendar(invitation(2, "20261003T100000Z", "New room"))[0];
  const response = parseCalendar(
    invitation(2, "20261003T100000Z", "New room", "REPLY", "ACCEPTED"),
  )[0];
  assert.ok(old && next && response);
  assert.strictEqual(next.invite.attendees[0]?.optional, true);
  const reply = inviteReply(next, { name: "Me", address: "me@example.com" }, "accepted", "source");
  assert.ok(reply.calendar?.content.includes("ROLE=OPT-PARTICIPANT"));
  const annotated = inviteHistory(next.invite, [old.invite, next.invite, response.invite]);
  assert.deepStrictEqual(annotated.previous, {
    start: old.invite.start,
    end: old.invite.end,
    location: "Old room",
  });
  assert.strictEqual(annotated.threadStatus?.statuses[0]?.status, "ACCEPTED");
  assert.strictEqual(
    inviteHistory(old.invite, [old.invite, next.invite]).threadStatus?.sequence,
    2,
  );
});

it.effect(
  "extended rules preview has words, excludes words and size before applying importance and multiple labels",
  () =>
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const account = yield* mailbox.connect({ provider: "gmail" });
      yield* mailbox.sync();
      yield* mailbox.changeLabel(account.id, { kind: "create", name: "Work" });
      const label = (yield* mailbox.labels([account.id]))[0];
      assert.ok(label);
      const input = {
        ...EMPTY_FILTER,
        criteria: {
          ...EMPTY_FILTER.criteria,
          hasWords: "budget",
          notWords: "foxes",
          size: 1_000_000,
          sizeComparison: "larger" as const,
        },
        action: {
          ...EMPTY_FILTER.action,
          important: false,
          labels: [label.id],
          category: "CATEGORY_UPDATES" as const,
        },
      };
      const preview = yield* mailbox.prepareFilter(account.id, input);
      assert.strictEqual(preview.matches.length, 1);
      yield* mailbox.applyFilter(account.id, input, preview.token);
      const [message] = yield* mailbox.thread(`${account.id}/a`);
      assert.ok(message?.labels.includes("CATEGORY_UPDATES"));
      assert.ok(!message?.labels.includes("IMPORTANT"));
    }).pipe(Effect.provide(TestMailbox({ gmail: fakeServer("me@example.com", fixtures) }))),
);

it.effect(
  "explicit RSVP persists in the thread summary and a newer sequence requires a new response",
  () => {
    const message = fixture("invite", { threadId: "meeting", hasCalendar: true });
    const server = fakeServer("me@example.com", [message]);
    const source = (sequence: number) =>
      Buffer.from(
        `From: org@example.com\r\nTo: me@example.com\r\nContent-Type: text/calendar; method=REQUEST\r\n\r\n${invitation(sequence, "20261003T100000Z", "Room")}`,
      );
    server.raw.set("invite", source(1));
    return Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const account = yield* mailbox.connect({ provider: "gmail" });
      yield* mailbox.sync();
      const id = `${account.id}/invite`;
      const [initial] = yield* mailbox.invitations(id);
      assert.ok(initial);
      yield* mailbox.respondInvite(id, initial.key, "accepted", { kind: "user", surface: "app" });
      assert.strictEqual(
        (yield* mailbox.invitations(id))[0]?.threadStatus?.statuses.find(
          (a) => a.address === "me@example.com",
        )?.status,
        "ACCEPTED",
      );
      server.raw.set("invite", source(2));
      assert.strictEqual(
        (yield* mailbox.invitations(id))[0]?.threadStatus?.statuses.find(
          (a) => a.address === "me@example.com",
        )?.status,
        "NEEDS-ACTION",
      );
      assert.strictEqual(server.responses.length, 1);
    }).pipe(Effect.provide(TestMailbox({ gmail: server })));
  },
);

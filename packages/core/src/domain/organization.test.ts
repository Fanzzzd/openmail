import { incoming as makeIncoming, fakeServer, TestMailbox } from "../platform/node/testing.js";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";
import type { IncomingMessage } from "./message.js";
import type { Account } from "./account.js";
import { ProviderError, SettingsScopeMissing } from "./errors.js";
import { makeFakeProvider } from "../platform/node/fake-provider.js";
import { MailboxLive } from "../mailbox/mailbox-live.js";
import { Mailbox } from "../mailbox/mailbox.js";
import { EMPTY_FILTER, EMPTY_VACATION, snoozeTimes, sameFilterRule } from "./organization.js";
import { MemoryPlatform } from "../platform/node/platform-memory.js";
import { Providers } from "../providers/adapter.js";
import { Store } from "../store/service.js";
import { StoreLive } from "../store/store.js";
import { filterQuery, parseSearchQuery } from "../search/search.js";
import { matchesSearch } from "../search/search-match.js";
import { makeOutlookSettings } from "../providers/outlook/outlook-settings.js";
{
  const incoming = (id: string, overrides: Partial<IncomingMessage> = {}): IncomingMessage =>
    makeIncoming(id, {
      threadId: `t-${id}`,
      subject: "Sales report",
      to: [],
      bodyText: "report",
      labels: ["INBOX"],
      isUnread: false,
      ...overrides,
    });

  const withMailbox = <A, E>(
    body: (m: Mailbox["Service"], server: ReturnType<typeof fakeServer>) => Effect.Effect<A, E>,
  ) => {
    const server = fakeServer("me@gmail.com", [incoming("m1"), incoming("newer", { date: 2000 })]);
    return Effect.gen(function* () {
      const m = yield* Mailbox;
      yield* m.connect({ provider: "gmail" });
      yield* m.sync();
      return yield* body(m, server);
    }).pipe(Effect.provide(TestMailbox({ gmail: server })));
  };

  it.effect("search fetches uncached mail, merges/dedups it, and contains server failures", () =>
    withMailbox((m, server) =>
      Effect.gen(function* () {
        server.messages.set("remote", incoming("remote", { date: 3000 }));
        server.messages.set("same", incoming("same", { threadId: "t-m1", date: 4000 }));
        assert.strictEqual((yield* m.reading.threads({ search: "report" })).length, 2);
        const found = yield* m.reading.searchServer({
          search: "report",
          accountIds: ["gmail:me@gmail.com"],
        });
        assert.strictEqual(found.threads.length, 3);
        assert.strictEqual(found.threads[0]?.id, "gmail:me@gmail.com/same");
        assert.strictEqual((yield* m.reading.thread("gmail:me@gmail.com/remote")).length, 1);
        server.failNext = new ProviderError({ message: "offline" });
        const offline = yield* m.reading.searchServer({ search: "report" });
        assert.strictEqual(offline.threads.length, 3);
        assert.strictEqual(offline.errors.length, 1);
        assert.strictEqual((yield* m.accounts)[0]?.needsReauth, false);
        assert.strictEqual(
          (yield* m.reading.searchServer({ search: "report", accountIds: [] })).threads.length,
          0,
        );
      }),
    ),
  );

  it.effect(
    "snooze survives sync and new thread members; waking promotes and marks unread once",
    () =>
      withMailbox((m, server) =>
        Effect.gen(function* () {
          yield* m.snooze(["gmail:me@gmail.com/m1"], 10_000);
          assert.strictEqual(server.pushed.length, 0); // Hiding is local; Gmail has no snooze API.
          yield* m.sync();
          assert.strictEqual((yield* m.reading.threads({ mailbox: "inbox" })).length, 1);
          assert.strictEqual((yield* m.reading.threads({ mailbox: "snoozed" })).length, 1);
          server.messages.set("reply", incoming("reply", { threadId: "t-m1", date: 1500 }));
          yield* m.sync();
          assert.strictEqual((yield* m.reading.threads({ mailbox: "inbox" })).length, 1);
          yield* TestClock.adjust("10 seconds");
          yield* m.wakeSnoozed();
          const inbox = yield* m.reading.threads({ mailbox: "inbox" });
          assert.strictEqual(inbox[0]?.threadId, "t-m1");
          assert.strictEqual(inbox[0]?.isUnread, true);
          assert.deepStrictEqual(yield* m.reading.threads({ mailbox: "snoozed" }), []);
          assert.strictEqual(server.pushed.length, 2);
          yield* m.wakeSnoozed();
          assert.strictEqual(server.pushed.length, 2);
          yield* m.sync();
          assert.strictEqual((yield* m.reading.threads({ mailbox: "inbox" }))[0]?.isUnread, true);
        }),
      ),
  );

  it.effect("a rebuilt Mailbox resumes persisted reminders, including overdue ones", () => {
    const server = fakeServer("me@gmail.com", [incoming("m1")]);
    const adapter = makeFakeProvider(server);
    const providers = Layer.succeed(Providers, { get: () => adapter });
    const dependencies = Layer.mergeAll(StoreLive, providers).pipe(
      Layer.provideMerge(MemoryPlatform()),
    );
    return Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount("gmail", server.email);
      yield* store.upsertMessage(account.id, incoming("m1"));
      yield* Effect.gen(function* () {
        const m = yield* Mailbox;
        yield* m.snooze([`${account.id}/m1`], 1000);
      }).pipe(Effect.provide(MailboxLive({ backgroundFlush: false })));
      yield* TestClock.adjust("2 seconds");
      yield* Effect.gen(function* () {
        const m = yield* Mailbox;
        yield* m.wakeSnoozed();
        const inbox = yield* m.reading.threads({ mailbox: "inbox" });
        assert.strictEqual(inbox.length, 1);
        assert.strictEqual(inbox[0]?.isUnread, true);
      }).pipe(Effect.provide(MailboxLive({ backgroundFlush: false })));
    }).pipe(Effect.provide(dependencies));
  });

  it.effect("offline wake does not lose unread or inbox state on stale sync", () =>
    withMailbox((m, server) =>
      Effect.gen(function* () {
        yield* m.snooze(["gmail:me@gmail.com/m1"], 1000);
        yield* TestClock.adjust("2 seconds");
        server.failNext = new ProviderError({ message: "offline" });
        yield* m.wakeSnoozed();
        assert.strictEqual(server.pushed.length, 0); // The dependent move waits for the failed unread op.
        assert.strictEqual(
          (yield* m.reading.threads({ mailbox: "inbox" })).find(
            (row) => row.id === "gmail:me@gmail.com/m1",
          )?.isUnread,
          true,
        );
        yield* TestClock.adjust("5 seconds");
        yield* m.sync();
        assert.strictEqual(server.pushed.length, 2);
        assert.strictEqual((yield* m.reading.thread("gmail:me@gmail.com/m1"))[0]?.isUnread, true);
      }),
    ),
  );

  it.effect("labels, favorites, visibility and categories survive provider label refresh", () =>
    withMailbox((m) =>
      Effect.gen(function* () {
        const id = "gmail:me@gmail.com";
        yield* m.changeLabel(id, { kind: "create", name: "Customers" });
        const [label] = yield* m.reading.labels([id]);
        assert.ok(label);
        yield* m.changeLabel(id, { kind: "rename", id: label.id, name: "Clients" });
        yield* m.changeLabel(id, { kind: "color", id: label.id, color: "#4986e7" });
        yield* m.setLabelPreference({
          accountId: id,
          id: label.id,
          visible: false,
          favorite: true,
          color: null,
        });
        yield* m.setOrganization({ accountId: id, categories: false });
        yield* m.sync();
        assert.strictEqual((yield* m.reading.labels([id]))[0]?.name, "Clients");
        assert.strictEqual((yield* m.reading.labels([id]))[0]?.color, "#4986e7");
        assert.strictEqual((yield* m.labelPreferences)[0]?.favorite, true);
        assert.strictEqual((yield* m.organization)[0]?.categories, false);
        yield* m.changeLabel(id, { kind: "delete", id: label.id });
        assert.deepStrictEqual(yield* m.reading.labels([id]), []);
        const exit = yield* Effect.exit(m.changeLabel(id, { kind: "delete", id: "INBOX" }));
        assert.strictEqual(exit._tag, "Failure");
      }),
    ),
  );

  it.effect(
    "filter preview searches Gmail; create/delete and vacation roundtrip through the provider",
    () =>
      withMailbox((m, server) =>
        Effect.gen(function* () {
          const id = "gmail:me@gmail.com";
          const input = {
            ...EMPTY_FILTER,
            name: "Sales",
            criteria: { ...EMPTY_FILTER.criteria, from: "alice@example.com" },
            action: { ...EMPTY_FILTER.action, markRead: true },
          };
          assert.strictEqual((yield* m.previewFilter(id, input.criteria)).length, 2);
          assert.strictEqual(server.searched.length, 1);
          const prepared = yield* m.prepareFilter(id, input);
          const filter = yield* m.createFilter(id, input, prepared.token);
          assert.strictEqual((yield* m.filters(id))[0]?.id, filter.id);
          yield* m.deleteFilter(id, filter.id, true);
          assert.deepStrictEqual(yield* m.filters(id), []);
          const vacation = {
            ...EMPTY_VACATION,
            enabled: true,
            start: 1000,
            end: 2000,
            subject: "Away",
            body: "Back tomorrow",
            contactsOnly: true,
          };
          yield* m.setVacation(id, vacation);
          assert.deepStrictEqual(yield* m.vacation(id), vacation);
          assert.strictEqual(
            (yield* Effect.exit(m.createFilter(id, EMPTY_FILTER)))._tag,
            "Failure",
          );
          assert.strictEqual(
            (yield* Effect.exit(m.setVacation(id, { ...vacation, end: 500 })))._tag,
            "Failure",
          );
        }),
      ),
  );

  it.effect(
    "Gmail signatures sync without replacing local signatures; verified aliases can send",
    () =>
      withMailbox((m, server) =>
        Effect.gen(function* () {
          const id = "gmail:me@gmail.com";
          server.aliases = [
            {
              accountId: id,
              address: "alias@example.com",
              name: "Me",
              isDefault: true,
              signature: "Gmail signature",
            },
          ];
          yield* m.syncSendAs(id);
          assert.strictEqual((yield* m.compose.signatures).length, 2);
          yield* m.compose.setSignature({
            address: "alias@example.com",
            kind: "new",
            text: "Local signature",
          });
          server.aliases = server.aliases.map((a) => ({ ...a, signature: "Updated" }));
          yield* m.sync();
          const signatures = yield* m.compose.signatures;
          assert.strictEqual(signatures.find((s) => s.kind === "new")?.text, "Local signature");
          assert.strictEqual(signatures.find((s) => s.kind === "reply")?.text, "Updated");
          const message = {
            from: { name: "Me", address: "alias@example.com" },
            to: [{ name: "", address: "alice@example.com" }],
            cc: [],
            bcc: [],
            subject: "Hi",
            text: "Hello",
            attachments: [],
          };
          yield* m.perform(
            { kind: "send", accountId: id, message },
            { kind: "user", surface: "app" },
          );
          assert.strictEqual(server.sent[0]?.message.from?.address, "alias@example.com");
          assert.strictEqual(
            (yield* Effect.exit(
              m.perform(
                {
                  kind: "send",
                  accountId: id,
                  message: { ...message, from: { name: "", address: "unverified@example.com" } },
                },
                { kind: "user", surface: "app" },
              ),
            ))._tag,
            "Failure",
          );
          server.aliases = [];
          yield* m.syncSendAs(id);
          assert.strictEqual((yield* m.compose.signatures).length, 1);
        }),
      ),
  );

  it("reminder presets use future local morning times", () => {
    const now = new Date(2026, 8, 30, 18, 30).getTime();
    const times = snoozeTimes(now);
    assert.strictEqual(times.later - now, 3 * 60 * 60_000);
    assert.strictEqual(new Date(times.tomorrow).getHours(), 9);
    assert.strictEqual(new Date(times.nextWeek).getDate(), 7);
    assert.ok(times.tomorrow > now);
  });

  it.effect("existing accounts keep syncing when optional settings scope is missing", () =>
    withMailbox((m, server) =>
      Effect.gen(function* () {
        server.settingsFailure = new SettingsScopeMissing({
          accountId: "gmail:me@gmail.com",
          message: "Missing settings scope",
        });
        assert.strictEqual(
          (yield* m.filters("gmail:me@gmail.com").pipe(Effect.flip))._tag,
          "SettingsScopeMissing",
        );
        assert.strictEqual(
          (yield* m.vacation("gmail:me@gmail.com").pipe(Effect.flip))._tag,
          "SettingsScopeMissing",
        );
        const sync = yield* m.sync();
        assert.strictEqual(sync[0]?.error, undefined);
        assert.strictEqual((yield* m.accounts)[0]?.needsReauth, false);
        assert.strictEqual((yield* m.reading.threads({ mailbox: "inbox" })).length, 2);
      }),
    ),
  );

  for (const provider of ["gmail", "outlook", "imap"] as const) {
    it.effect(`snooze changes only the original inbox members on ${provider}`, () => {
      const members = [
        incoming("inbox", { threadId: "mixed" }),
        ...["SENT", "DRAFT", "TRASH", "SPAM"].map((label) =>
          incoming(label, { threadId: "mixed", labels: [label] }),
        ),
      ];
      const server = fakeServer("me@example.com", members);
      const adapter = makeFakeProvider(server);
      return Effect.gen(function* () {
        const store = yield* Store;
        const m = yield* Mailbox;
        const account = yield* store.upsertAccount(provider, server.email);
        for (const message of members) yield* store.upsertMessage(account.id, message);
        yield* m.snooze([`${account.id}/inbox`], 1000);
        for (const message of members.slice(1)) {
          assert.deepStrictEqual(
            (yield* store.getMessage(`${account.id}/${message.providerId}`)).labels,
            message.labels,
          );
          yield* store.upsertMessage(account.id, message);
          assert.deepStrictEqual(
            (yield* store.getMessage(`${account.id}/${message.providerId}`)).labels,
            message.labels,
          );
        }
        yield* TestClock.adjust("2 seconds");
        yield* m.wakeSnoozed();
        assert.deepStrictEqual(
          server.pushed.map((p) => p.providerId),
          ["inbox", "inbox"],
        );
        for (const message of members.slice(1)) {
          yield* store.upsertMessage(account.id, message);
          yield* store.setFlags(account.id, message.providerId, {
            isUnread: false,
            isStarred: false,
          });
          const local = yield* store.getMessage(`${account.id}/${message.providerId}`);
          assert.deepStrictEqual(local.labels, message.labels);
          assert.strictEqual(local.isUnread, false);
        }
      }).pipe(
        Effect.provide(
          TestMailbox.withAdapter(adapter, {
            options: { backgroundFlush: false },
            platformOptions: {},
          }),
        ),
      );
    });
  }

  it.effect("read-only listing never wakes or pushes an overdue reminder", () =>
    withMailbox((m, server) =>
      Effect.gen(function* () {
        yield* m.snooze(["gmail:me@gmail.com/m1"], 1000);
        yield* TestClock.adjust("2 seconds");
        yield* m.reading.threads({ mailbox: "inbox" });
        assert.strictEqual(server.pushed.length, 0);
        assert.ok(
          (yield* m.reading.thread("gmail:me@gmail.com/m1"))[0]?.labels.includes("SNOOZED"),
        );
        yield* m.sync();
        assert.strictEqual(server.pushed.length, 2);
      }),
    ),
  );

  it.effect("Gmail filter preview uses authoritative server matches for native operators", () =>
    withMailbox((m, server) =>
      Effect.gen(function* () {
        server.searchResults = [incoming("m1"), incoming("remote")];
        const query = "-from:spam@example.com OR {from:alice to:me} in:anywhere larger:1";
        const preview = yield* m.previewFilter("gmail:me@gmail.com", {
          ...EMPTY_FILTER.criteria,
          query,
        });
        assert.strictEqual(preview.length, 2);
        assert.strictEqual(server.searched.at(-1)?.search, query);
      }),
    ),
  );

  it.effect("deleting filters with a free-form query require explicit confirmation", () =>
    withMailbox((m, server) =>
      Effect.gen(function* () {
        const filter = {
          ...EMPTY_FILTER,
          criteria: { ...EMPTY_FILTER.criteria, query: "-from:spam OR from:alice" },
          action: { ...EMPTY_FILTER.action, trash: true },
        };
        const exit = yield* Effect.exit(m.createFilter("gmail:me@gmail.com", filter));
        assert.strictEqual(exit._tag, "Failure");
        assert.strictEqual(server.filters.length, 0);
        const prepared = yield* m.prepareFilter("gmail:me@gmail.com", filter);
        yield* m.createFilter(
          "gmail:me@gmail.com",
          { ...filter, queryDeletionConfirmed: true },
          prepared.token,
        );
        assert.strictEqual(server.filters.length, 1);
      }),
    ),
  );

  it.effect("server search cannot overwrite an optimistic change waiting for push", () =>
    withMailbox((m, server) =>
      Effect.gen(function* () {
        server.failNext = new ProviderError({ message: "offline" });
        yield* m.perform(
          { kind: "modify", threads: ["gmail:me@gmail.com/m1"], op: { kind: "archive" } },
          { kind: "user", surface: "app" },
        );
        assert.ok(!(yield* m.reading.thread("gmail:me@gmail.com/m1"))[0]?.labels.includes("INBOX"));
        yield* m.reading.searchServer({ search: "report" });
        assert.ok(!(yield* m.reading.thread("gmail:me@gmail.com/m1"))[0]?.labels.includes("INBOX"));
        assert.strictEqual(server.pushed.length, 0);
      }),
    ),
  );

  it.effect(
    "Gmail snoozes mixed Inbox/Sent conversations from the sent reply and wakes only the Inbox member",
    () => {
      const inbox = incoming("original", { threadId: "self-thread", labels: ["INBOX", "SENT"] });
      const sent = incoming("reply", { threadId: "self-thread", labels: ["SENT"], date: 2000 });
      const server = fakeServer("me@gmail.com", [inbox, sent]);
      return Effect.gen(function* () {
        const m = yield* Mailbox;
        const account = yield* m.connect({ provider: "gmail" });
        yield* m.sync();
        yield* m.snooze([`${account.id}/reply`], 1000);
        let members = yield* m.reading.thread(`${account.id}/reply`);
        assert.ok(members.find((x) => x.id.endsWith("/original"))?.labels.includes("SNOOZED"));
        assert.deepStrictEqual(members.find((x) => x.id.endsWith("/reply"))?.labels, ["SENT"]);
        yield* m.sync();
        assert.strictEqual((yield* m.reading.threads({ mailbox: "snoozed" })).length, 1);
        yield* TestClock.adjust("2 seconds");
        yield* m.wakeSnoozed();
        assert.deepStrictEqual(
          server.pushed.map((p) => p.providerId),
          ["original", "original"],
        );
        members = yield* m.reading.thread(`${account.id}/reply`);
        assert.ok(members.find((x) => x.id.endsWith("/original"))?.labels.includes("INBOX"));
        assert.ok(members.find((x) => x.id.endsWith("/original"))?.labels.includes("SENT"));
        assert.deepStrictEqual(members.find((x) => x.id.endsWith("/reply"))?.labels, ["SENT"]);
        assert.strictEqual(members.find((x) => x.id.endsWith("/reply"))?.isUnread, false);
      }).pipe(Effect.provide(TestMailbox({ gmail: server })));
    },
  );

  it.effect("Outlook folder colors stay local and remain usable immediately after creation", () => {
    const server = fakeServer("me@outlook.com");
    const adapter = makeFakeProvider(server);
    let colorCalls = 0;
    const providers = Layer.succeed(Providers, {
      get: () => ({
        ...adapter,
        changeLabel: (...args: Parameters<typeof adapter.changeLabel>) => {
          if (args[1].kind === "color") colorCalls++;
          return adapter.changeLabel(...args);
        },
      }),
    });
    return Effect.gen(function* () {
      const m = yield* Mailbox;
      const account = yield* m.connect({ provider: "outlook" });
      yield* m.changeLabel(account.id, { kind: "create", name: "Test" });
      const folder = (yield* m.reading.labels([account.id])).find((l) => l.name === "Test");
      assert.ok(folder);
      yield* m.changeLabel(account.id, { kind: "color", id: folder.id, color: "#b99aff" });
      assert.strictEqual(colorCalls, 0);
      assert.strictEqual(
        (yield* m.labelPreferences).find((p) => p.id === folder.id)?.color,
        "#b99aff",
      );
      yield* m.changeLabel(account.id, { kind: "rename", id: folder.id, name: "Renamed" });
      yield* m.sync();
      assert.strictEqual(
        (yield* m.reading.labels([account.id])).find((l) => l.id === folder.id)?.name,
        "Renamed",
      );
      assert.strictEqual(
        (yield* m.labelPreferences).find((p) => p.id === folder.id)?.color,
        "#b99aff",
      );
      yield* m.changeLabel(account.id, { kind: "delete", id: folder.id });
      assert.ok(!(yield* m.reading.labels([account.id])).some((l) => l.id === folder.id));
      assert.ok(!(yield* m.labelPreferences).some((p) => p.id === folder.id));
    }).pipe(
      Effect.provide(
        MailboxLive({ backgroundFlush: false }).pipe(
          Layer.provide(
            Layer.mergeAll(StoreLive, providers).pipe(Layer.provideMerge(MemoryPlatform())),
          ),
        ),
      ),
    );
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
        const messages = yield* mailbox.reading.unreadByLabel([account.id], undefined, false);
        const conversations = yield* mailbox.reading.unreadByLabel([account.id], undefined, true);
        assert.strictEqual(messages["INBOX"], 2);
        assert.strictEqual(conversations["INBOX"], 1);
        assert.strictEqual(messages["STARRED"], 2);
        assert.strictEqual(conversations["STARRED"], 1);
        assert.strictEqual(messages["DRAFT"], 1);
        assert.strictEqual((yield* mailbox.reading.unreadCounts)[account.id], 1);
        yield* mailbox.app.setPrefs({ threadGrouping: false });
        assert.strictEqual((yield* mailbox.reading.unreadCounts)[account.id], 2);
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
            (yield* mailbox.reading.threads({ accountIds: [account.id], search: "is:important" }))
              .length,
            1,
          );
          yield* mailbox.modifyWithUndo([id], { kind: "important", value: false });
          assert.strictEqual(
            (yield* mailbox.reading.threads({ accountIds: [account.id], search: "is:important" }))
              .length,
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
    "extended rules preview has words, excludes words and size before applying importance and multiple labels",
    () =>
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const account = yield* mailbox.connect({ provider: "gmail" });
        yield* mailbox.sync();
        yield* mailbox.changeLabel(account.id, { kind: "create", name: "Work" });
        const label = (yield* mailbox.reading.labels([account.id]))[0];
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
        const [message] = yield* mailbox.reading.thread(`${account.id}/a`);
        assert.ok(message?.labels.includes("CATEGORY_UPDATES"));
        assert.ok(!message?.labels.includes("IMPORTANT"));
      }).pipe(Effect.provide(TestMailbox({ gmail: fakeServer("me@example.com", fixtures) }))),
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

  it("rule exception preview excludes sender, To/CC, subject and attachment independently", () => {
    const fixtures = [
      message("keep"),
      { ...message("sender"), from: { name: "", address: "except@example.com" } },
      { ...message("cc"), cc: [{ name: "", address: "except@example.com" }] },
      { ...message("subject"), subject: "Skip" },
      {
        ...message("attachment"),
        attachments: [{ filename: "a", mimeType: "text/plain", size: 1 }],
      },
    ];
    const query = filterQuery({
      ...EMPTY_FILTER.criteria,
      exceptFrom: "except@",
      exceptTo: "except@",
      exceptSubject: "Skip",
      exceptAttachment: true,
    });
    assert.deepStrictEqual(
      fixtures.filter((m) => matchesSearch(m, query)).map((m) => m.providerId),
      ["keep"],
    );
    assert.strictEqual(
      parseSearchQuery({ search: 'header:"x-test:100%_literal"' }).criteria?.header?.value,
      "100%_literal",
    );
  });
}

{
  it.effect("Graph rules preserve and clear supported exceptions and stopProcessingRules", () => {
    let rule: unknown = {
      id: "one",
      displayName: "Rule",
      conditions: { subjectContains: ["Travel"] },
      exceptions: {
        senderContains: ["exclude@"],
        recipientContains: ["friend@"],
        subjectContains: ["Skip"],
        hasAttachments: true,
        bodyOrSubjectContains: ["ignore"],
      },
      actions: { markAsRead: true, stopProcessingRules: true },
    };
    const writes: unknown[] = [];
    const adapter = makeOutlookSettings<ProviderError>(
      (_id, schema, path) =>
        Schema.decodeUnknownEffect(schema)(
          path === "/me/mailFolders/inbox/messageRules" ? { value: [] } : rule,
        ).pipe(Effect.orDie),
      (_id, _method, _path, body) =>
        Effect.sync(() => {
          writes.push(body);
          rule = {
            id: "one",
            ...Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(body),
          };
          return rule;
        }),
    );
    const account: Account = {
      id: "outlook:me@example.com",
      provider: "outlook",
      email: "me@example.com",
      color: null,
      profileId: null,
      needsReauth: false,
      createdAt: 0,
      lastSyncedAt: null,
      lastSyncError: null,
    };
    return Effect.gen(function* () {
      const created = yield* adapter.createFilter(account, {
        ...EMPTY_FILTER,
        name: "Rule",
        criteria: {
          ...EMPTY_FILTER.criteria,
          subject: "Travel",
          exceptFrom: "exclude@",
          exceptTo: "friend@",
          exceptSubject: "Skip",
          exceptAttachment: true,
          notWords: "ignore",
        },
        action: { ...EMPTY_FILTER.action, markRead: true, stopProcessing: true },
      });
      assert.notStrictEqual(created.editable, false);
      assert.strictEqual(created.criteria.exceptAttachment, true);
      const updated = yield* adapter.updateFilter(account, "one", created);
      assert.ok(sameFilterRule(created, updated));
      const cleared = yield* adapter.updateFilter(account, "one", {
        ...created,
        criteria: { ...EMPTY_FILTER.criteria, subject: "Travel" },
        action: { ...EMPTY_FILTER.action, markRead: true, stopProcessing: false },
      });
      assert.strictEqual(cleared.criteria.exceptFrom, undefined);
      assert.strictEqual(cleared.criteria.exceptAttachment, undefined);
      assert.strictEqual(cleared.action.stopProcessing, false);
      const parsed = Schema.decodeUnknownSync(
        Schema.Struct({ exceptions: Schema.Record(Schema.String, Schema.Unknown) }),
      )(writes[2]);
      assert.deepStrictEqual(parsed.exceptions, {});
    });
  });

  it.effect(
    "Outlook refuses no-attachment exceptions in preview preparation and provider writes",
    () => {
      const server = fakeServer("me@outlook.com");
      return Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const account = yield* mailbox.connect({ provider: "outlook" });
        yield* mailbox.sync();
        const input = {
          ...EMPTY_FILTER,
          name: "Unsafe",
          criteria: { ...EMPTY_FILTER.criteria, subject: "Travel", exceptAttachment: false },
          action: { ...EMPTY_FILTER.action, markRead: true },
        };
        assert.strictEqual(
          (yield* mailbox.prepareFilter(account.id, input).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.strictEqual(
          (yield* mailbox.createFilter(account.id, input).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.strictEqual(
          (yield* mailbox.previewFilter(account.id, input.criteria).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.deepStrictEqual(server.filters, []);
        let calls = 0;
        const get = <A>(_id: string, _schema: Schema.Decoder<A>, _path: string) =>
          Effect.die("Unexpected provider read");
        const adapter = makeOutlookSettings<ProviderError>(get, () =>
          Effect.sync(() => {
            calls++;
            return {};
          }),
        );
        assert.strictEqual(
          (yield* adapter.createFilter(account, input).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.strictEqual(
          (yield* adapter.updateFilter(account, "one", input).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.strictEqual(calls, 0);
      }).pipe(Effect.provide(TestMailbox({ outlook: server })));
    },
  );
}

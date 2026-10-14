import { applyNativeMigration } from "../platform/node/migrations.js";
import { incoming as makeIncoming, fakeServer, TestMailbox } from "../platform/node/testing.js";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { SqlClient } from "effect/sql";
import { DatabaseSync } from "node:sqlite";
import { databaseLayer, MIGRATIONS } from "../platform/node/db.js";
import type { IncomingMessage } from "../domain/message.js";
import type { Prefs } from "../domain/prefs.js";
import { Mailbox } from "../mailbox/mailbox.js";
import { Store } from "../store/service.js";
import { StoreLive } from "../store/store.js";
import { gmailThreadUrl, officialMessageUrl, senderName, threadExpansion } from "./reading.js";
import { parseSearchQuery } from "../search/search.js";
import { senderSearchQuery } from "../search/search-field.js";
import { MemoryPlatform } from "../platform/node/platform-memory.js";
import { parseAppLink, parseStableReference, privateMailLink, messageLink } from "../app/system.js";
{
  const incoming: IncomingMessage = makeIncoming("first", {
    threadId: "conversation",
    subject: "First",
    to: [],
    bodyText: "searchable",
    labels: ["INBOX"],
    isUnread: false,
  });

  it("expands and collapses every ID independently of thread order or duplicate IDs", () => {
    assert.deepStrictEqual([...threadExpansion(["old", "new", "old"], true)], ["old", "new"]);
    assert.strictEqual(threadExpansion(["old", "new"], false).size, 0);
    assert.strictEqual(threadExpansion([], true).size, 0);
    assert.strictEqual(senderName(incoming.from), "Alice");
    assert.strictEqual(senderName({ name: "", address: "a@example.com" }), "a@example.com");
  });

  it("drops the sender's own address from the display name and keeps a different one", () => {
    const azure = "azure@infoemails.microsoft.com";
    for (const name of [
      `Microsoft Azure <${azure}>`,
      `"Microsoft Azure" (${azure})`,
      `Microsoft Azure ${azure.toUpperCase()}`,
      `Microsoft Azure - ${azure}`,
    ])
      assert.strictEqual(senderName({ name, address: azure }), "Microsoft Azure");
    assert.strictEqual(senderName({ name: azure, address: azure }), azure);
    assert.strictEqual(senderName({ name: `"${azure}"`, address: azure }), azure);
    assert.strictEqual(
      senderName({ name: "Bank <help@bank.example>", address: azure }),
      "Bank <help@bank.example>",
    );
    assert.strictEqual(senderName({ name: "Al​ice", address: "a@example.com" }), "Alice");
    // A longer address that merely contains the sender's stays whole for the spoofing warning.
    assert.strictEqual(
      senderName({ name: "support@paypal.com", address: "support@paypal.co" }),
      "support@paypal.com",
    );
    assert.strictEqual(
      senderName({ name: "PayPal support@paypal.com.au", address: "support@paypal.com" }),
      "PayPal support@paypal.com.au",
    );
    assert.strictEqual(
      senderName({ name: "PayPal x.support@paypal.com", address: "support@paypal.com" }),
      "PayPal x.support@paypal.com",
    );
  });

  it("quotes sender addresses so spaces, quotes, slashes and operators cannot inject criteria", () => {
    for (const address of [
      "alice@example.com",
      'a"b\\c@example.com is:unread',
      'a@example.com" label:"INBOX',
    ]) {
      const parsed = parseSearchQuery({ search: senderSearchQuery(address) });
      assert.strictEqual(parsed.criteria?.from, address);
      assert.strictEqual(parsed.search, "");
      assert.strictEqual(parsed.unreadOnly, undefined);
      assert.strictEqual(parsed.criteria?.labels, undefined);
    }
  });

  it("web mail links require exact official HTTPS origins and never accept credentials", () => {
    for (const value of [
      "http://outlook.live.com/mail/",
      "https://outlook.live.com.evil.test/mail/",
      "https://outlook.live.com:444/mail/",
      "https://user@outlook.live.com/mail/",
      "javascript:alert(1)",
      "//outlook.live.com/mail/",
      "https://evil.test/?next=https://outlook.live.com",
    ]) {
      assert.strictEqual(officialMessageUrl("outlook", value), null);
    }
    for (const origin of [
      "https://outlook.live.com",
      "https://outlook.office.com",
      "https://outlook.office365.com",
    ]) {
      assert.strictEqual(
        officialMessageUrl("outlook", `${origin}/mail/id/123`),
        `${origin}/mail/id/123`,
      );
    }
    assert.strictEqual(officialMessageUrl("gmail", "https://outlook.live.com/mail/"), null);
    assert.strictEqual(officialMessageUrl("imap", "https://mail.google.com/mail/"), null);
    const gmail = gmailThreadUrl("me+tag@gmail.com", "one/two?#");
    assert.strictEqual(new URL(gmail).searchParams.get("authuser"), "me+tag@gmail.com");
    assert.strictEqual(new URL(gmail).hash, "#all/one%2Ftwo%3F%23");
  });

  it.effect("single-message raw bytes and web links stay tied to the requested provider ID", () => {
    const gmail = fakeServer("me@gmail.com", [incoming, { ...incoming, providerId: "second" }]);
    const outlook = fakeServer("me@outlook.com", [incoming]);
    const imap = fakeServer("me@example.com", [incoming]);
    const bytes = new Uint8Array([
      83, 117, 98, 106, 101, 99, 116, 58, 32, 233, 13, 10, 13, 10, 255,
    ]);
    gmail.raw.set("first", new Uint8Array([1, 2]));
    gmail.raw.set("second", bytes);
    return Effect.gen(function* () {
      const m = yield* Mailbox;
      const ga = yield* m.accounts.connect({ provider: "gmail" });
      const oa = yield* m.accounts.connect({ provider: "outlook" });
      const ia = yield* m.accounts.connect({
        provider: "imap",
        input: { preset: "icloud", email: imap.email, password: "test" },
      });
      yield* m.sync.sync();
      assert.deepStrictEqual(yield* m.reading.rawMessageBytes(`${ga.id}/second`), bytes);
      assert.strictEqual(
        yield* m.reading.messageWebUrl(`${ga.id}/first`),
        gmailThreadUrl(ga.email, "conversation"),
      );
      assert.strictEqual(
        yield* m.reading.messageWebUrl(`${ga.id}/second`),
        gmailThreadUrl(ga.email, "conversation"),
      );
      const id = `${oa.id}/first`;
      // The sync cached no webLink; provider data becomes available later.
      outlook.messages.set("first", {
        ...incoming,
        webLink: "https://outlook.live.com/mail/id/from-provider",
      });
      assert.strictEqual(
        yield* m.reading.messageWebUrl(id),
        "https://outlook.live.com/mail/id/from-provider",
      );
      assert.strictEqual(
        (yield* m.reading.thread(id))[0]?.webLink,
        "https://outlook.live.com/mail/id/from-provider",
      );
      const fetched = outlook.bodyFetched.length;
      outlook.messages.delete("first");
      assert.strictEqual(
        yield* m.reading.messageWebUrl(id),
        "https://outlook.live.com/mail/id/from-provider",
      );
      assert.strictEqual(outlook.bodyFetched.length, fetched);
      assert.strictEqual(
        (yield* m.reading.messageWebUrl(`${ia.id}/first`).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.strictEqual(
        (yield* m.reading.rawMessageBytes(`${ga.id}/missing`).pipe(Effect.result))._tag,
        "Failure",
      );
    }).pipe(Effect.provide(TestMailbox({ gmail, outlook, imap })));
  });

  it.effect("unsafe Outlook URLs fail before reaching the browser", () => {
    const outlook = fakeServer("me@outlook.com", [
      { ...incoming, webLink: "https://evil.test/mail/" },
    ]);
    return Effect.gen(function* () {
      const m = yield* Mailbox;
      const account = yield* m.accounts.connect({ provider: "outlook" });
      yield* m.sync.sync();
      assert.strictEqual(
        (yield* m.reading.messageWebUrl(`${account.id}/first`).pipe(Effect.result))._tag,
        "Failure",
      );
    }).pipe(Effect.provide(TestMailbox({ outlook })));
  });

  it.effect("a successful send remembers To, Cc and Bcc before provider sync", () => {
    const gmail = fakeServer("me@gmail.com");
    return Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const account = yield* mailbox.accounts.connect({ provider: "gmail" });
      yield* mailbox.sync.sync();
      const addresses = ["to@example.com", "cc@example.com", "bcc@example.com"];
      yield* mailbox.organize.perform(
        {
          kind: "send",
          accountId: account.id,
          message: {
            to: [{ name: "To", address: addresses[0] ?? "" }],
            cc: [{ name: "Cc", address: addresses[1] ?? "" }],
            bcc: [{ name: "Bcc", address: addresses[2] ?? "" }],
            subject: "Sent",
            text: "Hello",
            attachments: [],
          },
        },
        { kind: "user", surface: "app" },
      );
      assert.strictEqual(gmail.sent.length, 1);
      assert.deepStrictEqual(
        (yield* mailbox.reading.knownSenders(account.id, addresses)).toSorted(),
        addresses.toSorted(),
      );
    }).pipe(Effect.provide(TestMailbox({ gmail })));
  });

  it.effect(
    "migration 15 and cached links survive reopening a temp database without changing rowids or FTS",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const folder = yield* fs.makeTempDirectoryScoped({ prefix: "openmail-reading-" });
        const file = path.join(folder, "mail.db");
        yield* Effect.sync(() => {
          const db = new DatabaseSync(file);
          try {
            for (const migration of MIGRATIONS.slice(0, 13)) applyNativeMigration(db, migration);
            db.exec("PRAGMA user_version=13");
            db.exec(
              "INSERT INTO accounts(id,provider,email,created_at) VALUES ('outlook:me@outlook.com','outlook','me@outlook.com',1)",
            );
            db.exec(`INSERT INTO messages(id,account_id,provider_id,thread_id,subject,from_name,from_addr,to_json,cc_json,date,snippet,body_text,body_html,labels_json,attachments_json,is_unread,is_starred)
            VALUES ('outlook:me@outlook.com/legacy','outlook:me@outlook.com','legacy','legacy-thread','Old sent','Me','me@outlook.com','[{"name":"Legacy","address":"LEGACY@example.com"}]','[]',1,'','Old sent body','','["SENT"]','[]',0,0)`);
          } finally {
            db.close();
          }
        });
        const layer = () => StoreLive.pipe(Layer.provideMerge(databaseLayer(file)));
        let id = "";
        yield* Effect.gen(function* () {
          const store = yield* Store;
          const sql = yield* SqlClient.SqlClient;
          const account = yield* store.upsertAccount("outlook", "me@outlook.com");
          const other = yield* store.upsertAccount("gmail", "other@gmail.com");
          id = `${account.id}/first`;
          assert.deepStrictEqual(yield* store.knownSenders(account.id, ["legacy@example.com"]), [
            "legacy@example.com",
          ]);
          yield* store.deleteMessage(account.id, "legacy");
          assert.deepStrictEqual(yield* store.knownSenders(account.id, ["legacy@example.com"]), [
            "legacy@example.com",
          ]);
          yield* store.upsertMessage(account.id, incoming);
          const before = yield* sql`SELECT rowid FROM messages WHERE id=${id}`;
          yield* store.setMessageWebLink(id, "https://outlook.live.com/mail/id/cached");
          yield* store.upsertMessage(account.id, incoming);
          assert.deepStrictEqual(yield* sql`SELECT rowid FROM messages WHERE id=${id}`, before);
          assert.strictEqual((yield* store.listThreads({ search: "searchable" })).length, 1);
          yield* store.replaceServerContacts(
            account.id,
            [{ name: "Contact", address: "CONTACT@example.com" }],
            1,
          );
          yield* store.replaceServerContacts(
            other.id,
            [{ name: "Other", address: "other-contact@example.com" }],
            1,
          );
          yield* store.upsertMessage(account.id, {
            ...incoming,
            providerId: "sent",
            labels: ["SENT"],
            to: [{ name: "Recipient", address: "Recipient@example.com" }],
            cc: [{ name: "Cc", address: "CC@example.com" }],
          });
          assert.deepStrictEqual(
            (yield* store.knownSenders(account.id, [
              "cc@example.com",
              "contact@example.com",
              "me@outlook.com",
              "recipient@example.com",
              incoming.from.address,
            ])).toSorted(),
            ["cc@example.com", "contact@example.com", "me@outlook.com", "recipient@example.com"],
          );
          assert.ok(
            !(yield* store.knownSenders(account.id, [
              "cc@example.com",
              "contact@example.com",
              "me@outlook.com",
              "recipient@example.com",
              incoming.from.address,
            ])).includes(incoming.from.address),
          );
        }).pipe(Effect.provide(layer()));
        yield* Effect.gen(function* () {
          const store = yield* Store;
          assert.strictEqual(
            (yield* store.getMessage(id)).webLink,
            "https://outlook.live.com/mail/id/cached",
          );
          yield* store.upsertMessage("outlook:me@outlook.com", {
            ...incoming,
            webLink: "https://outlook.live.com/mail/id/updated",
          });
          assert.strictEqual(
            (yield* store.getMessage(id)).webLink,
            "https://outlook.live.com/mail/id/updated",
          );
          assert.deepStrictEqual(
            yield* store.knownSenders("outlook:me@outlook.com", ["legacy@example.com"]),
            ["legacy@example.com"],
          );
          yield* store.removeAccount("outlook:me@outlook.com");
          const account = yield* store.upsertAccount("outlook", "me@outlook.com");
          assert.deepStrictEqual(
            yield* store.knownSenders(account.id, [
              "legacy@example.com",
              "recipient@example.com",
              "contact@example.com",
            ]),
            [],
          );
        }).pipe(Effect.provide(layer()));
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
  );

  it.effect("loads remote images until the person picks a mode, and keeps a picked one", () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      const unset = yield* store.prefs;
      assert.strictEqual(unset.remoteImages, "always");
      assert.isFalse(unset.remoteImagesChosen);
      yield* store.setPrefs({ remoteImages: "ask" });
      const chosen = yield* store.prefs;
      assert.strictEqual(chosen.remoteImages, "ask");
      assert.isTrue(chosen.remoteImagesChosen);
      // The flag is derived from the stored mode; nothing writes a row for it.
      const forged: Partial<Prefs> = { remoteImagesChosen: false };
      yield* store.setPrefs(forged);
      assert.isTrue((yield* store.prefs).remoteImagesChosen);
      const rows = yield* sql`SELECT key FROM prefs WHERE key='remoteImagesChosen'`;
      assert.lengthOf(rows, 0);
    }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
  );

  it.effect("reads the older boolean remote image preference as a chosen mode", () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO prefs(key,value_json) VALUES ('remoteImages','false')`;
      assert.strictEqual((yield* store.prefs).remoteImages, "ask");
      assert.isTrue((yield* store.prefs).remoteImagesChosen);
      yield* sql`UPDATE prefs SET value_json='"sometimes"' WHERE key='remoteImages'`;
      // An unreadable stored mode fails closed instead of taking the loading default.
      assert.strictEqual((yield* store.prefs).remoteImages, "ask");
      yield* sql`UPDATE prefs SET value_json='true' WHERE key='remoteImages'`;
      assert.strictEqual((yield* store.prefs).remoteImages, "always");
      yield* store.setPrefs({ remoteImages: "known" });
      assert.strictEqual((yield* store.prefs).remoteImages, "known");
    }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
  );
}

{
  const message: IncomingMessage = makeIncoming("one", {
    threadId: "one",
    subject: "Train",
    from: { name: "", address: "tickets@example.com" },
    to: [],
    date: 1,
    bodyText: "Departure 2026-10-10 09:00 to 10:30",
    labels: ["INBOX"],
  });

  it.effect(
    "missing cache falls back to Gmail IDs and validated Outlook webLink without writing mail",
    () => {
      const gmail = fakeServer("me@gmail.com", [message]);
      const outlook = fakeServer("me@outlook.com", [
        { ...message, webLink: "https://outlook.live.com/mail/0/id/one" },
      ]);
      return Effect.gen(function* () {
        const m = yield* Mailbox;
        const a = yield* m.accounts.connect({ provider: "gmail" }),
          b = yield* m.accounts.connect({ provider: "outlook" });
        assert.match(yield* m.reading.messageWebUrl(`${a.id}/deadbeef`), /#all\/deadbeef$/);
        assert.strictEqual(
          yield* m.reading.messageWebUrl(`${b.id}/one`),
          "https://outlook.live.com/mail/0/id/one",
        );
        outlook.messages.set("one", { ...message, webLink: "https://evil.example/mail/one" });
        assert.strictEqual(
          (yield* m.reading.messageWebUrl(`${b.id}/one`).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.strictEqual(gmail.pushed.length + outlook.pushed.length, 0);
      }).pipe(Effect.provide(TestMailbox({ gmail, outlook })));
    },
  );
}

{
  const mail: IncomingMessage = makeIncoming("one", {
    threadId: "one",
    subject: "Travel",
    from: { name: "", address: "a@example.com" },
    to: [],
    date: 1,
    bodyText: "2026-10-10 09:00",
    labels: ["INBOX"],
    isUnread: false,
  });

  it.effect(
    "disabled Outlook accounts cannot fetch a webLink for cached or absent messages",
    () => {
      const server = fakeServer("me@outlook.com", [mail]);
      return Effect.gen(function* () {
        const m = yield* Mailbox,
          account = yield* m.accounts.connect({ provider: "outlook" });
        yield* m.sync.sync();
        server.messages.set("one", { ...mail, webLink: "https://outlook.live.com/mail/id/one" });
        server.messages.set("two", {
          ...mail,
          providerId: "two",
          webLink: "https://outlook.live.com/mail/id/two",
        });
        yield* m.accounts.setAccountSettings(account.id, {
          enabled: false,
          description: "",
          color: null,
        });
        const before = server.bodyFetched.length;
        for (const id of ["one", "two"])
          assert.strictEqual(
            (yield* m.reading.messageWebUrl(`${account.id}/${id}`).pipe(Effect.result))._tag,
            "Failure",
          );
        assert.strictEqual(server.bodyFetched.length, before);
      }).pipe(Effect.provide(TestMailbox({ outlook: server })));
    },
  );
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

  it.effect(
    "private message and conversation links survive an IMAP UID change and can recover uncached mail by Message-ID",
    () => {
      const server = fakeServer("me@example.com", [
        fixture("old", { rfcMessageId: "<stable@example.com>" }),
      ]);
      return Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const account = yield* mailbox.accounts.connect({
          provider: "imap",
          input: {
            preset: "custom",
            email: server.email,
            password: "secret",
            imapHost: "fake.invalid",
            smtpHost: "fake.invalid",
          },
        });
        yield* mailbox.sync.sync();
        const link = yield* mailbox.reading.privateMailLink(`${account.id}/old`, "message");
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
        yield* mailbox.sync.sync();
        assert.strictEqual(yield* mailbox.reading.resolveMailLink(parsed.id), `${account.id}/new`);
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
        assert.strictEqual(
          yield* mailbox.reading.resolveMailLink(target.id),
          `${account.id}/uncached`,
        );
        assert.ok(server.searched.some((q) => q.search?.includes("rfc822msgid:")));
      }).pipe(Effect.provide(TestMailbox({ imap: server })));
    },
  );
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

  it("new single-message links without Message-ID have an explicit marker, legacy links keep their meaning", () => {
    const target = { id: "gmail:me@example.com/m", accountId: "gmail:me@example.com" };
    const link = parseAppLink(privateMailLink(target, "message"));
    assert.ok(link?.kind === "message" && link.single === true);
    assert.deepStrictEqual(parseAppLink(messageLink(target.id)), {
      kind: "message",
      id: target.id,
    });
  });

  it.effect(
    "disabled accounts reject cached stable and local deep links before any provider search",
    () => {
      const server = fakeServer("me@example.com", [
        { ...message, rfcMessageId: "<m@example.com>" },
      ]);
      return Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const account = yield* mailbox.accounts.connect({ provider: "gmail" });
        yield* mailbox.sync.sync();
        const id = `${account.id}/m`;
        const link = parseAppLink(yield* mailbox.reading.privateMailLink(id, "message"));
        assert.ok(link?.kind === "message");
        yield* mailbox.accounts.setAccountSettings(account.id, {
          enabled: false,
          description: "",
          color: null,
        });
        for (const reference of [link.id, id]) {
          const result = yield* mailbox.reading.resolveMailLink(reference).pipe(Effect.result);
          assert.strictEqual(result._tag, "Failure");
        }
        assert.strictEqual(server.searched.length, 0);
      }).pipe(Effect.provide(TestMailbox({ gmail: server })));
    },
  );
}

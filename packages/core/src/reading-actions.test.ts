import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { CurrentTransformer, type Transformer } from "effect/sql/Statement";
import { DatabaseSync } from "node:sqlite";
import { databaseLayer, MIGRATIONS, splitStatements } from "./platform/node/db.js";
import type { IncomingMessage } from "./domain.js";
import { Mailbox } from "./mailbox.js";
import { Store } from "./services.js";
import { StoreLive } from "./store.js";
import { fakeServer, TestMailbox } from "./platform/node/testing.js";
import { gmailThreadUrl, officialMessageUrl, senderLabel, threadExpansion } from "./reading.js";
import { parseSearchQuery, senderSearchQuery } from "./search.js";
import { MemoryPlatform } from "./platform/node/platform-memory.js";

const incoming: IncomingMessage = {
  providerId: "first",
  threadId: "conversation",
  subject: "First",
  date: 1000,
  from: { name: "Alice", address: "alice@example.com" },
  to: [],
  cc: [],
  snippet: "",
  bodyText: "searchable",
  bodyHtml: "",
  attachments: [],
  labels: ["INBOX"],
  isUnread: false,
  isStarred: false,
};

it("expands and collapses every ID independently of thread order or duplicate IDs", () => {
  assert.deepStrictEqual([...threadExpansion(["old", "new", "old"], true)], ["old", "new"]);
  assert.strictEqual(threadExpansion(["old", "new"], false).size, 0);
  assert.strictEqual(threadExpansion([], true).size, 0);
  assert.strictEqual(senderLabel(incoming.from, false), "Alice <alice@example.com>");
  assert.strictEqual(senderLabel(incoming.from, true), "Alice");
  assert.strictEqual(senderLabel({ name: "", address: "a@example.com" }, false), "a@example.com");
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
  const bytes = new Uint8Array([83, 117, 98, 106, 101, 99, 116, 58, 32, 233, 13, 10, 13, 10, 255]);
  gmail.raw.set("first", new Uint8Array([1, 2]));
  gmail.raw.set("second", bytes);
  return Effect.gen(function* () {
    const m = yield* Mailbox;
    const ga = yield* m.connect({ provider: "gmail" });
    const oa = yield* m.connect({ provider: "outlook" });
    const ia = yield* m.connect({
      provider: "imap",
      input: { preset: "icloud", email: imap.email, password: "test" },
    });
    yield* m.sync();
    assert.deepStrictEqual(yield* m.rawMessageBytes(`${ga.id}/second`), bytes);
    assert.strictEqual(
      yield* m.messageWebUrl(`${ga.id}/first`),
      gmailThreadUrl(ga.email, "conversation"),
    );
    assert.strictEqual(
      yield* m.messageWebUrl(`${ga.id}/second`),
      gmailThreadUrl(ga.email, "conversation"),
    );
    const id = `${oa.id}/first`;
    // The sync cached no webLink; provider data becomes available later.
    outlook.messages.set("first", {
      ...incoming,
      webLink: "https://outlook.live.com/mail/id/from-provider",
    });
    assert.strictEqual(
      yield* m.messageWebUrl(id),
      "https://outlook.live.com/mail/id/from-provider",
    );
    assert.strictEqual(
      (yield* m.thread(id))[0]?.webLink,
      "https://outlook.live.com/mail/id/from-provider",
    );
    const fetched = outlook.bodyFetched.length;
    outlook.messages.delete("first");
    assert.strictEqual(
      yield* m.messageWebUrl(id),
      "https://outlook.live.com/mail/id/from-provider",
    );
    assert.strictEqual(outlook.bodyFetched.length, fetched);
    assert.strictEqual(
      (yield* m.messageWebUrl(`${ia.id}/first`).pipe(Effect.result))._tag,
      "Failure",
    );
    assert.strictEqual(
      (yield* m.rawMessageBytes(`${ga.id}/missing`).pipe(Effect.result))._tag,
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
    const account = yield* m.connect({ provider: "outlook" });
    yield* m.sync();
    assert.strictEqual(
      (yield* m.messageWebUrl(`${account.id}/first`).pipe(Effect.result))._tag,
      "Failure",
    );
  }).pipe(Effect.provide(TestMailbox({ outlook })));
});

it.effect(
  "known senders return only requested addresses with indexed lookups and account isolation",
  () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      const account = yield* store.upsertAccount("gmail", "me@gmail.com");
      const other = yield* store.upsertAccount("gmail", "other@gmail.com");
      yield* store.replaceServerContacts(
        account.id,
        [{ name: "Known", address: "contact@example.com" }],
        1,
      );
      yield* store.replaceServerContacts(
        other.id,
        [{ name: "Other", address: "other-contact@example.com" }],
        1,
      );
      yield* store.rememberMailedAddresses(account.id, [
        "recipient@example.com",
        ...Array.from({ length: 2000 }, (_, index) => `history${index}@example.com`),
      ]);
      yield* store.rememberMailedAddresses(other.id, ["other-recipient@example.com"]);
      const statements: (readonly [string, ReadonlyArray<unknown>])[] = [];
      const capture: Transformer = (statement) =>
        Effect.sync(() => {
          statements.push(statement.compile());
          return statement;
        });
      const known = yield* store
        .knownSenders(account.id, [
          " CONTACT@example.com ",
          "recipient@example.com",
          "recipient@example.com",
          "other-contact@example.com",
          "other-recipient@example.com",
          "unknown@example.com",
        ])
        .pipe(Effect.provideService(CurrentTransformer, capture));
      assert.deepStrictEqual(known.toSorted(), ["contact@example.com", "recipient@example.com"]);
      assert.deepStrictEqual(yield* store.knownSenders(account.id, []), []);
      assert.deepStrictEqual(yield* store.knownSenders(account.id, [account.email]), [
        account.email,
      ]);
      assert.strictEqual(statements.length, 1);
      const query = statements[0];
      assert.ok(query);
      const plan = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ detail: Schema.String })),
      )(yield* sql.unsafe(`EXPLAIN QUERY PLAN ${query[0]}`, query[1]));
      assert.strictEqual(plan.filter((row) => /SEARCH .*address=\?/.test(row.detail)).length, 2);
      assert.ok(
        !plan.some((row) => /SCAN (messages|server_contacts|mailed_addresses)/.test(row.detail)),
      );
    }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
);

it.effect("a successful send remembers To, Cc and Bcc before provider sync", () => {
  const gmail = fakeServer("me@gmail.com");
  return Effect.gen(function* () {
    const mailbox = yield* Mailbox;
    const account = yield* mailbox.connect({ provider: "gmail" });
    yield* mailbox.sync();
    const addresses = ["to@example.com", "cc@example.com", "bcc@example.com"];
    yield* mailbox.perform(
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
      (yield* mailbox.knownSenders(account.id, addresses)).toSorted(),
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
          for (const migration of MIGRATIONS.slice(0, 13))
            for (const statement of splitStatements(migration)) db.exec(statement);
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

it.effect("reads the older boolean remote image preference as a mode", () =>
  Effect.gen(function* () {
    const store = yield* Store;
    const sql = yield* SqlClient.SqlClient;
    assert.strictEqual((yield* store.prefs).remoteImages, "ask");
    yield* sql`INSERT INTO prefs(key,value_json) VALUES ('remoteImages','false')`;
    assert.strictEqual((yield* store.prefs).remoteImages, "ask");
    yield* sql`UPDATE prefs SET value_json='true' WHERE key='remoteImages'`;
    assert.strictEqual((yield* store.prefs).remoteImages, "always");
    yield* store.setPrefs({ remoteImages: "known" });
    assert.strictEqual((yield* store.prefs).remoteImages, "known");
  }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
);

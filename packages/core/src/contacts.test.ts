import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { DatabaseSync } from "node:sqlite";
import { databaseLayer, MIGRATIONS } from "./db.js";
import { mergeContacts } from "./contacts.js";
import { Store } from "./services.js";
import { MemoryPlatform } from "./platform-memory.js";
import { StoreLive } from "./store.js";

it("normalizes contacts, retains saved names, rejects non-addresses", () => {
  assert.deepStrictEqual(
    mergeContacts([
      { name: "", address: " Person@Example.com " },
      { name: "Saved", address: "person@example.com" },
      { name: "Ignored", address: "person@example.com" },
      { name: "Bad", address: "bad\n@example.com" },
      { name: "Bad", address: "invalid" },
    ]),
    [{ name: "Saved", address: "person@example.com" }],
  );
});

it.effect(
  "migration 9 preserves existing mail/FTS rowids and hidden contacts; snapshots survive reopening a temporary database",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "openmail-contacts-" });
      const file = path.join(dir, "mail.db");
      const id = "gmail:me@example.com";
      yield* Effect.sync(() => {
        const db = new DatabaseSync(file);
        for (const migration of MIGRATIONS.slice(0, 7)) db.exec(migration);
        db.exec("PRAGMA user_version=7");
        db.exec(
          "INSERT INTO accounts(id,provider,email,created_at) VALUES ('gmail:me@example.com','gmail','me@example.com',1)",
        );
        db.exec("INSERT INTO hidden_contacts VALUES ('hidden@example.com')");
        db.exec(`INSERT INTO messages(rowid,id,account_id,provider_id,thread_id,subject,from_name,from_addr,to_json,cc_json,date,snippet,body_text,body_html,labels_json,attachments_json,is_unread,is_starred)
      VALUES (37,'gmail:me@example.com/m1','gmail:me@example.com','m1','t1','migration','Alice','alice@example.com','[]','[]',1,'','persisted searchable text','','["INBOX"]','[]',0,0)`);
        db.exec(`INSERT INTO messages SELECT 'gmail:me@example.com/m2', account_id, 'm2', 't2', subject, from_name, from_addr, to_json, cc_json, date, snippet, body_text, body_html, labels_json,
          '[{"filename":"Invite.ICS","mimeType":"application/octet-stream","size":20}]', is_unread, is_starred FROM messages WHERE provider_id='m1'`);
        db.exec(`INSERT INTO messages SELECT 'gmail:me@example.com/m3', account_id, 'm3', 't3', subject, from_name, from_addr, to_json, cc_json, date, snippet, body_text, body_html, labels_json,
          '[{"filename":"part","mimeType":"text/calendar; charset=utf-8","size":20}]', is_unread, is_starred FROM messages WHERE provider_id='m1'`);
        db.close();
      });
      const layer = () => StoreLive.pipe(Layer.provideMerge(databaseLayer(file)));
      yield* Effect.gen(function* () {
        const store = yield* Store;
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql`SELECT rowid FROM messages`;
        assert.deepStrictEqual(
          yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ rowid: Schema.Int })))(
            rows,
          ),
          [{ rowid: 37 }, { rowid: 38 }, { rowid: 39 }],
        );
        assert.strictEqual((yield* store.listThreads({ search: "searchable" })).length, 3);
        assert.deepStrictEqual(yield* store.hiddenContacts, ["hidden@example.com"]);
        yield* store.replaceServerContacts(
          id,
          [
            { name: "Saved Alice", address: "ALICE@example.com" },
            { name: "Hidden", address: "hidden@example.com" },
            { name: "Remote", address: "remote@example.com" },
          ],
          1000,
        );
        assert.deepStrictEqual(yield* store.suggestContacts("alice", 10), [
          { address: "alice@example.com", name: "Saved Alice" },
        ]);
        assert.deepStrictEqual(yield* store.suggestContacts("hidden", 10), []);
        yield* store.setContactSyncError(id, 2000, "offline", false);
        const [status] = yield* store.contactSync;
        assert.strictEqual(status?.refreshedAt, 1000);
        assert.strictEqual(status?.attemptedAt, 2000);
        assert.strictEqual(status?.count, 3);
        assert.strictEqual((yield* store.getMessage(`${id}/m1`)).hasCalendar, false);
        assert.strictEqual((yield* store.getMessage(`${id}/m2`)).hasCalendar, true);
        assert.strictEqual((yield* store.getMessage(`${id}/m3`)).hasCalendar, true);
      }).pipe(Effect.provide(layer()));
      yield* Effect.gen(function* () {
        const store = yield* Store;
        assert.strictEqual((yield* store.suggestContacts("remote", 10)).length, 1);
        assert.strictEqual((yield* store.contactSync)[0]?.error, "offline");
        yield* store.replaceServerContacts(id, [], 3000);
        assert.deepStrictEqual(yield* store.suggestContacts("remote", 10), []);
        assert.strictEqual((yield* store.suggestContacts("alice", 10))[0]?.name, "Alice");
        assert.strictEqual((yield* store.contactSync)[0]?.error, null);
        yield* store.removeAccount(id);
        assert.deepStrictEqual(yield* store.contactSync, []);
      }).pipe(Effect.provide(layer()));
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
);

const contactStore = StoreLive.pipe(Layer.provide(MemoryPlatform()));

it.effect(
  "server contacts fill gaps and do not gain rank from being cached on multiple accounts",
  () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const first = yield* store.upsertAccount("gmail", "one@example.com");
      const second = yield* store.upsertAccount("outlook", "two@example.com");
      yield* store.upsertMessage(first.id, {
        providerId: "m1",
        threadId: "t1",
        subject: "Hi",
        from: { name: "Recent", address: "recent@example.com" },
        to: [],
        cc: [],
        date: 0,
        snippet: "",
        bodyText: "",
        bodyHtml: "",
        labels: ["INBOX"],
        attachments: [],
        isUnread: false,
        isStarred: false,
      });
      const remote = { name: "Remote", address: "remote@example.com" };
      yield* store.replaceServerContacts(first.id, [remote], 0);
      assert.strictEqual((yield* store.suggestContacts("", 10))[0]?.address, "recent@example.com");
      const before = yield* store.suggestContacts("", 10);
      yield* store.replaceServerContacts(second.id, [remote], 0);
      for (let i = 0; i < 5; i++) {
        const duplicate = yield* store.upsertAccount("outlook", `duplicate-${i}@example.com`);
        yield* store.replaceServerContacts(duplicate.id, [remote], 0);
      }
      assert.deepStrictEqual(yield* store.suggestContacts("", 10), before);
    }).pipe(Effect.provide(contactStore)),
);

it.effect(
  "scoped contact suggestions restrict history, saved names and limits to Profile accounts",
  () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const first = yield* store.upsertAccount("gmail", "one@example.com");
      const second = yield* store.upsertAccount("outlook", "two@example.com");
      yield* store.replaceServerContacts(
        first.id,
        [
          { name: "First Alice", address: "alice@example.com" },
          { name: "First Bob", address: "bob@example.com" },
        ],
        0,
      );
      yield* store.replaceServerContacts(
        second.id,
        [
          { name: "Other Alice", address: "alice@example.com" },
          { name: "Other Remote", address: "outside@example.com" },
        ],
        0,
      );
      yield* store.upsertMessage(second.id, {
        providerId: "heard",
        threadId: "heard",
        subject: "",
        from: { name: "Other History", address: "history@example.com" },
        to: [{ name: "Recipient", address: "recipient@example.com" }],
        cc: [{ name: "Copy", address: "copy@example.com" }],
        date: 0,
        snippet: "",
        bodyText: "",
        bodyHtml: "",
        labels: ["SENT"],
        attachments: [],
        isUnread: false,
        isStarred: false,
      });
      assert.deepStrictEqual(yield* store.suggestContacts("Alice", 8, undefined, [first.id]), [
        { name: "First Alice", address: "alice@example.com" },
      ]);
      assert.deepStrictEqual(yield* store.suggestContacts("Other", 8, undefined, [first.id]), []);
      assert.deepStrictEqual(
        yield* store.suggestContacts("recipient", 8, undefined, [first.id]),
        [],
      );
      assert.deepStrictEqual(yield* store.suggestContacts("copy", 8, undefined, [first.id]), []);
      assert.deepStrictEqual(yield* store.suggestContacts("Other", 8, undefined, [second.id]), [
        { name: "Other Alice", address: "alice@example.com" },
        { name: "Other Remote", address: "outside@example.com" },
      ]);
      assert.strictEqual(
        (yield* store.suggestContacts("example.com", 1, undefined, [first.id])).length,
        1,
      );
      assert.deepStrictEqual(yield* store.suggestContacts("Alice", 8, undefined, []), []);
      yield* store.setAccountSettings(first.id, {
        enabled: false,
        description: "First",
        color: null,
      });
      assert.deepStrictEqual(yield* store.suggestContacts("Alice", 8, undefined, [first.id]), []);
      assert.deepStrictEqual(
        yield* store.suggestContacts("Alice", 8, undefined, [first.id, second.id]),
        [{ name: "Other Alice", address: "alice@example.com" }],
      );
      assert.deepStrictEqual(yield* store.suggestContacts("Alice", 8), [
        { name: "Other Alice", address: "alice@example.com" },
      ]);
      yield* store.setAccountSettings(second.id, {
        enabled: false,
        description: "Second",
        color: null,
      });
      for (const query of ["Alice", "recipient", "copy"]) {
        assert.deepStrictEqual(
          yield* store.suggestContacts(query, 8, undefined, [first.id, second.id]),
          [],
        );
      }
    }).pipe(Effect.provide(contactStore)),
);

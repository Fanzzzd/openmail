import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { databaseLayer, MIGRATIONS } from "./db.js";
import { StoreLive } from "./store.js";
import { NodeSystem } from "./platform-node.js";
import { Store } from "./services.js";

it.effect(
  "150k-message migration backfills sent history; suggestions use the recipient index and track upserts/deletion",
  () =>
    Effect.gen(function* () {
      const dir = yield* Effect.acquireRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), "openmail-sent-recipients-"))),
        (folder) => Effect.sync(() => rmSync(folder, { recursive: true, force: true })),
      );
      const file = join(dir, "mail.db");
      yield* Effect.sync(() => {
        const db = new DatabaseSync(file);
        for (const migration of MIGRATIONS.slice(0, 21)) db.exec(migration);
        db.exec("PRAGMA user_version=21");
        db.exec(
          "INSERT INTO accounts(id,provider,email,created_at) VALUES ('gmail:me@example.com','gmail','me@example.com',0)",
        );
        db.exec(`WITH RECURSIVE fixture(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM fixture WHERE n<150000)
      INSERT INTO messages(id,account_id,provider_id,thread_id,subject,from_name,from_addr,to_json,cc_json,date,snippet,body_text,body_html,labels_json,attachments_json,is_unread,is_starred)
      SELECT 'gmail:me@example.com/'||n,'gmail:me@example.com',CAST(n AS TEXT),CAST(n AS TEXT),'','','alias@example.org','[{"name":"Alice","address":"ALICE@example.com"}]','[]',n,'','','',CASE WHEN n=1 THEN '["SENT"]' ELSE '["INBOX"]' END,'[]',0,0 FROM fixture`);
        db.exec("UPDATE messages SET to_json='invalid legacy JSON' WHERE provider_id='2'");
        db.close();
      });
      yield* Effect.gen(function* () {
        const store = yield* Store;
        const spy = yield* Effect.acquireRelease(
          Effect.sync(() => vi.spyOn(DatabaseSync.prototype, "prepare")),
          (spy) => Effect.sync(() => spy.mockRestore()),
        );
        const rows = yield* store.senderHistory(["alice@example.com"]);
        assert.deepStrictEqual(rows, [
          {
            accountId: "gmail:me@example.com",
            address: "alias@example.org",
            recipient: "alice@example.com",
            count: 1,
            lastSent: 1,
          },
        ]);
        const query = spy.mock.calls.find(([sql]) => sql.includes("AS last_sent"))?.[0];
        assert.ok(query);
        const plan = yield* Effect.sync(() => {
          const db = new DatabaseSync(file);
          try {
            return Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ detail: Schema.String })))(
              db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(JSON.stringify(["alice@example.com"])),
            );
          } finally {
            db.close();
          }
        });
        assert.ok(
          plan.some((row) => row.detail.includes("sent_recipients_address")),
          JSON.stringify(plan),
        );
        spy.mockClear();
        assert.deepStrictEqual(yield* store.senderHistory([]), []);
        assert.strictEqual(spy.mock.calls.length, 0);
        const updated = {
          providerId: "1",
          threadId: "1",
          subject: "",
          from: { name: "", address: "other@example.org" },
          to: [{ name: "Bob", address: "bob@example.com" }],
          cc: [{ name: "Alice", address: "alice@example.com" }],
          date: 2,
          snippet: "",
          bodyText: "",
          bodyHtml: "",
          labels: ["SENT"],
          attachments: [],
          isUnread: false,
          isStarred: false,
        };
        yield* store.upsertMessage("gmail:me@example.com", updated);
        assert.deepStrictEqual(yield* store.senderHistory(["ALICE@example.com"]), [
          {
            accountId: "gmail:me@example.com",
            address: "other@example.org",
            recipient: "alice@example.com",
            count: 1,
            lastSent: 2,
          },
        ]);
        const corrupt = yield* Effect.sync(() => {
          const db = new DatabaseSync(file);
          try {
            db.exec(
              "UPDATE messages SET to_json='invalid legacy JSON',cc_json='[42,\"broken\"]' WHERE provider_id='1'",
            );
            return true;
          } finally {
            db.close();
          }
        });
        assert.ok(corrupt);
        assert.strictEqual(yield* store.hasMessage("gmail:me@example.com/1"), true);
        assert.deepStrictEqual(
          yield* store.senderHistory(["alice@example.com", "bob@example.com"]),
          [],
        );
        yield* store.upsertMessage("gmail:me@example.com", updated);
        assert.strictEqual((yield* store.senderHistory(["alice@example.com"])).length, 1);
        yield* store.upsertMessage("gmail:me@example.com", { ...updated, labels: ["INBOX"] });
        assert.deepStrictEqual(yield* store.senderHistory(["alice@example.com"]), []);
        yield* store.upsertMessage("gmail:me@example.com", updated);
        assert.strictEqual((yield* store.senderHistory(["alice@example.com"])).length, 1);
        yield* store.deleteMessage("gmail:me@example.com", "1");
        assert.deepStrictEqual(yield* store.senderHistory(["alice@example.com"]), []);
      }).pipe(
        Effect.provide(
          StoreLive.pipe(Layer.provide(databaseLayer(file).pipe(Layer.provide(NodeSystem)))),
        ),
      );
    }),
  { timeout: 120_000 },
);

import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { DatabaseSync } from "node:sqlite";
import { databaseLayer, MIGRATIONS, splitStatements } from "./db.js";
import { Store } from "./services.js";
import { StoreLive } from "./store.js";

it.effect(
  "migration 26 defaults existing accounts off, preserves FTS rowids and persists derived provenance",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "openmail-ai-" });
      const file = path.join(dir, "mail.db");
      const accountId = "gmail:old@example.com";
      yield* Effect.sync(() => {
        const db = new DatabaseSync(file);
        for (const migration of MIGRATIONS.slice(0, 24))
          for (const statement of splitStatements(migration)) db.exec(statement);
        db.exec("PRAGMA user_version=24");
        db.exec(
          "INSERT INTO accounts(id,provider,email,created_at) VALUES('gmail:old@example.com','gmail','old@example.com',1)",
        );
        db.exec(`INSERT INTO messages(rowid,id,account_id,provider_id,thread_id,subject,from_name,from_addr,to_json,cc_json,date,snippet,body_text,body_html,labels_json,attachments_json,is_unread,is_starred)
      VALUES(37,'gmail:old@example.com/m1','gmail:old@example.com','m1','t1','Friday','A','a@example.com','[]','[]',1,'','searchable old mail','','["INBOX"]','[]',0,0)`);
        db.close();
      });
      const layer = () => StoreLive.pipe(Layer.provideMerge(databaseLayer(file)));
      yield* Effect.gen(function* () {
        const store = yield* Store;
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(yield* store.ai.accounts, [
          { accountId, allowed: false, autoSummaries: false },
        ]);
        assert.deepStrictEqual(
          Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ rowid: Schema.Number })))(
            yield* sql`SELECT rowid FROM messages`,
          ),
          [{ rowid: 37 }],
        );
        assert.strictEqual((yield* store.listThreads({ search: "searchable" })).length, 1);
        yield* store.ai.setAccount({ accountId, allowed: true, autoSummaries: true });
        yield* store.ai.setModel("claude-opus-5-5");
        yield* store.ai.putSummary(accountId, {
          threadId: `${accountId}/t1`,
          model: "claude-sonnet-5-5",
          promptVersion: "mail-text-v1",
          inputHash: "hash",
          text: "Friday",
        });
      }).pipe(Effect.provide(layer()));
      yield* Effect.gen(function* () {
        const store = yield* Store;
        const sql = yield* SqlClient.SqlClient;
        assert.strictEqual((yield* store.ai.accounts)[0]?.allowed, true);
        assert.strictEqual(yield* store.ai.model, "claude-opus-5-5");
        const row = yield* store.ai.summary(`${accountId}/t1`);
        assert.ok(
          Option.isSome(row) &&
            row.value.inputHash === "hash" &&
            row.value.model === "claude-sonnet-5-5",
        );
        yield* sql`UPDATE messages SET body_text='Changed input' WHERE rowid=37`;
        assert.ok(Option.isNone(yield* store.ai.summary(`${accountId}/t1`)));
        yield* store.removeAccount(accountId);
        assert.deepStrictEqual(yield* store.ai.accounts, []);
      }).pipe(Effect.provide(layer()));
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
);

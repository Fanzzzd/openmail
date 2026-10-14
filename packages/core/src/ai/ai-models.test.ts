import { applyNativeMigration } from "../platform/node/migrations.js";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databaseLayer, MIGRATIONS } from "../platform/node/db.js";
import { NodeSystem } from "../platform/node/platform-node.js";
import { Store } from "../store/service.js";
import { StoreLive } from "../store/store.js";
import { AI_MODELS, aiModelName } from "./ai.js";

it("the model picker offers the current models by their product names", () => {
  assert.deepStrictEqual(AI_MODELS, ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"]);
  assert.deepStrictEqual(AI_MODELS.map(aiModelName), [
    "Claude Sonnet 5.5",
    "Claude Opus 5.5",
    "Claude Haiku 5.5",
  ]);
  assert.strictEqual(aiModelName("claude-haiku-4-5-20251001"), "claude-haiku-4-5-20251001");
});

it.effect("migration 52 moves a saved Haiku 4.5 choice to Haiku 5.5 and drops its results", () =>
  Effect.gen(function* () {
    const directory = mkdtempSync(join(tmpdir(), "openmail-haiku-"));
    try {
      const filename = join(directory, "mail.sqlite");
      const db = new DatabaseSync(filename);
      for (const migration of MIGRATIONS.slice(0, 51)) applyNativeMigration(db, migration);
      db.exec("PRAGMA user_version=51");
      db.prepare("INSERT INTO accounts(id,provider,email,created_at) VALUES(?,?,?,?)").run(
        "gmail:me@example.com",
        "gmail",
        "me@example.com",
        0,
      );
      db.prepare("INSERT INTO ai_config(id,model) VALUES(1,?)").run("claude-haiku-4-5-20251001");
      const derived = db.prepare(
        "INSERT INTO derived(account_id,thread_id,kind,model,prompt_version,input_hash,text) VALUES(?,?,?,?,?,?,?)",
      );
      derived.run(
        "gmail:me@example.com",
        "t1",
        "summary",
        "claude-haiku-4-5-20251001",
        "v",
        "h",
        "Old",
      );
      derived.run("gmail:me@example.com", "t2", "summary", "claude-sonnet-5-5", "v", "h", "Kept");
      db.close();
      yield* Effect.gen(function* () {
        const store = yield* Store;
        assert.strictEqual(yield* store.ai.model, "claude-haiku-5-5");
        assert.isTrue(Option.isNone(yield* store.ai.summary("t1")));
        assert.strictEqual(Option.getOrNull(yield* store.ai.summary("t2"))?.text, "Kept");
      }).pipe(
        Effect.provide(
          StoreLive.pipe(
            Layer.provide(
              databaseLayer(filename, { vectorExtension: null }).pipe(Layer.provide(NodeSystem)),
            ),
          ),
        ),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }),
);

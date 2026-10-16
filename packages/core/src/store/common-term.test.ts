import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { MemoryPlatform } from "../platform/node/platform-memory.js";
import { Store } from "./service.js";
import { StoreLive } from "./store.js";
import { COMMON_TERM_ROWS, makeQueryStore } from "./store-query.js";

// planTextPage probed each text index with its own COUNT ... LIMIT 2049 and `> 2048`. One
// threshold now covers the word, full-text and bigram indexes alike.
it.effect(
  "a term in more than COMMON_TERM_ROWS messages walks the date index in every text index",
  () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      const account = yield* store.upsertAccount("gmail", "me@example.com");
      yield* store.transaction(
        Effect.forEach(
          Array.from({ length: COMMON_TERM_ROWS + 1 }, (_, i) => i),
          (i) =>
            store.upsertMessage(account.id, {
              providerId: `p${i}`,
              threadId: `t${i}`,
              subject: `Note ${i}`,
              from: { name: "Sender", address: "s@example.com" },
              to: [{ name: "", address: "me@example.com" }],
              cc: [],
              date: Date.UTC(2026, 0, 1) + i * 60_000,
              snippet: "",
              // One message fewer has the `at` terms than the `over` terms.
              bodyText: i < COMMON_TERM_ROWS ? "atword 冰川 overword 雪山" : "overword 雪山",
              bodyHtml: "",
              labels: ["INBOX"],
              attachments: [],
              isUnread: false,
              isStarred: false,
            }),
          { discard: true },
        ),
      );
      while (!(yield* store.backfillWordIndex(5000)).ready) {
        /* drain */
      }
      while (!(yield* store.indexBigrams()).ready) {
        /* drain */
      }
      const { planTextPage } = makeQueryStore({ sql });
      const index = (search: string, wordIndexReady: boolean) =>
        planTextPage({ search, limit: 50, wordIndexReady }).pipe(
          Effect.map((q) => q.textPage?.index),
        );
      assert.isUndefined(yield* index("atword", true));
      assert.strictEqual(yield* index("overword", true), "messages_words");
      assert.isUndefined(yield* index("atword overword", true));
      assert.strictEqual(yield* index("overword overword", true), "messages_words");
      assert.isUndefined(yield* index("atword", false));
      assert.strictEqual(yield* index("overword", false), "messages_fts");
      assert.isUndefined(yield* index("冰川", false));
      assert.strictEqual(yield* index("雪山", false), "messages_bigrams");
    }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
);

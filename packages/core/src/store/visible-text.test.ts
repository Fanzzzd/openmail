import { traceQueries } from "../platform/node/fixtures/performance-mailbox.js";
import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Layer } from "effect";
import { SqlClient } from "effect/sql";
import type { IncomingMessage } from "../domain/message.js";
import { HtmlText } from "../platform/html-text.js";
import { MemoryPlatform } from "../platform/node/platform-memory.js";
import { searchVisibleText } from "../visible-text/visible-text.js";
import { Store } from "./service.js";
import { StoreLive } from "./store.js";
import { SEARCH_VISIBLE_ROWS } from "./store-search-matches.js";

const message = (id: string, bodyHtml: string, date: number): IncomingMessage => ({
  providerId: id,
  threadId: id,
  subject: "Harbor notes",
  from: { name: "Alice", address: "a@example.com" },
  to: [],
  cc: [],
  date,
  snippet: "provider preview",
  bodyText: "harbor visible secret",
  bodyHtml,
  labels: ["INBOX"],
  isUnread: false,
  isStarred: false,
  attachments: [],
});
const HIDDEN = "<p>harbor visible</p><span hidden>secret</span>";

/** The inline extraction, counted: a search that reads stored text computes nothing. */
const counted = () => {
  const calls: { urgent: boolean }[] = [];
  const service: HtmlText = {
    htmlToText: (html) => Effect.succeed(html),
    visibleText: (plain, html, options) =>
      Effect.sync(() => {
        calls.push({ urgent: options?.urgent ?? false });
        return searchVisibleText(plain, html);
      }),
    concurrency: 1,
  };
  return { calls, layer: Layer.succeed(HtmlText, service) };
};

const stored = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return new Map(
    (yield* sql<{
      row_id: number;
      text: string;
    }>`SELECT row_id,text FROM message_visible_text`).map((row) => [row.row_id, row.text]),
  );
});
const rowid = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ rowid: number }>`SELECT rowid FROM messages WHERE provider_id=${id}`;
    return row?.rowid ?? -1;
  });
const indexed = (store: Store["Service"]) =>
  Effect.gen(function* () {
    while (!(yield* store.backfillWordIndex(500)).ready) {
      /* finish the word index */
    }
  });

const { calls, layer } = counted();
const provide = <A, E>(effect: Effect.Effect<A, E, Store | SqlClient.SqlClient>) =>
  effect.pipe(
    Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform()), Layer.provide(layer))),
  );

// Search computed the visible text of every result's HTML on the main thread: 2.8-5.2 s for the
// first search of a common word on a 20k-message database. It is now stored once per body.
it.effect("new and changed HTML bodies are queued, filled once and read by search", () =>
  provide(
    Effect.gen(function* () {
      calls.length = 0;
      const store = yield* Store;
      const account = yield* store.upsertAccount("gmail", "visible@example.com");
      yield* store.upsertMessage(account.id, message("html", HIDDEN, 2000));
      yield* store.upsertMessage(account.id, { ...message("plain", "", 1000) });
      yield* indexed(store);
      // Only the HTML body waits; a plain-text body is its own visible text.
      assert.strictEqual(yield* store.visibleTextPending, 1);
      const trace = traceQueries();
      assert.deepStrictEqual(yield* store.fillVisibleText(), { processed: 1, ready: true });
      assert.strictEqual(yield* store.visibleTextPending, 0);
      trace.start();
      yield* store.fillVisibleText();
      const emptyQueue = trace.stop();
      trace.restore();
      assert.strictEqual(emptyQueue.length, 1);
      assert.include(emptyQueue[0]?.sql ?? "", "CROSS JOIN messages");
      assert.include(emptyQueue[0]?.plan.join("\n") ?? "", "SCAN p");
      assert.notMatch(emptyQueue[0]?.plan.join("\n") ?? "", /SCAN m /);
      const html = yield* rowid("html");
      assert.strictEqual((yield* stored).get(html), "harbor visible");
      calls.length = 0;
      const rows = yield* store.listThreads({ search: "harbor", flat: true, limit: 200 });
      assert.deepStrictEqual(calls, [], "stored text needs no extraction");
      const snippets = new Map(rows.map((row) => [row.id.split("/").at(-1), row.snippet]));
      assert.strictEqual(snippets.get("html"), "harbor visible");
      assert.strictEqual(snippets.get("plain"), "harbor visible secret");
      // A search for the hidden word finds the message but never shows the word.
      const hidden = yield* store.listThreads({ search: "secret", flat: true });
      assert.notInclude(JSON.stringify(hidden.filter((row) => row.id.endsWith("/html"))), "secret");

      // Changing the body drops the stored text and queues it again; a label change does not.
      yield* store.upsertMessage(account.id, {
        ...message("html", HIDDEN, 2000),
        labels: ["INBOX", "STARRED"],
      });
      assert.strictEqual(yield* store.visibleTextPending, 0);
      yield* store.upsertMessage(account.id, {
        ...message("html", "<p>harbor changed</p>", 2000),
        bodyText: "harbor changed",
      });
      assert.isFalse((yield* stored).has(html));
      assert.strictEqual(yield* store.visibleTextPending, 1);
      yield* store.fillVisibleText();
      assert.strictEqual((yield* stored).get(html), "harbor changed");

      // A body evicted to empty leaves no queued or stored row.
      yield* store.upsertMessage(account.id, { ...message("html", "", 2000), bodyText: "" });
      assert.isFalse((yield* stored).has(html));
      assert.strictEqual(yield* store.visibleTextPending, 0);
    }),
  ),
);

it.effect("text computed from a body that changed meanwhile is not stored", () =>
  provide(
    Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      const account = yield* store.upsertAccount("gmail", "race@example.com");
      yield* store.upsertMessage(account.id, message("race", "<p>first harbor</p>", 1000));
      const id = yield* rowid("race");
      // The body changes after the fill read it: its queued version moves on.
      const [{ version } = { version: "" }] = yield* sql<{
        version: string;
      }>`SELECT version FROM message_visible_text_pending WHERE row_id=${id}`;
      yield* store.upsertMessage(account.id, {
        ...message("race", "<p>second harbor</p>", 1000),
        bodyText: "second harbor",
      });
      yield* sql`INSERT OR REPLACE INTO message_visible_text(row_id,text)
        SELECT row_id,'first harbor' FROM message_visible_text_pending WHERE row_id=${id} AND version=${version}`;
      assert.isFalse((yield* stored).has(id), "the stale version matches no queued row");
      yield* store.fillVisibleText();
      assert.strictEqual((yield* stored).get(id), "second harbor");
      // Deleting the message removes its rows.
      yield* store.upsertMessage(account.id, message("gone", "<p>harbor</p>", 3000));
      const gone = yield* rowid("gone");
      yield* sql`DELETE FROM messages WHERE rowid=${gone}`;
      const [left] = yield* sql<{
        n: number;
      }>`SELECT (SELECT COUNT(*) FROM message_visible_text WHERE row_id=${gone})+(SELECT COUNT(*) FROM message_visible_text_pending WHERE row_id=${gone}) AS n`;
      assert.strictEqual(left?.n, 0);
    }),
  ),
);

for (const change of ["update", "delete"] as const) {
  it.effect(`a delayed fill does not restore text after a concurrent ${change}`, () => {
    const latch = () => {
      let resolve = (): void => undefined;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve: () => resolve() };
    };
    const started = latch();
    const resume = latch();
    const delayed: HtmlText = {
      htmlToText: (html) => Effect.succeed(html),
      visibleText: (plain, html) =>
        Effect.gen(function* () {
          started.resolve();
          yield* Effect.promise(() => resume.promise);
          return searchVisibleText(plain, html);
        }),
      concurrency: 1,
    };
    return Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      const account = yield* store.upsertAccount("gmail", "delayed@example.com");
      yield* store.upsertMessage(account.id, message("race", "<p>old harbor</p>", 1000));
      const id = yield* rowid("race");
      const filling = yield* store.fillVisibleText().pipe(Effect.forkChild);
      yield* Effect.promise(() => started.promise);
      yield* change === "update"
        ? store.upsertMessage(account.id, {
            ...message("race", "<p>new harbor</p>", 1000),
            bodyText: "new harbor",
          })
        : sql`DELETE FROM messages WHERE rowid=${id}`;
      resume.resolve();
      const result = yield* Fiber.join(filling);
      assert.strictEqual(result.ready, change === "delete");
      assert.isFalse((yield* stored).has(id));
      assert.strictEqual(yield* store.visibleTextPending, change === "update" ? 1 : 0);
      if (change === "update") {
        yield* store.fillVisibleText();
        assert.strictEqual((yield* stored).get(id), "new harbor");
      }
    }).pipe(
      Effect.provide(
        StoreLive.pipe(
          Layer.provideMerge(MemoryPlatform()),
          Layer.provide(Layer.succeed(HtmlText, delayed)),
        ),
      ),
    );
  });
}

it.effect("unstored results are computed for the first rows only, as urgent jobs", () =>
  provide(
    Effect.gen(function* () {
      calls.length = 0;
      const store = yield* Store;
      const account = yield* store.upsertAccount("gmail", "fallback@example.com");
      const total = SEARCH_VISIBLE_ROWS + 10;
      for (let i = 0; i < total; i++)
        yield* store.upsertMessage(account.id, message(`m${i}`, HIDDEN, 10_000 + i));
      yield* indexed(store);
      const rows = yield* store.listThreads({ search: "harbor", flat: true, limit: 200 });
      assert.strictEqual(rows.length, total);
      assert.strictEqual(calls.length, SEARCH_VISIBLE_ROWS);
      assert.isTrue(calls.every((call) => call.urgent));
      // The first rows show their visible text; later ones show no body text at all until filled.
      assert.isTrue(
        rows.slice(0, SEARCH_VISIBLE_ROWS).every((row) => row.snippet === "harbor visible"),
      );
      assert.isTrue(rows.slice(SEARCH_VISIBLE_ROWS).every((row) => row.snippet === ""));
      assert.notInclude(JSON.stringify(rows), "secret");
      // The same search again reuses what it computed.
      calls.length = 0;
      yield* store.listThreads({ search: "harbor", flat: true, limit: 200 });
      assert.strictEqual(calls.length, 0);
      while (!(yield* store.fillVisibleText()).ready) {
        /* fill the queue */
      }
      const filled = yield* store.listThreads({ search: "harbor", flat: true, limit: 200 });
      assert.isTrue(filled.every((row) => row.snippet === "harbor visible"));
    }),
  ),
);

import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import type { IncomingMessage } from "../domain/message.js";
import { MemoryPlatform } from "../platform/node/platform-memory.js";
import { traceQueries } from "../platform/node/fixtures/performance-mailbox.js";
import { Store } from "./service.js";
import { StoreLive } from "./store.js";

const message = (id: string, subject: string, bodyText: string, date: number): IncomingMessage => ({
  providerId: id,
  threadId: id,
  subject,
  from: { name: "Alice", address: "a@example.com" },
  to: [],
  cc: [],
  date,
  snippet: "",
  bodyText,
  bodyHtml: "",
  labels: ["INBOX"],
  isUnread: false,
  isStarred: false,
  attachments: [{ filename: "scan.png", mimeType: "image/png", size: 10 }],
});

const bm25Queries = (sql: readonly string[]) =>
  sql.filter((query) => query.includes("bm25(messages_"));

// A search page ran BM25 over its messages' text on every search. A prefix most mail contains
// expands to every word it starts, so the ranking took 47 ms of a 157 ms search on 100k
// messages, while only a page with attachment matches orders mail by it.
it.effect("mail is ordered by BM25 only when attachment text matches too", () => {
  const trace = traceQueries();
  return Effect.gen(function* () {
    const store = yield* Store;
    const account = yield* store.upsertAccount("gmail", "relevance@example.com");
    // The older message has the word in its subject, which BM25 weighs four times the body.
    yield* store.upsertMessage(account.id, message("subject", "harbor", "nothing else", 1000));
    yield* store.upsertMessage(account.id, message("body", "Note", "harbor", 2000));
    yield* store.upsertMessage(account.id, message("scan", "Scan", "nothing", 3000));
    while (!(yield* store.backfillWordIndex(500)).ready) {
      /* finish the index */
    }
    trace.start();
    const plain = yield* store.listThreads({ search: "harbor", flat: true });
    assert.deepStrictEqual(bm25Queries(trace.stop().map((query) => query.sql)), []);
    assert.deepStrictEqual(
      plain.map((row) => row.id.split("/").at(-1)),
      ["body", "subject"],
      "without attachment matches the page stays newest first",
    );
    for (;;) {
      const job = yield* store.media.claim("test", 0, true);
      if (Option.isNone(job)) break;
      yield* store.media.complete(
        job.value,
        job.value.message_id.endsWith("/scan")
          ? [
              {
                messageId: job.value.message_id,
                text: "harbor",
                source: { kind: "attachment", index: 0, name: "scan.png", mimeType: "image/png" },
                page: 1,
                region: null,
                pipelineVersion: "test",
                visionRevision: null,
              },
            ]
          : [],
        null,
      );
    }
    while (!(yield* store.backfillWordIndex(500)).ready) {
      /* index the attachment text */
    }
    trace.start();
    const mixed = yield* store.listThreads({ search: "harbor", flat: true });
    assert.lengthOf(bm25Queries(trace.stop().map((query) => query.sql)), 1);
    const ids = mixed.map((row) => row.id.split("/").at(-1));
    assert.include(ids, "scan");
    assert.isBelow(ids.indexOf("subject"), ids.indexOf("body"), "the subject match ranks first");
  }).pipe(
    Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform()))),
    Effect.ensuring(Effect.sync(trace.restore)),
  );
});

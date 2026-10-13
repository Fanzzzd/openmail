import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { expect, it } from "vitest";
import { databaseLayer } from "./platform/node/db.js";
import { NodeSystem } from "./platform/node/platform-node.js";
import { incoming } from "./platform/node/testing.js";
import { bigramMatch, bigramText } from "./search-bigrams.js";
import { Store } from "./services.js";
import { StoreLive } from "./store.js";

const accountId = "gmail:me@example.com";

it("bigram tokens cover every one- and two-character substring of a run", () => {
  expect(bigramText("会议通知 at 3pm 鲸")).toBe("会议 议通 通知 知 鲸");
  expect(bigramText("ภาษาไทย")).toBe("ภา าษ ษา าไ ไท ทย ย");
  expect(bigramText("plain ascii")).toBe("");
  expect(bigramText(null)).toBe("");
  expect(bigramMatch("鲸鱼")).toBe('"鲸鱼"');
  expect(bigramMatch("鲸")).toBe('"鲸" *');
  // Longer terms use trigrams; mixed or Latin terms keep the word index or LIKE.
  expect(bigramMatch("鲸鱼群")).toBeUndefined();
  expect(bigramMatch("a鲸")).toBeUndefined();
  expect(bigramMatch("ab")).toBeUndefined();
});

const MESSAGES: Record<string, { subject: string; from: string; body: string }> = {
  whale: { subject: "Weekly", from: "Ops", body: "海边看见鲸鱼出没" },
  whaleSubject: { subject: "鲸鱼报告", from: "Ops", body: "see attached" },
  whaleEnd: { subject: "Note", from: "Ops", body: "最后是鲸" },
  sender: { subject: "Hello", from: "鲸鱼团队", body: "hi" },
  split: { subject: "Split", from: "Ops", body: "鲸 鱼 are apart" },
  fish: { subject: "Fish", from: "Ops", body: "金鱼和鲨鱼" },
  thai: { subject: "Thai", from: "Ops", body: "ภาษาไทย" },
  latin: { subject: "Latin", from: "Ops", body: "whale watching" },
};

const QUERIES = ["鲸鱼", "鲸", "鱼", "鱼出", "金", "ไท", "subject:鲸鱼", "subject:鲸", "鲨"];

/** Substring matching over the same fields, without SQL. */
const reference = (
  rows: Record<string, { subject: string; from: string; body: string }>,
  query: string,
) => {
  const subjectOnly = query.startsWith("subject:");
  const term = subjectOnly ? query.slice("subject:".length) : query;
  return Object.entries(rows)
    .filter(([, row]) =>
      (subjectOnly ? [row.subject] : [row.subject, row.from, row.body]).some((text) =>
        text.includes(term),
      ),
    )
    .map(([id]) => id)
    .toSorted();
};

it("short CJK searches return the same rows queued, indexed and after edits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmail-bigrams-"));
  const layer = StoreLive.pipe(
    Layer.provideMerge(
      databaseLayer(join(directory, "mail.sqlite")).pipe(Layer.provide(NodeSystem)),
    ),
  );
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store;
        const sql = yield* SqlClient.SqlClient;
        yield* store.upsertAccount("gmail", "me@example.com");
        const rows = { ...MESSAGES };
        const write = (id: string) => {
          const row = rows[id];
          return row
            ? store.upsertMessage(
                accountId,
                incoming(id, {
                  threadId: id,
                  subject: row.subject,
                  from: { name: row.from, address: "ops@example.com" },
                  bodyText: row.body,
                }),
              )
            : Effect.void;
        };
        for (const id of Object.keys(rows)) yield* write(id);
        const search = (query: string) =>
          store
            .listThreads({ search: query, flat: true })
            .pipe(
              Effect.map((found) =>
                found.map((row) => row.id.slice(accountId.length + 1)).toSorted(),
              ),
            );
        const expectAll = Effect.gen(function* () {
          for (const query of QUERIES)
            expect([query, yield* search(query)]).toEqual([query, reference(rows, query)]);
        });
        const pending = (kind: string) =>
          sql<{
            n: number;
          }>`SELECT COUNT(*) AS n FROM search_bigram_pending WHERE kind=${kind}`.pipe(
            Effect.map((result) => result[0]?.n),
          );

        // Every new row waits in the queue and is still found through LIKE.
        expect(yield* pending("messages")).toBe(Object.keys(rows).length);
        yield* expectAll;
        // Half indexed, then fully indexed.
        expect(yield* store.indexBigrams(4)).toEqual({ processed: 4, ready: false });
        yield* expectAll;
        while (!(yield* store.indexBigrams(4)).ready) {
          /* drain */
        }
        expect(yield* pending("messages")).toBe(0);
        yield* expectAll;

        // An edit drops the old tokens at once and queues the row again.
        rows.whale = { subject: "Weekly", from: "Ops", body: "只有鲨鱼" };
        yield* write("whale");
        expect(yield* pending("messages")).toBe(1);
        yield* expectAll;
        yield* store.indexBigrams();
        yield* expectAll;

        // Body eviction and deletion.
        yield* sql`UPDATE messages SET body_text='' WHERE id=${`${accountId}/fish`}`;
        rows.fish = { subject: "Fish", from: "Ops", body: "" };
        yield* expectAll;
        yield* store.indexBigrams();
        yield* expectAll;
        yield* sql`DELETE FROM messages WHERE id=${`${accountId}/sender`}`;
        delete rows.sender;
        yield* expectAll;
        expect(yield* pending("messages")).toBe(0);
        const indexed = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM messages_bigrams`;
        // Rows without CJK or Thai text keep no tokens: latin, and fish once its body is gone.
        expect(indexed[0]?.n).toBe(Object.keys(rows).length - 2);

        // Attachment text from OCR goes through the same queue.
        const messageId = `${accountId}/latin`;
        yield* sql`INSERT INTO derived_chunks(message_id,text,provenance_json) VALUES(${messageId},'扫描件里有鲸鱼',${JSON.stringify(
          {
            messageId,
            text: "扫描件里有鲸鱼",
            source: { kind: "attachment", index: 0, name: "scan.png", mimeType: "image/png" },
            page: null,
            region: null,
            pipelineVersion: "test",
            visionRevision: 1,
          },
        )})`;
        const withChunk = [...reference(rows, "鲸鱼"), "latin"].toSorted();
        expect(yield* pending("derived")).toBe(1);
        expect(yield* search("鲸鱼")).toEqual(withChunk);
        yield* store.indexBigrams();
        expect(yield* pending("derived")).toBe(0);
        expect(yield* search("鲸鱼")).toEqual(withChunk);
        expect(yield* search("扫")).toEqual(["latin"]);
      }).pipe(Effect.provide(layer)),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

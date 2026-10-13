import { PdfWorker } from "../platform/runtime.js";
import { AuthError, ProviderError } from "../domain/errors.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { TestClock } from "effect/testing";
import { databaseLayer, DatabaseCapabilities } from "../platform/node/db.js";
import { NodeSystem } from "../platform/node/platform-node.js";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { type IndexerInput, makeIndexer } from "./indexer.js";
import type { IncomingMessage, ThreadSummary } from "../domain/message.js";
import { MediaError, type Vision, unavailableVision } from "./media.js";
import { MemoryPlatform } from "../platform/node/platform-memory.js";
import { Store } from "../store/service.js";
import { StoreLive } from "../store/store.js";
import { pdfText } from "../platform/node/pdf-text.js";
import { inlineMediaFromRaw } from "../platform/node/portable-helpers.js";
import { parseSearchQuery } from "../search/search.js";
import { reciprocalRankFusion, mergeSearchResults } from "../search/ranking.js";

const withStore = <A, E>(body: Effect.Effect<A, E, Store | SqlClient.SqlClient | PdfWorker>) =>
  body.pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform()))));
const message = (override: Partial<IncomingMessage> = {}): IncomingMessage => ({
  providerId: "m",
  threadId: "t",
  subject: "Mail",
  from: { name: "Alice", address: "alice@example.com" },
  to: [],
  cc: [],
  date: 1000,
  snippet: "",
  bodyText: "",
  bodyHtml: "",
  labels: ["INBOX"],
  attachments: [{ filename: "ticket.png", mimeType: "image/png", size: 20 }],
  isUnread: true,
  isStarred: false,
  ...override,
});
const fakeVision: Vision = {
  available: true,
  version: "test-revision3",
  recognize: () =>
    Effect.succeed({
      revision: 3,
      lines: [
        {
          text: "登机牌 boarding gate code",
          confidence: 0.9,
          region: {
            box: { x: 10, y: 1200, width: 80, height: 20 },
            tile: { x: 0, y: 896, width: 900, height: 1024 },
            imageWidth: 900,
            imageHeight: 5200,
          },
        },
      ],
    }),
};
const setup = Effect.gen(function* () {
  const store = yield* Store;
  const account = yield* store.upsertAccount("gmail", "test@example.com");
  yield* store.upsertMessage(account.id, message());
  return { store, account, id: `${account.id}/m` };
});

it.effect("duplicate extraction positions fail and roll back the cached chunks and FTS", () =>
  withStore(
    Effect.gen(function* () {
      const { store, id } = yield* setup;
      const job = yield* store.media.claim("positions", 1000, true);
      assert.ok(Option.isSome(job));
      const chunk = {
        messageId: id,
        text: "boarding duplicate",
        source: { kind: "attachment", index: 0, name: "ticket.png", mimeType: "image/png" },
        chunkIndex: 0,
        page: null,
        region: null,
        pipelineVersion: "positions",
        visionRevision: 3,
      } satisfies import("./media.js").DerivedChunk;
      yield* store.media.complete(job.value, [chunk], null);
      const cached = yield* store.media.chunks(id);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE derived_jobs SET status='queued' WHERE message_id=${id}`;
      const reindex = yield* store.media.claim("positions", 2000, true);
      assert.ok(Option.isSome(reindex));
      const rejected = yield* Effect.exit(
        store.media.complete(
          reindex.value,
          [
            { ...chunk, text: "replacement invoice" },
            { ...chunk, text: "silently overwritten invoice" },
          ],
          null,
        ),
      );
      assert.strictEqual(rejected._tag, "Failure");
      assert.deepStrictEqual(yield* store.media.chunks(id), cached);
      assert.strictEqual(
        (yield* sql`SELECT status FROM derived_jobs WHERE message_id=${id}`)[0]?.status,
        "running",
      );
      for (const table of ["derived_fts", "derived_words"]) {
        yield* sql`INSERT INTO ${sql.literal(table)}(${sql.literal(table)},rank) VALUES('integrity-check',1)`;
        assert.strictEqual(
          (yield* sql`SELECT rowid FROM ${sql.literal(table)} WHERE ${sql.literal(table)} MATCH 'boarding'`)
            .length,
          1,
        );
        assert.strictEqual(
          (yield* sql`SELECT rowid FROM ${sql.literal(table)} WHERE ${sql.literal(table)} MATCH 'invoice'`)
            .length,
          0,
        );
      }
    }),
  ),
);

it.effect(
  "chunk identity changes preserve completed and failed jobs on the existing pipeline version",
  () =>
    withStore(
      Effect.gen(function* () {
        const { store, account, id } = yield* setup;
        yield* store.upsertMessage(account.id, message({ providerId: "failed" }));
        const sql = yield* SqlClient.SqlClient;
        const version = `media-1:tile1024-overlap128:pdf-text2-worker:${fakeVision.version}`;
        yield* sql`UPDATE derived_jobs SET status=CASE WHEN message_id=${id} THEN 'done' ELSE 'failed' END,
      attempts=CASE WHEN message_id=${id} THEN 0 ELSE 5 END,pipeline_version=${version}`;
        const indexer = yield* indexerFor(store, {
          attachment: () =>
            Effect.die(new Error("Completed attachments must not be downloaded again")),
        });
        assert.strictEqual(yield* indexer.batch(), 0);
        assert.strictEqual((yield* indexer.progress).done, 1);
        assert.strictEqual((yield* indexer.progress).failed, 1);
      }),
    ),
);

it.effect(
  "reindex twice replaces the complete chunk set and preserves repeated text positions",
  () =>
    withStore(
      Effect.gen(function* () {
        const { store, account, id } = yield* setup;
        const vision: Vision = {
          ...fakeVision,
          recognize: (data) =>
            fakeVision
              .recognize(data)
              .pipe(
                Effect.map((result) => ({ ...result, lines: [...result.lines, ...result.lines] })),
              ),
        };
        for (const version of ["initial", "reindex1", "reindex2"]) {
          const indexer = yield* indexerFor(store, { vision: { ...vision, version } });
          assert.strictEqual(yield* indexer.batch(), 1);
          const chunks = yield* store.media.chunks(id);
          assert.deepStrictEqual(
            chunks.map((chunk) => chunk.chunkIndex),
            [0, 1],
          );
        }
        // Refill only queues semantic work, and cannot create another OCR set.
        yield* store.upsertMessage(account.id, message({ bodyText: "refilled body" }));
        assert.strictEqual((yield* store.media.chunks(id)).length, 2);
        const shorter = yield* indexerFor(store, { vision: { ...fakeVision, version: "shorter" } });
        assert.strictEqual(yield* shorter.batch(), 1);
        assert.strictEqual((yield* store.media.chunks(id)).length, 1);
        const sql = yield* SqlClient.SqlClient;
        for (const table of ["derived_fts", "derived_words"])
          yield* sql`INSERT INTO ${sql.literal(table)}(${sql.literal(table)},rank) VALUES('integrity-check',1)`;
      }),
    ),
);

it("crash during replacement rolls back chunks and FTS before a persisted lease retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmail-media-crash-"));
  const filename = join(directory, "mail.db");
  const layer = () => StoreLive.pipe(Layer.provideMerge(MemoryPlatform({ database: filename })));
  try {
    const job = await Effect.runPromise(
      Effect.gen(function* () {
        const { store } = yield* setup;
        yield* (yield* indexerFor(store)).batch();
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE derived_jobs SET status='queued'`;
        const job = yield* store.media.claim("crash", 1000, true);
        assert.ok(Option.isSome(job));
        const original = yield* store.media.chunks(job.value.message_id);
        const first = original[0];
        assert.ok(first);
        yield* sql.unsafe(`CREATE TRIGGER crash_chunk BEFORE INSERT ON derived_chunks
          WHEN new.chunk_index=1 BEGIN SELECT RAISE(ABORT,'simulated crash'); END;`);
        const failed = yield* Effect.exit(
          store.media.complete(
            job.value,
            [
              { ...first, text: "replacement invoice", chunkIndex: 0 },
              { ...first, text: "second invoice", chunkIndex: 1 },
            ],
            null,
          ),
        );
        assert.strictEqual(failed._tag, "Failure");
        assert.deepStrictEqual(yield* store.media.chunks(job.value.message_id), original);
        return job.value;
      }).pipe(Effect.provide(layer())),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store;
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe("DROP TRIGGER crash_chunk");
        const recovered = yield* store.media.claim("crash", 301001, true);
        assert.ok(Option.isSome(recovered));
        const [first] = yield* store.media.chunks(job.message_id);
        assert.ok(first);
        const replacement = [
          { ...first, text: "replacement invoice", chunkIndex: 0 },
          { ...first, text: "second invoice", chunkIndex: 1 },
        ];
        assert.strictEqual(yield* store.media.complete(job, replacement, null), false);
        assert.strictEqual(yield* store.media.complete(recovered.value, replacement, null), true);
        assert.strictEqual(yield* store.media.complete(recovered.value, replacement, null), false);
        assert.strictEqual((yield* store.media.chunks(job.message_id)).length, 2);
        for (const table of ["derived_fts", "derived_words"]) {
          yield* sql`INSERT INTO ${sql.literal(table)}(${sql.literal(table)},rank) VALUES('integrity-check',1)`;
          assert.strictEqual(
            (yield* sql`SELECT rowid FROM ${sql.literal(table)} WHERE ${sql.literal(table)} MATCH 'invoice'`)
              .length,
            2,
          );
          assert.strictEqual(
            (yield* sql`SELECT rowid FROM ${sql.literal(table)} WHERE ${sql.literal(table)} MATCH 'boarding'`)
              .length,
            0,
          );
        }
      }).pipe(Effect.provide(layer())),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("concurrent indexers on separate connections leave one set per message and MIME part", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmail-media-concurrent-"));
  const filename = join(directory, "mail.db");
  const layer = () => StoreLive.pipe(Layer.provideMerge(MemoryPlatform({ database: filename })));
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { store, account } = yield* setup;
        yield* store.upsertMessage(
          account.id,
          message({
            providerId: "forward",
            subject: "Fwd: Mail",
            attachments: [
              { filename: "copy.png", mimeType: "image/png", size: 20 },
              { filename: "copy.png", mimeType: "image/png", size: 20 },
            ],
          }),
        );
      }).pipe(Effect.provide(layer())),
    );
    const work = () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Store;
          const indexer = yield* indexerFor(store, {
            vision: {
              ...fakeVision,
              recognize: (data) => fakeVision.recognize(data).pipe(Effect.delay("20 millis")),
            },
          });
          return yield* indexer.batch();
        }).pipe(Effect.provide(layer())),
      );
    const completed = await Promise.all([work(), work()]);
    assert.strictEqual(
      completed.reduce((total, count) => total + count, 0),
      2,
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql`SELECT source_part,chunk_index FROM derived_chunks`;
        assert.strictEqual(rows.length, 3);
        assert.strictEqual(
          (yield* sql`SELECT 1 FROM derived_chunks GROUP BY message_id,source_part,chunk_index HAVING COUNT(*)>1`)
            .length,
          0,
        );
        for (const table of ["derived_fts", "derived_words"])
          yield* sql`INSERT INTO ${sql.literal(table)}(${sql.literal(table)},rank) VALUES('integrity-check',1)`;
      }).pipe(Effect.provide(layer())),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
const indexerFor = (
  store: Store["Service"],
  options: {
    vision?: Vision;
    battery?: () => boolean;
    inline?: boolean;
    attachment?: IndexerInput["attachment"];
    busy?: Effect.Effect<boolean>;
  } = {},
) =>
  makeIndexer({
    store: store.media,
    markReauth: (id, error) => store.markReauth(id, error),
    vision: options.vision ?? fakeVision,
    onBattery: options.battery ?? (() => false),
    busy: options.busy ?? Effect.succeed(false),
    message: (id) => store.getMessage(id).pipe(Effect.orDie),
    attachment: options.attachment ?? (() => Effect.succeed(new Uint8Array([1, 2, 3]))),
    inline: () =>
      Effect.succeed(
        options.inline
          ? [
              {
                cid: "ticket",
                name: "inline.png",
                mimeType: "image/png",
                data: new Uint8Array([1]),
              },
            ]
          : [],
      ),
    changed: Effect.void,
  });

it.effect(
  "queues, indexes idempotently, searches derived FTS and short Chinese with provenance",
  () =>
    withStore(
      Effect.gen(function* () {
        const { store, account, id } = yield* setup;
        const indexer = yield* indexerFor(store);
        assert.strictEqual((yield* indexer.progress).queued, 1);
        assert.strictEqual(yield* indexer.batch(), 1);
        assert.strictEqual(yield* indexer.batch(), 0);
        const chunks = yield* store.media.chunks(id);
        assert.strictEqual(chunks.length, 1);
        assert.strictEqual(chunks[0]?.visionRevision, 3);
        assert.strictEqual(chunks[0]?.region?.box.y, 1200);
        const [hit] = yield* store.listThreads({ search: "in:attachment has:image 登机牌" });
        assert.strictEqual(hit?.derivedMatches?.[0]?.source.name, "ticket.png");
        assert.strictEqual((yield* store.listThreads({ search: "登机" })).length, 1);
        assert.strictEqual(
          (yield* store.listThreads({ search: "boarding from:nobody" })).length,
          0,
        );
        assert.strictEqual(
          (yield* store.listThreads({ search: "boarding", accountIds: [] })).length,
          0,
        );
        assert.strictEqual(
          (yield* store.listThreads({ search: "boarding", before: 500 })).length,
          0,
        );
        // Flag-only changes preserve derivations and external-content message FTS rowids.
        yield* store.upsertMessage(account.id, message({ isUnread: false }));
        assert.strictEqual((yield* indexer.progress).done, 1);
        yield* store.upsertMessage(account.id, message({ attachments: [] }));
        assert.strictEqual((yield* indexer.progress).queued, 1);
        assert.strictEqual((yield* store.listThreads({ search: "boarding" })).length, 0);
        yield* indexer.batch();
        assert.strictEqual((yield* store.media.chunks(id)).length, 0);
      }),
    ),
);

it.effect(
  "pause, battery and unavailable Vision do not download images; inline CID media is indexed",
  () =>
    withStore(
      Effect.gen(function* () {
        const { store, account, id } = yield* setup;
        const battery = yield* indexerFor(store, { battery: () => true });
        assert.strictEqual(yield* battery.batch(), 0);
        const unavailable = yield* indexerFor(store, { vision: unavailableVision });
        assert.strictEqual(yield* unavailable.batch(), 0);
        const indexer = yield* indexerFor(store, { inline: true });
        yield* indexer.setPaused(true);
        const restarted = yield* indexerFor(store);
        assert.strictEqual((yield* restarted.progress).paused, true);
        assert.strictEqual(yield* restarted.batch(), 0);
        yield* indexer.setPaused(false);
        yield* store.upsertMessage(
          account.id,
          message({
            attachments: [],
            bodyHtml: '<img src="cid:ticket"><img src="https://invalid.invalid/pixel">',
          }),
        );
        assert.strictEqual(yield* indexer.batch(), 1);
        assert.strictEqual((yield* store.media.chunks(id))[0]?.source.kind, "inline");
      }),
    ),
);

it.effect(
  "claims survive restart, reject stale generations and retry failures without logging content",
  () =>
    withStore(
      Effect.gen(function* () {
        const { store, account, id } = yield* setup;
        const first = yield* store.media.claim("v1", 1000, true);
        assert.ok(Option.isSome(first));
        assert.ok(Option.isNone(yield* store.media.claim("v1", 2000, true)));
        const recovered = yield* store.media.claim("v1", 301001, true);
        assert.ok(Option.isSome(recovered));
        assert.strictEqual(yield* store.media.complete(first.value, [], null), false);
        yield* store.upsertMessage(
          account.id,
          message({
            bodyHtml: '<img src="cid:new">',
            attachments: [{ filename: "new.png", mimeType: "image/png", size: 20 }],
          }),
        );
        assert.strictEqual(yield* store.media.complete(recovered.value, [], null), false);
        const indexer = yield* indexerFor(store, {
          vision: {
            ...fakeVision,
            recognize: () => Effect.fail(new MediaError({ message: "private fixture text" })),
          },
        });
        yield* indexer.batch();
        const sql = yield* SqlClient.SqlClient;
        const [row] = yield* sql`SELECT attempts,note FROM derived_jobs WHERE message_id=${id}`;
        assert.deepStrictEqual({ ...row }, { attempts: 1, note: "Media extraction failed" });
        yield* sql`UPDATE derived_jobs SET retry_at=0`;
        const working = yield* indexerFor(store);
        assert.strictEqual(yield* working.batch(), 1);
        const upgraded = yield* indexerFor(store, {
          vision: { ...fakeVision, version: "revision4" },
        });
        assert.strictEqual(yield* upgraded.batch(), 1);
        assert.strictEqual((yield* store.media.chunks(id)).length, 1);
        yield* store.deleteMessage(account.id, "m");
        assert.strictEqual((yield* store.media.chunks(id)).length, 0);
        assert.strictEqual((yield* working.progress).done, 0);
      }),
    ),
);

it.effect(
  "vector extension is 0.1.9 with separate 384/512-dimensional tables and cascade cleanup",
  () =>
    withStore(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql`SELECT vec_version() AS version`;
        assert.strictEqual(rows[0]?.version, "v0.1.9");
        const { store, account, id } = yield* setup;
        const indexer = yield* indexerFor(store);
        yield* indexer.batch();
        const ids = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ id: Schema.Number })),
        )(yield* sql`SELECT id FROM derived_chunks WHERE message_id=${id}`);
        const chunkId = ids[0]?.id;
        assert.ok(chunkId);
        yield* sql`INSERT INTO vector_items(id,message_id,kind,version,provenance_json) VALUES(${chunkId},${id},'text','fixture',${JSON.stringify((yield* store.media.chunks(id))[0])})`;
        yield* sql`INSERT INTO derived_text_vectors(rowid,embedding) VALUES(${BigInt(chunkId)},${new Uint8Array(new Float32Array(384).buffer)})`;
        yield* sql`INSERT INTO derived_image_vectors(rowid,embedding) VALUES(${BigInt(chunkId)},${new Uint8Array(new Float32Array(512).buffer)})`;
        yield* store.removeAccount(account.id);
        assert.strictEqual((yield* sql`SELECT rowid FROM derived_text_vectors`).length, 0);
        assert.strictEqual((yield* sql`SELECT rowid FROM derived_image_vectors`).length, 0);
      }),
    ),
);

export { syntheticPdf } from "../platform/node/fixtures/synthetic-pdf.js";
import { syntheticPdf } from "../platform/node/fixtures/synthetic-pdf.js";

it.effect(
  "extracts PDF text offline by page and records scanned-page deferral; battery throttles PDFs",
  () =>
    withStore(
      Effect.gen(function* () {
        const pdf = syntheticPdf();
        const pages = yield* pdfText(pdf);
        assert.strictEqual(pages[0]?.text, "Synthetic boarding document");
        assert.strictEqual(pages[1]?.text, "");
        const { store, account, id } = yield* setup;
        yield* store.upsertMessage(
          account.id,
          message({
            attachments: [
              { filename: "document.pdf", mimeType: "application/pdf", size: pdf.length },
            ],
          }),
        );
        const indexer = yield* makeIndexer({
          store: store.media,
          markReauth: (id, error) => store.markReauth(id, error),
          vision: fakeVision,
          onBattery: () => true,
          busy: Effect.succeed(false),
          message: (id) => store.getMessage(id).pipe(Effect.orDie),
          attachment: () => Effect.succeed(pdf),
          inline: () => Effect.succeed([]),
          changed: Effect.void,
        });
        assert.strictEqual(yield* indexer.batch(), 1);
        const [hit] = yield* store.listThreads({ search: "in:attachment boarding" });
        assert.strictEqual(hit?.derivedMatches?.[0]?.page, 1);
        assert.strictEqual(hit?.derivedMatches?.[0]?.region, null);
        const sql = yield* SqlClient.SqlClient;
        const notes = yield* sql`SELECT note FROM derived_jobs WHERE message_id=${id}`;
        assert.strictEqual(
          notes[0]?.note,
          "Scanned PDF pages or oversized attachments require phase 2",
        );
      }),
    ),
);

it.effect("reads only MIME CID images, never a remote HTML URL", () =>
  Effect.gen(function* () {
    const raw = new TextEncoder().encode(
      'MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="x"\r\n\r\n--x\r\nContent-Type: text/html\r\n\r\n<img src="cid:one"><img src="https://invalid.invalid/pixel">\r\n--x\r\nContent-Type: image/png\r\nContent-ID: <one>\r\nContent-Transfer-Encoding: base64\r\n\r\nAQID\r\n--x--\r\n',
    );
    const parts = yield* inlineMediaFromRaw(raw);
    assert.strictEqual(parts.length, 1);
    assert.strictEqual(parts[0]?.cid, "one");
    assert.deepStrictEqual(parts[0]?.data, new Uint8Array([1, 2, 3]));
  }),
);

it("parses media tokens and fuses distinct sources by thread rather than representative message", () => {
  assert.deepStrictEqual(parseSearchQuery({ search: "has:image in:attachment 登机" }).criteria, {
    image: true,
    attachmentText: true,
  });
  const row: ThreadSummary = {
    id: "a/1",
    accountId: "a",
    threadId: "t",
    subject: "",
    from: { name: "", address: "" },
    date: 1,
    snippet: "",
    labels: [],
    isUnread: false,
    isStarred: false,
    hasAttachments: true,
    threadCount: 2,
    participants: [],
  };
  assert.strictEqual(reciprocalRankFusion([row], [{ ...row, id: "a/2", date: 2 }]).length, 1);
  assert.strictEqual(reciprocalRankFusion([row], [{ ...row, id: "a/2", date: 2 }], true).length, 2);
});

it.effect("interrupts OCR when AC power is lost and leaves a resumable job", () =>
  withStore(
    Effect.gen(function* () {
      const { store } = yield* setup;
      let battery = false;
      let cancelled = false;
      const started = yield* Deferred.make<void>();
      const vision: Vision = {
        ...fakeVision,
        recognize: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                cancelled = true;
              }),
            ),
          ),
      };
      const indexer = yield* indexerFor(store, { vision, battery: () => battery });
      const work = yield* Effect.forkChild(indexer.batch());
      yield* Deferred.await(started);
      battery = true;
      yield* TestClock.adjust("2 seconds");
      assert.strictEqual(yield* Fiber.join(work), 0);
      assert.strictEqual(cancelled, true);
      assert.strictEqual((yield* indexer.progress).queued, 1);
      assert.strictEqual((yield* indexer.progress).running, 0);
      const working = yield* indexerFor(store);
      assert.strictEqual(yield* working.batch(), 1);
    }),
  ),
);

it("resumes a persisted lease after the database is closed and reopened", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openmail-media-restart-"));
  const filename = join(dir, "mail.db");
  const layer = () =>
    StoreLive.pipe(
      Layer.provideMerge(databaseLayer(filename).pipe(Layer.provideMerge(NodeSystem))),
    );
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { store } = yield* setup;
        const job = yield* store.media.claim("old-version", Date.now() - 6 * 60_000, true);
        assert.ok(Option.isSome(job));
      }).pipe(Effect.provide(layer())),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store;
        const indexer = yield* indexerFor(store);
        assert.strictEqual(yield* indexer.batch(), 1);
        assert.strictEqual((yield* store.listThreads({ search: "boarding" })).length, 1);
        yield* indexer.setPaused(true);
      }).pipe(Effect.provide(layer())),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store;
        const indexer = yield* indexerFor(store);
        assert.strictEqual((yield* indexer.progress).paused, true);
        assert.strictEqual((yield* indexer.progress).done, 1);
      }).pipe(Effect.provide(layer())),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("PDF parsing reads bundled resources without a network request", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
  try {
    const pages = await Effect.runPromise(pdfText(syntheticPdf()));
    assert.strictEqual(pages.length, 2);
    assert.strictEqual(fetch.mock.calls.length, 0);
  } finally {
    fetch.mockRestore();
  }
});

it.effect("queues only eligible media and preserves scoped hits from older messages", () =>
  withStore(
    Effect.gen(function* () {
      const { store, account } = yield* setup;
      yield* store.upsertMessage(
        account.id,
        message({ providerId: "new", date: 2000, attachments: [], bodyText: "boarding" }),
      );
      yield* store.upsertMessage(
        account.id,
        message({ providerId: "plain", threadId: "plain", date: 3000, attachments: [] }),
      );
      const indexer = yield* indexerFor(store);
      assert.strictEqual((yield* indexer.progress).queued, 1);
      yield* indexer.batch();
      const hits = yield* store.listThreads({ search: "boarding" });
      assert.strictEqual(hits.length, 1);
      assert.strictEqual(hits[0]?.derivedMatches?.[0]?.messageId, `${account.id}/m`);
      assert.strictEqual(
        (yield* store.listThreads({ search: "boarding", label: "SENT", searchScope: "folder" }))
          .length,
        0,
      );
      assert.strictEqual((yield* store.listThreads({ search: "boarding is:unread" })).length, 1);
      const sql = yield* SqlClient.SqlClient;
      // Spam exclusions remain enforced even when a derived message id narrows the second query.
      yield* store.upsertMessage(account.id, message({ labels: ["SPAM"] }));
      assert.strictEqual(
        (yield* store.listThreads({ search: "in:attachment boarding" })).length,
        0,
      );
      assert.strictEqual(
        (yield* sql`SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'boarding'`).length,
        1,
      );
    }),
  ),
);

it("retains RRF ordering and provenance when server results arrive", () => {
  const row: ThreadSummary = {
    id: "a/1",
    accountId: "a",
    threadId: "t",
    subject: "",
    from: { name: "", address: "" },
    date: 1,
    snippet: "",
    labels: [],
    isUnread: false,
    isStarred: false,
    hasAttachments: true,
    threadCount: 1,
    participants: [],
    derivedMatches: [
      {
        messageId: "a/1",
        text: "boarding",
        source: { kind: "attachment", index: 0, name: "ticket.pdf", mimeType: "application/pdf" },
        page: 1,
        region: null,
        pipelineVersion: "v1",
        visionRevision: null,
      },
    ],
  };
  const newer = { ...row, id: "a/2", threadId: "other", date: 2, derivedMatches: [] };
  const { derivedMatches: _matches, ...server } = row;
  const merged = mergeSearchResults([row, newer], [server]);
  assert.strictEqual(merged[0]?.id, "a/1");
  assert.strictEqual(merged[0]?.derivedMatches?.[0]?.page, 1);
});

it.effect("stale claims exhaust the processing retry budget", () =>
  withStore(
    Effect.gen(function* () {
      const { store, id } = yield* setup;
      for (let attempt = 0; attempt < 5; attempt++) {
        assert.ok(Option.isSome(yield* store.media.claim("crash-test", attempt * 360_000, true)));
      }
      assert.ok(Option.isNone(yield* store.media.claim("crash-test", 5 * 360_000, true)));
      const sql = yield* SqlClient.SqlClient;
      const [job] = yield* sql`SELECT status,attempts FROM derived_jobs WHERE message_id=${id}`;
      assert.deepStrictEqual({ ...job }, { status: "failed", attempts: 5 });
    }),
  ),
);

it.effect("pure filters preserve chronological order and never attach unrelated OCR hits", () =>
  withStore(
    Effect.gen(function* () {
      const { store, account } = yield* setup;
      yield* store.upsertMessage(
        account.id,
        message({ providerId: "newer", threadId: "newer", date: 2000 }),
      );
      const indexer = yield* indexerFor(store);
      yield* indexer.batch();
      for (const search of ["from:alice", "has:image", "in:attachment"]) {
        const rows = yield* store.listThreads({ search });
        assert.deepStrictEqual(
          rows.map((row) => row.date),
          [2000, 1000],
        );
        assert.ok(rows.every((row) => row.derivedMatches === undefined));
      }
    }),
  ),
);

it("mail read/write/search/delete works when vector resolution or dlopen fails", async () => {
  for (const vectorExtension of [
    () => {
      throw new Error("Unsupported platform");
    },
    () => "/missing/vec0.dylib",
  ]) {
    const platform = databaseLayer(":memory:", { vectorExtension }).pipe(
      Layer.provideMerge(NodeSystem),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const capabilities = yield* DatabaseCapabilities;
        assert.strictEqual(capabilities.vectors, false);
        const { store, account, id } = yield* setup;
        const indexer = yield* indexerFor(store);
        yield* indexer.batch();
        assert.strictEqual((yield* store.listThreads({ search: "boarding" })).length, 1);
        yield* store.upsertMessage(account.id, message({ bodyHtml: "changed" }));
        yield* indexer.batch();
        yield* store.deleteMessage(account.id, "m");
        assert.strictEqual((yield* store.media.chunks(id)).length, 0);
        yield* store.upsertMessage(account.id, message());
        yield* indexer.batch();
        yield* store.removeAccount(account.id);
        const sql = yield* SqlClient.SqlClient;
        assert.strictEqual(
          (yield* sql`SELECT name FROM sqlite_master WHERE name='derived_text_vectors'`).length,
          0,
        );
        assert.strictEqual((yield* store.listThreads({})).length, 0);
      }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(platform)))),
    );
  }
});

it("a vector-free connection can delete persisted indexed mail and later vector cleanup removes orphans", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openmail-optional-vec-"));
  const filename = join(dir, "mail.db");
  const layer = (vectors: boolean) =>
    StoreLive.pipe(
      Layer.provideMerge(
        databaseLayer(filename, vectors ? {} : { vectorExtension: null }).pipe(
          Layer.provideMerge(NodeSystem),
        ),
      ),
    );
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { store } = yield* setup;
        yield* (yield* indexerFor(store)).batch();
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO derived_text_vectors(rowid,embedding) SELECT id,${new Uint8Array(new Float32Array(384).buffer)} FROM derived_chunks`;
      }).pipe(Effect.provide(layer(true))),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.removeAccount("gmail:test@example.com");
        assert.strictEqual((yield* store.listThreads({})).length, 0);
      }).pipe(Effect.provide(layer(false))),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.strictEqual((yield* sql`SELECT rowid FROM derived_text_vectors`).length, 0);
      }).pipe(Effect.provide(layer(true))),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.effect("an hour offline does not consume attempts and indexing resumes after recovery", () =>
  withStore(
    Effect.gen(function* () {
      const { store, id } = yield* setup;
      let offline = true;
      const indexer = yield* indexerFor(store, {
        attachment: () =>
          offline
            ? Effect.fail(new ProviderError({ message: "offline" }))
            : Effect.succeed(new Uint8Array([1])),
      });
      const sql = yield* SqlClient.SqlClient;
      for (let tries = 0; tries < 8; tries++) {
        assert.strictEqual(yield* indexer.batch(), 0);
        const [job] =
          yield* sql`SELECT status,attempts,retry_at FROM derived_jobs WHERE message_id=${id}`;
        assert.strictEqual(job?.status, "queued");
        assert.strictEqual(job?.attempts, 0);
        assert.ok(Number(job?.retry_at) > Date.now());
        yield* sql`UPDATE derived_jobs SET retry_at=0`;
      }
      offline = false;
      assert.strictEqual(yield* indexer.batch(), 1);
    }),
  ),
);

it.effect("authentication failures suspend the account until sign-in without exhausting jobs", () =>
  withStore(
    Effect.gen(function* () {
      const { store, account, id } = yield* setup;
      let authorized = false;
      let fetches = 0;
      const indexer = yield* indexerFor(store, {
        attachment: () => {
          fetches++;
          return authorized
            ? Effect.succeed(new Uint8Array([1]))
            : Effect.fail(new AuthError({ message: "sign in" }));
        },
      });
      yield* indexer.batch();
      assert.strictEqual((yield* store.getAccount(account.id)).needsReauth, true);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE derived_jobs SET retry_at=0`;
      for (let tries = 0; tries < 6; tries++) assert.strictEqual(yield* indexer.batch(), 0);
      assert.strictEqual(fetches, 1);
      const [job] = yield* sql`SELECT status,attempts FROM derived_jobs WHERE message_id=${id}`;
      assert.deepStrictEqual({ ...job }, { status: "queued", attempts: 0 });
      authorized = true;
      yield* store.clearReauth(account.id);
      assert.strictEqual(yield* indexer.batch(), 1);
    }),
  ),
);

it("PDF page limits and a hung worker fail within a bounded time", async () => {
  const capped = await Effect.runPromise(Effect.result(pdfText(syntheticPdf(), { maxPages: 1 })));
  assert.strictEqual(capped._tag, "Failure");
  const start = performance.now();
  const timed = await Effect.runPromise(
    Effect.result(
      pdfText(syntheticPdf(), {
        timeoutMs: 100,
        workerUrl: new URL("data:text/javascript,for(;;){}"),
      }),
    ),
  );
  assert.strictEqual(timed._tag, "Failure");
  assert.ok(performance.now() - start < 3000);
});

it.effect("activity during download keeps bytes and waits before OCR without redownloading", () =>
  withStore(
    Effect.gen(function* () {
      const { store } = yield* setup;
      let busy = false;
      let fetches = 0;
      let recognized = 0;
      const downloaded = yield* Deferred.make<void>();
      const indexer = yield* indexerFor(store, {
        busy: Effect.sync(() => busy),
        attachment: () =>
          Effect.sync(() => {
            fetches++;
            busy = true;
            return new Uint8Array([1]);
          }).pipe(Effect.tap(() => Deferred.succeed(downloaded, undefined))),
        vision: {
          ...fakeVision,
          recognize: (data) => {
            recognized++;
            return fakeVision.recognize(data);
          },
        },
      });
      const work = yield* Effect.forkChild(indexer.batch());
      yield* Deferred.await(downloaded);
      yield* TestClock.adjust("2 seconds");
      assert.strictEqual(recognized, 0);
      busy = false;
      yield* TestClock.adjust("2 seconds");
      assert.strictEqual(yield* Fiber.join(work), 1);
      assert.strictEqual(fetches, 1);
      assert.strictEqual(recognized, 1);
    }),
  ),
);

it.effect("large message-id filters and broad derived queries stay within SQLite bind limits", () =>
  withStore(
    Effect.gen(function* () {
      const { store, id } = yield* setup;
      yield* (yield* indexerFor(store)).batch();
      const ids = Array.from({ length: 40_000 }, (_, index) => `absent-${index}`);
      ids.push(id);
      assert.strictEqual(
        (yield* store.listThreads({ messageIds: ids, search: "boarding" })).length,
        1,
      );
      const rows = yield* store.listThreads({ search: "boarding", limit: 50 });
      assert.ok(rows.length <= 50);
      assert.strictEqual(rows[0]?.derivedMatches?.[0]?.text, "登机牌 boarding gate code");
    }),
  ),
);

it.effect(
  "derived candidates are bounded before expanding message ids",
  () =>
    withStore(
      Effect.gen(function* () {
        const { store, account } = yield* setup;
        const sql = yield* SqlClient.SqlClient;
        yield* store.transaction(
          Effect.gen(function* () {
            for (let index = 0; index < 1100; index++) {
              const providerId = `bulk-${index}`;
              yield* store.upsertMessage(
                account.id,
                message({ providerId, threadId: providerId, date: index + 2000 }),
              );
              const id = `${account.id}/${providerId}`;
              const chunk = {
                messageId: id,
                text: "bulkneedle",
                source: { kind: "attachment", index: 0, name: "file.png", mimeType: "image/png" },
                page: null,
                region: null,
                pipelineVersion: "test",
                visionRevision: null,
              };
              yield* sql`INSERT INTO derived_chunks(message_id,text,provenance_json) VALUES(${id},${chunk.text},${JSON.stringify(chunk)})`;
            }
          }),
        );
        assert.strictEqual(
          (yield* store.listThreads({ search: "bulkneedle", limit: 5000 })).length,
          1024,
        );
      }),
    ),
  // Inserts tens of thousands of rows; slow on a loaded machine.
  30_000,
);

it.effect("backfill chooses newest eligible mail and limits download reservations per minute", () =>
  withStore(
    Effect.gen(function* () {
      const { store, account } = yield* setup;
      yield* store.upsertMessage(
        account.id,
        message({ providerId: "new", threadId: "new", date: 3000 }),
      );
      const newest = yield* store.media.claim("priority", 1000, true);
      assert.ok(Option.isSome(newest));
      assert.strictEqual(newest.value.message_id, `${account.id}/new`);
      yield* store.media.release(newest.value);
      yield* store.deleteMessage(account.id, "new");
      yield* store.upsertMessage(
        account.id,
        message({
          attachments: [
            { filename: "one.png", mimeType: "image/png", size: 20 * 1024 * 1024 },
            { filename: "two.png", mimeType: "image/png", size: 20 * 1024 * 1024 },
          ],
        }),
      );
      const first = yield* Deferred.make<void>();
      let fetches = 0;
      const indexer = yield* indexerFor(store, {
        attachment: () =>
          Effect.sync(() => {
            fetches++;
            return new Uint8Array([1]);
          }).pipe(Effect.tap(() => Deferred.succeed(first, undefined))),
      });
      const work = yield* Effect.forkChild(indexer.batch());
      yield* Deferred.await(first);
      yield* TestClock.adjust("59 seconds");
      assert.strictEqual(fetches, 1);
      yield* TestClock.adjust("2 seconds");
      assert.strictEqual(yield* Fiber.join(work), 1);
      assert.strictEqual(fetches, 2);
    }),
  ),
);

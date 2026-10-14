import {
  withStore,
  vector,
  message,
  fakeModels,
  indexer,
  setup,
} from "../../test-support/semantic-fixtures.js";
import { TestClock } from "effect/testing";
import { Mailbox } from "../mailbox/mailbox.js";
import { TestMailbox, fakeServer } from "../platform/node/testing.js";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option } from "effect";
import { SqlClient } from "effect/sql";
import { makeSemanticIndexer } from "./semantic-indexer.js";
import {
  type DerivedChunk,
  MediaError,
  InferenceRuntimeError,
  unavailableVision,
} from "./media.js";
import { textChunks } from "./text-chunks.js";
import { semanticRankFusion } from "../search/ranking.js";

it("body chunks cover the original and overlap the preceding sentence", () => {
  const text =
    "First sentence about a flight. Second sentence about a passport. Third sentence about boarding. ".repeat(
      20,
    );
  const chunks = textChunks(text);
  assert.ok(chunks.length > 1);
  assert.strictEqual(chunks[0]?.start, 0);
  assert.strictEqual(chunks.at(-1)?.end, text.length);
  for (const [index, chunk] of chunks.entries()) {
    assert.strictEqual(chunk.text, text.slice(chunk.start, chunk.end));
    assert.ok(chunk.text.length <= 300);
    const previous = chunks[index - 1];
    if (previous) {
      assert.ok(chunk.start < previous.end);
      assert.ok(chunk.end > previous.end);
    }
  }
});

it.effect("opt-in, power, idle and pause gate every download and embedding", () =>
  withStore(
    Effect.gen(function* () {
      const { store } = yield* setup;
      const calls: string[] = [];
      const models = fakeModels(calls);
      const run = yield* indexer(store, models);
      assert.strictEqual(yield* run.batch(), 0);
      assert.deepStrictEqual(calls, []);
      yield* store.semantics.setEnabled(true);
      assert.strictEqual(yield* (yield* indexer(store, models, true)).batch(), 0);
      assert.strictEqual(yield* (yield* indexer(store, models, false, true)).batch(), 0);
      yield* store.media.setPaused(true);
      assert.strictEqual(yield* run.batch(), 0);
      assert.deepStrictEqual(calls, []);
      yield* store.media.setPaused(false);
      assert.strictEqual(yield* run.batch(), 1);
      assert.ok(calls.includes("passage:Airport passport boarding pass."));
      assert.strictEqual(yield* run.batch(), 0);
    }),
  ),
);

it.effect("body, OCR/PDF text and whole/tile image vectors retain provenance and versions", () =>
  withStore(
    Effect.gen(function* () {
      const { store, account, id } = yield* setup;
      yield* store.upsertMessage(
        account.id,
        message({ attachments: [{ filename: "long.png", mimeType: "image/png", size: 20 }] }),
      );
      const job = yield* store.media.claim("ocr", Date.now(), true);
      assert.ok(Option.isSome(job));
      const derived: DerivedChunk = {
        messageId: id,
        text: "Invoice total 35 dollars.",
        source: { kind: "attachment", index: 0, name: "long.png", mimeType: "image/png" },
        page: null,
        region: {
          imageWidth: 800,
          imageHeight: 5200,
          box: { x: 0, y: 900, width: 100, height: 20 },
          tile: { x: 0, y: 896, width: 800, height: 1024 },
        },
        pipelineVersion: "ocr",
        visionRevision: 3,
      };
      yield* store.media.complete(
        job.value,
        [
          derived,
          {
            ...derived,
            page: 2,
            region: null,
            source: {
              kind: "attachment",
              index: 1,
              name: "paper.pdf",
              mimeType: "application/pdf",
            },
          },
        ],
        null,
      );
      yield* store.semantics.setEnabled(true);
      const calls: string[] = [];
      const models = fakeModels(calls);
      const run = yield* indexer(store, models);
      assert.strictEqual(yield* run.batch(), 1);
      const text = yield* store.semantics.neighbors("text", vector(384), models.version);
      assert.ok(text.some((hit) => hit.source.kind === "body" && hit.source.start === 0));
      assert.ok(text.some((hit) => hit.visionRevision === 3 && hit.region?.box.y === 900));
      assert.ok(text.some((hit) => hit.page === 2));
      const images = yield* store.semantics.neighbors("image", vector(512), models.version);
      assert.strictEqual(images.length, 2);
      assert.ok(images.some((hit) => hit.region?.box.height === 5200));
      assert.ok(images.some((hit) => hit.region?.tile.y === 896));
      const upgraded = fakeModels(calls, "test-v2");
      assert.strictEqual(yield* (yield* indexer(store, upgraded)).batch(), 1);
      assert.strictEqual(
        (yield* store.semantics.neighbors("text", vector(384), "test-v1")).length,
        0,
      );
      assert.strictEqual(
        (yield* store.semantics.neighbors("image", vector(512), "test-v2")).length,
        2,
      );
    }),
  ),
);

it.effect(
  "semantic candidates respect account, sender, folder and attachment scope before KNN",
  () =>
    withStore(
      Effect.gen(function* () {
        const { store, account, id } = yield* setup;
        yield* store.semantics.setEnabled(true);
        const models = fakeModels([]);
        yield* (yield* indexer(store, models)).batch();
        const hits = yield* store.semantics.neighbors("text", vector(384), models.version);
        assert.strictEqual((yield* store.listThreads({ search: "travel" })).length, 0);
        const matched = yield* store.vectorThreads({ search: "travel" }, hits);
        assert.strictEqual(matched[0]?.derivedMatches?.[0]?.messageId, id);
        assert.strictEqual(
          (yield* store.semantics.neighbors("text", vector(384), models.version, {
            accountIds: [],
          })).length,
          0,
        );
        assert.strictEqual(
          (yield* store.semantics.neighbors("text", vector(384), models.version, {
            criteria: { from: "nobody" },
          })).length,
          0,
        );
        assert.strictEqual(
          (yield* store.semantics.neighbors("text", vector(384), models.version, {
            criteria: { attachmentText: true },
          })).length,
          0,
        );
        assert.strictEqual(
          (yield* store.semantics.neighbors("text", vector(384), models.version, {
            searchScope: "folder",
            mailbox: "sent",
          })).length,
          0,
        );
        yield* store.upsertMessage(account.id, message({ bodyText: "changed" }));
        assert.strictEqual(
          (yield* store.semantics.neighbors("text", vector(384), models.version)).length,
          0,
        );
        yield* (yield* indexer(store, models)).batch();
        yield* store.removeAccount(account.id);
        assert.strictEqual(
          (yield* store.semantics.neighbors("text", vector(384), models.version)).length,
          0,
        );
      }),
    ),
);

for (const bodyText of ["Airport passport boarding pass.", "Changed after eviction."]) {
  it.effect(`evicted body refill restores semantic neighbors for ${bodyText}`, () =>
    withStore(
      Effect.gen(function* () {
        const { store, account, id } = yield* setup;
        yield* store.semantics.setEnabled(true);
        const models = fakeModels([]);
        const run = yield* indexer(store, models);
        assert.strictEqual(yield* run.batch(), 1);
        assert.strictEqual(
          (yield* store.semantics.neighbors("text", vector(384), models.version)).length,
          1,
        );
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE messages SET body_text='',body_html='',body_cached=0 WHERE id=${id}`;
        assert.strictEqual(
          (yield* store.semantics.neighbors("text", vector(384), models.version)).length,
          1,
        );
        yield* store.upsertMessage(account.id, message({ bodyText }));
        yield* run.batch();
        const hits = yield* store.semantics.neighbors("text", vector(384), models.version);
        assert.strictEqual(hits.length, 1);
        assert.strictEqual(hits[0]?.text, bodyText);
      }),
    ),
  );
}

it.effect("refilling body HTML preserves completed OCR when attachments are unchanged", () =>
  withStore(
    Effect.gen(function* () {
      const { store, account, id } = yield* setup;
      yield* store.upsertMessage(
        account.id,
        message({
          bodyHtml: '<img src="cid:old">',
          attachments: [{ filename: "scan.png", mimeType: "image/png", size: 20 }],
        }),
      );
      const job = yield* store.media.claim("ocr", Date.now(), true);
      assert.ok(Option.isSome(job));
      yield* store.media.complete(
        job.value,
        [
          {
            messageId: id,
            text: "Old receipt",
            source: { kind: "inline", cid: "old", name: "old.png", mimeType: "image/png" },
            page: null,
            region: null,
            pipelineVersion: "ocr",
            visionRevision: 1,
          },
        ],
        null,
      );
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE messages SET body_text='',body_html='',body_cached=0 WHERE id=${id}`;
      assert.strictEqual((yield* store.media.chunks(id)).length, 1);
      yield* store.upsertMessage(
        account.id,
        message({
          bodyHtml: '<img src="cid:new">',
          attachments: [{ filename: "scan.png", mimeType: "image/png", size: 20 }],
        }),
      );
      assert.strictEqual((yield* store.media.counts).queued, 0);
      assert.strictEqual((yield* store.media.chunks(id))[0]?.text, "Old receipt");
    }),
  ),
);

it.effect("the indexer lazily repairs only missing vectors after a legacy refill", () =>
  withStore(
    Effect.gen(function* () {
      const { store, account, id } = yield* setup;
      yield* store.upsertMessage(
        account.id,
        message({ providerId: "healthy", threadId: "healthy" }),
      );
      yield* store.semantics.setEnabled(true);
      const calls: string[] = [];
      const models = fakeModels(calls);
      const run = yield* indexer(store, models);
      assert.strictEqual(yield* run.batch(), 2);
      const sql = yield* SqlClient.SqlClient;
      // Legacy refill kept vector_items and the done job but deleted the vec0 rows.
      yield* sql`DELETE FROM derived_text_vectors WHERE rowid IN (SELECT id FROM vector_items WHERE message_id=${id})`;
      assert.strictEqual(
        (yield* store.semantics.neighbors("text", vector(384), models.version)).length,
        1,
      );
      calls.length = 0;
      assert.strictEqual(yield* run.batch(), 1);
      assert.strictEqual(
        (yield* store.semantics.neighbors("text", vector(384), models.version)).length,
        2,
      );
      assert.strictEqual(calls.filter((call) => call.startsWith("passage:")).length, 1);
      calls.length = 0;
      assert.strictEqual(yield* run.batch(), 0);
      assert.strictEqual(calls.filter((call) => call.startsWith("passage:")).length, 0);
    }),
  ),
);

it.effect("lazy vector repair leaves an evicted body alone until it is refilled", () =>
  withStore(
    Effect.gen(function* () {
      const { store, id } = yield* setup;
      yield* store.semantics.setEnabled(true);
      const run = yield* indexer(store, fakeModels([]));
      assert.strictEqual(yield* run.batch(), 1);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE messages SET body_text='',body_html='',body_cached=0 WHERE id=${id}`;
      yield* sql`DELETE FROM derived_text_vectors WHERE rowid IN (SELECT id FROM vector_items WHERE message_id=${id})`;
      assert.strictEqual(yield* run.batch(), 0);
      assert.strictEqual((yield* store.semantics.counts).queued, 0);
      assert.strictEqual((yield* store.semantics.counts).done, 1);
    }),
  ),
);

it.effect("lazy vector repair scans bounded batches and progresses through the corpus", () =>
  withStore(
    Effect.gen(function* () {
      const { store, account } = yield* setup;
      for (let index = 1; index < 130; index++)
        yield* store.upsertMessage(
          account.id,
          message({ providerId: `m${index}`, threadId: `t${index}` }),
        );
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO vector_items(message_id,kind,version,provenance_json) SELECT id,'text','test-v1','{}' FROM messages`;
      yield* sql`UPDATE semantic_jobs SET status='done',pipeline_version='test-v1'`;
      yield* store.semantics.setEnabled(true);
      const run = yield* indexer(store, fakeModels([]));
      assert.strictEqual(yield* run.batch(), 2);
      assert.strictEqual(
        (yield* sql`SELECT COUNT(*) AS n FROM semantic_jobs WHERE generation>1`)[0]?.n,
        128,
      );
      assert.strictEqual((yield* store.semantics.counts).queued, 126);
      assert.strictEqual(yield* run.batch(), 2);
      assert.strictEqual(
        (yield* sql`SELECT COUNT(*) AS n FROM semantic_jobs WHERE generation>1`)[0]?.n,
        130,
      );
    }),
  ),
);

it.effect("model failures leave resumable jobs and never upload content", () =>
  withStore(
    Effect.gen(function* () {
      const { store } = yield* setup;
      yield* store.semantics.setEnabled(true);
      const models = fakeModels([]);
      const failing = {
        ...models,
        embedder: {
          ...models.embedder,
          text: () => Effect.fail(new MediaError({ message: "local failure" })),
        },
      };
      yield* (yield* indexer(store, failing)).batch();
      assert.strictEqual((yield* store.semantics.counts).queued, 1);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE semantic_jobs SET retry_at=0`;
      assert.strictEqual(yield* (yield* indexer(store, models)).batch(), 1);
    }),
  ),
);

it.effect("three-way RRF keeps an exact hit above a lone vector candidate", () =>
  withStore(
    Effect.gen(function* () {
      const { store, account } = yield* setup;
      yield* store.upsertMessage(
        account.id,
        message({ providerId: "other", threadId: "other", bodyText: "receipt" }),
      );
      const fts = yield* store.listThreads({ search: "receipt" });
      const others = yield* store.listThreads({ messageIds: [`${account.id}/m`] });
      const merged = semanticRankFusion(fts, others, []);
      assert.strictEqual(merged[0]?.id, `${account.id}/other`);
      // A vector-only candidate has no query words to highlight.
      assert.strictEqual(merged[0]?.related, undefined);
      assert.ok(merged[0]?.searchMatches?.length);
      const related = merged.find((row) => row.id === `${account.id}/m`);
      assert.strictEqual(related?.related, true);
      assert.strictEqual(related?.searchMatches, undefined);
    }),
  ),
);

it.effect("Mailbox and MCP share semantic hits after persisted opt-in", () =>
  Effect.gen(function* () {
    const mail = yield* Mailbox;
    yield* mail.connect({ provider: "gmail" });
    yield* mail.sync();
    assert.strictEqual((yield* mail.reading.threads({ search: "travel" })).length, 0);
    yield* mail.ai.setModelsEnabled(true);
    yield* TestClock.adjust("15 seconds");
    const rows = yield* mail.reading.threads({ search: "travel" });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0]?.derivedMatches?.[0]?.source.kind, "body");
    assert.ok(!JSON.stringify(rows).includes('"vector"'));
    yield* mail.ai.setModelsEnabled(false);
    assert.strictEqual((yield* mail.reading.threads({ search: "travel" })).length, 0);
  }).pipe(
    Effect.provide(
      TestMailbox(
        { gmail: fakeServer("test@example.com", [message()]) },
        {
          media: { vision: unavailableVision, onBattery: () => false, idle: () => true },
          models: fakeModels([]),
        },
      ),
    ),
  ),
);

it.effect("unplugging interrupts model preparation before any job is claimed", () =>
  withStore(
    Effect.gen(function* () {
      const { store } = yield* setup;
      yield* store.semantics.setEnabled(true);
      const started = yield* Deferred.make<void>();
      let cancelled = false;
      let battery = false;
      const models = {
        ...fakeModels([]),
        ensure: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                cancelled = true;
              }),
            ),
          ),
      };
      const run = yield* makeSemanticIndexer(
        {
          store: store.media,
          markReauth: (id, error) => store.markReauth(id, error),
          vision: unavailableVision,
          onBattery: () => battery,
          busy: Effect.succeed(false),
          changed: Effect.void,
          message: (id) => store.getMessage(id).pipe(Effect.orDie),
          attachment: () => Effect.succeed(new Uint8Array()),
          inline: () => Effect.succeed([]),
        },
        store,
        models,
      );
      const task = yield* Effect.forkChild(run.batch().pipe(Effect.result));
      yield* Deferred.await(started);
      battery = true;
      yield* TestClock.adjust("2 seconds");
      assert.strictEqual((yield* Fiber.join(task))._tag, "Success");
      assert.strictEqual(cancelled, true);
      assert.strictEqual((yield* store.semantics.counts).queued, 1);
    }),
  ),
);

it.effect(
  "typing, syncing, battery and indexing pause do not disable verified-model search",
  () => {
    let idle = true;
    let battery = false;
    return Effect.gen(function* () {
      const mail = yield* Mailbox;
      yield* mail.connect({ provider: "gmail" });
      yield* mail.sync();
      yield* mail.ai.setModelsEnabled(true);
      yield* TestClock.adjust("15 seconds");
      idle = false;
      battery = true;
      assert.strictEqual((yield* mail.reading.threads({ search: "travel" })).length, 1);
      yield* mail.ai.setIndexingPaused(true);
      assert.strictEqual((yield* mail.reading.threads({ search: "travel" })).length, 1);
    }).pipe(
      Effect.provide(
        TestMailbox(
          { gmail: fakeServer("test@example.com", [message()]) },
          {
            models: fakeModels([]),
            media: { vision: unavailableVision, onBattery: () => battery, idle: () => idle },
          },
        ),
      ),
    );
  },
);

it.effect("a newly busy desktop does not discard completed vector work", () =>
  withStore(
    Effect.gen(function* () {
      const { store } = yield* setup;
      yield* store.semantics.setEnabled(true);
      let busy = false;
      const base = fakeModels([]);
      const models = {
        ...base,
        embedder: {
          ...base.embedder,
          text: () =>
            Effect.sync(() => {
              busy = true;
              return vector(384);
            }),
        },
      };
      const run = yield* makeSemanticIndexer(
        {
          store: store.media,
          markReauth: (id, error) => store.markReauth(id, error),
          vision: unavailableVision,
          onBattery: () => false,
          busy: Effect.sync(() => busy),
          changed: Effect.void,
          message: (id) => store.getMessage(id).pipe(Effect.orDie),
          attachment: () => Effect.succeed(new Uint8Array()),
          inline: () => Effect.succeed([]),
        },
        store,
        models,
      );
      assert.strictEqual(yield* run.batch(), 1);
      assert.strictEqual((yield* store.semantics.counts).done, 1);
    }),
  ),
);

it.effect("unrelated vectors are excluded independently on text and image routes", () =>
  withStore(
    Effect.gen(function* () {
      const { store, id } = yield* setup;
      const sql = yield* SqlClient.SqlClient;
      yield* store.semantics.setEnabled(true);
      yield* (yield* indexer(store, fakeModels([]))).batch();
      assert.strictEqual(
        (yield* store.semantics.neighbors("text", vector(384, 1), "test-v1")).length,
        0,
      );
      const job = yield* store.semantics.claim("test-v1", Date.now(), true);
      // Completed rows can be explicitly requeued for the image fixture.
      if (Option.isNone(job))
        yield* sql`UPDATE semantic_jobs SET status='queued' WHERE message_id=${id}`;
      const claim = Option.isSome(job)
        ? job
        : yield* store.semantics.claim("test-v1", Date.now(), true);
      assert.ok(Option.isSome(claim));
      const chunk = {
        messageId: id,
        text: "fixture",
        source: { kind: "body", name: "", start: 0, end: 7 },
        page: null,
        region: null,
        visionRevision: null,
        pipelineVersion: "test-v1",
      } satisfies DerivedChunk;
      yield* store.semantics.complete(
        claim.value,
        [{ kind: "image", vector: vector(512), provenance: chunk }],
        "test-v1",
      );
      assert.strictEqual(
        (yield* store.semantics.neighbors("image", vector(512, 1), "test-v1")).length,
        0,
      );
    }),
  ),
);

it.effect("completing one message never sweeps unrelated orphan vectors", () =>
  withStore(
    Effect.gen(function* () {
      const { store } = yield* setup;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO derived_text_vectors(rowid,embedding) VALUES(${999999n},${new Uint8Array(new Float32Array(vector(384)).buffer)})`;
      yield* store.semantics.setEnabled(true);
      yield* (yield* indexer(store, fakeModels([]))).batch();
      assert.strictEqual(
        (yield* sql`SELECT rowid FROM derived_text_vectors WHERE rowid=${999999n}`).length,
        1,
      );
    }),
  ),
);

it.effect("input activity does not abort an ongoing download; failures back off", () =>
  withStore(
    Effect.gen(function* () {
      const { store } = yield* setup;
      yield* store.semantics.setEnabled(true);
      const started = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      let busy = false;
      let attempts = 0;
      let cancelled = false;
      const models = {
        ...fakeModels([]),
        ensure: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(finish)),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                cancelled = true;
              }),
            ),
          ),
      };
      const input = {
        store: store.media,
        markReauth: store.markReauth.bind(store),
        vision: unavailableVision,
        onBattery: () => false,
        busy: Effect.sync(() => busy),
        changed: Effect.void,
        message: (id: string) => store.getMessage(id).pipe(Effect.orDie),
        attachment: () => Effect.succeed(new Uint8Array()),
        inline: () => Effect.succeed([]),
      };
      const run = yield* makeSemanticIndexer(input, store, models);
      const task = yield* Effect.forkChild(run.batch());
      yield* Deferred.await(started);
      busy = true;
      yield* TestClock.adjust("2 seconds");
      assert.strictEqual(cancelled, false);
      yield* Deferred.succeed(finish, undefined);
      assert.strictEqual(yield* Fiber.join(task), 0);
      busy = false;
      const failing = yield* makeSemanticIndexer(input, store, {
        ...fakeModels([]),
        ensure: () =>
          Effect.sync(() => {
            attempts++;
          }).pipe(Effect.andThen(Effect.fail(new MediaError({ message: "offline models" })))),
      });
      assert.strictEqual(yield* failing.batch(), 0);
      assert.strictEqual(yield* failing.batch(), 0);
      assert.strictEqual(attempts, 1);
      yield* TestClock.adjust("60 seconds");
      yield* failing.batch();
      assert.strictEqual(attempts, 2);
    }),
  ),
);

it.effect("one process load failure never spends attempts across the backlog", () =>
  withStore(
    Effect.gen(function* () {
      const { store, account } = yield* setup;
      for (let i = 0; i < 8; i++)
        yield* store.upsertMessage(
          account.id,
          message({ providerId: `m-${i}`, threadId: `t-${i}`, date: i + 2000 }),
        );
      yield* store.semantics.setEnabled(true);
      let loads = 0;
      const base = fakeModels([]);
      const run = yield* indexer(store, {
        ...base,
        embedder: {
          ...base.embedder,
          text: () => {
            loads++;
            return Effect.fail(
              new InferenceRuntimeError({ reason: "load", message: "missing native binary" }),
            );
          },
        },
      });
      assert.strictEqual(yield* run.batch(), 0);
      assert.strictEqual(loads, 1);
      assert.strictEqual(yield* run.batch(), 0);
      assert.strictEqual(loads, 1);
      const sql = yield* SqlClient.SqlClient;
      const jobs = yield* sql`SELECT attempts,status FROM semantic_jobs`;
      assert.ok(jobs.every((job) => job.attempts === 0 && job.status === "queued"));
      yield* TestClock.adjust("60 seconds");
      yield* sql`UPDATE semantic_jobs SET retry_at=0`;
      assert.strictEqual(yield* (yield* indexer(store, base)).batch(), 2);
    }),
  ),
);

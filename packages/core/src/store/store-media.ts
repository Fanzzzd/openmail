import { PlatformCrypto } from "../platform/crypto.js";
import type { Fragment } from "effect/sql/Statement";
import { Context, Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { DerivedChunk, derivedPart } from "../media.js";
import { all, first, run } from "./sql-rows.js";

const Job = Schema.Struct({
  message_id: Schema.String,
  generation: Schema.Number,
  claim: Schema.String,
});
export type DerivedJob = typeof Job.Type;
const ChunkRow = Schema.Struct({ provenance_json: Schema.fromJsonString(DerivedChunk) });
const Counts = Schema.Struct({ status: Schema.String, count: Schema.Number });
const Paused = Schema.Struct({ value_json: Schema.fromJsonString(Schema.Boolean) });

export const MAX_MEDIA_ATTEMPTS = 5;
export function makeMediaStore(
  sql: SqlClient.SqlClient,
  vectors = false,
  table: "derived_jobs" | "semantic_jobs" = "derived_jobs",
  crypto: PlatformCrypto = Context.get(Context.empty(), PlatformCrypto),
) {
  const jobs = sql.literal(table);
  const priorityIndex = sql.literal(`${table}_priority`);
  const deleteVectorsForMessages = (predicate: Fragment) =>
    vectors
      ? Effect.gen(function* () {
          const ids = sql`SELECT i.id FROM vector_items i JOIN messages m ON m.id=i.message_id WHERE ${predicate}`;
          yield* run(sql`DELETE FROM derived_text_vectors WHERE rowid IN (${ids})`);
          yield* run(sql`DELETE FROM derived_image_vectors WHERE rowid IN (${ids})`);
        })
      : Effect.void;
  let currentVersion: string | undefined;
  const paused = first(Paused)(sql`SELECT value_json FROM prefs WHERE key='indexingPaused'`).pipe(
    Effect.map((value) => Option.isSome(value) && value.value.value_json),
  );
  const chunks = (messageId: string) =>
    all(ChunkRow)(
      sql`SELECT provenance_json FROM derived_chunks WHERE message_id=${messageId} ORDER BY id`,
    ).pipe(Effect.map((rows) => rows.map((row) => row.provenance_json)));
  const claim = Effect.fn("MediaStore.claim")(function* (
    version: string,
    now: number,
    images: boolean,
  ) {
    const token = crypto.randomUUID();
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          if (currentVersion !== version) {
            yield* run(
              sql`UPDATE ${jobs} SET status='queued',claim=NULL,claimed_at=NULL,attempts=0,retry_at=0 WHERE pipeline_version!=${version} AND status IN ('done','failed')`,
            );
          }
          yield* run(sql`UPDATE ${jobs} SET status=CASE WHEN attempts>=${MAX_MEDIA_ATTEMPTS} THEN 'failed' ELSE 'queued' END, claim=NULL, claimed_at=NULL
        WHERE status='running' AND claimed_at < ${now - 5 * 60_000}`);
          const candidate = yield* first(Schema.Struct({ message_id: Schema.String }))(
            sql`SELECT j.message_id FROM ${jobs} j INDEXED BY ${priorityIndex} CROSS JOIN messages m ON m.id=j.message_id CROSS JOIN accounts a ON a.id=m.account_id
        WHERE j.status='queued' AND j.retry_at <= ${now} AND j.attempts < ${MAX_MEDIA_ATTEMPTS} AND a.needs_reauth=0 AND a.enabled=1
        AND (${images ? 1 : 0}=1 OR (m.body_html NOT LIKE '%cid:%' AND NOT EXISTS(
          SELECT 1 FROM json_each(m.attachments_json) WHERE lower(json_extract(value,'$.mimeType')) LIKE 'image/%')))
        ORDER BY j.priority_at DESC,j.message_id LIMIT 1`,
          );
          if (Option.isNone(candidate)) return Option.none<DerivedJob>();
          return yield* first(
            Job,
          )(sql`UPDATE ${jobs} SET status='running', attempts=attempts+1, claim=${token}, claimed_at=${now}, pipeline_version=${version}
        WHERE message_id=${candidate.value.message_id} RETURNING message_id,generation,claim`);
        }),
      )
      .pipe(
        Effect.orDie,
        Effect.tap(() =>
          Effect.sync(() => {
            currentVersion = version;
          }),
        ),
      );
  });
  const complete = Effect.fn("MediaStore.complete")(function* (
    job: DerivedJob,
    result: readonly DerivedChunk[],
    note: string | null,
  ) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const owner = yield* first(Job)(sql`SELECT message_id,generation,claim FROM ${jobs}
        WHERE message_id=${job.message_id} AND claim=${job.claim} AND generation=${job.generation}`);
          if (Option.isNone(owner)) return false;
          yield* run(sql`DELETE FROM derived_chunks WHERE message_id=${job.message_id}`);
          const positions = new Map<string, number>();
          for (const chunk of result) {
            const part = derivedPart(chunk.source);
            const index = chunk.chunkIndex ?? positions.get(part) ?? 0;
            positions.set(part, Math.max(positions.get(part) ?? 0, index + 1));
            const provenance = { ...chunk, messageId: job.message_id, chunkIndex: index };
            yield* run(sql`INSERT INTO derived_chunks(message_id,text,provenance_json,chunk_index)
        VALUES(${job.message_id},${chunk.text},${JSON.stringify(provenance)},${index})`);
          }
          yield* run(
            sql`UPDATE ${jobs} SET status='done', claim=NULL, claimed_at=NULL, note=${note}, attempts=0 WHERE message_id=${job.message_id}`,
          );
          return true;
        }),
      )
      .pipe(Effect.orDie);
  });
  const retry = (job: DerivedJob, now: number) =>
    run(sql`UPDATE ${jobs} SET
    status=CASE WHEN attempts>=${MAX_MEDIA_ATTEMPTS} THEN 'failed' ELSE 'queued' END, retry_at=${now + 60_000}, claim=NULL, claimed_at=NULL, note='Media extraction failed'
    WHERE message_id=${job.message_id} AND generation=${job.generation} AND claim=${job.claim}`);
  const release = (job: DerivedJob, retryAt = 0) =>
    run(sql`UPDATE ${jobs} SET status='queued',claim=NULL,claimed_at=NULL, attempts=MAX(0,attempts-1), retry_at=${retryAt}
    WHERE message_id=${job.message_id} AND generation=${job.generation} AND claim=${job.claim}`);
  const counts = all(Counts)(
    sql`SELECT status,COUNT(*) AS count FROM ${jobs} GROUP BY status`,
  ).pipe(
    Effect.map((rows) => {
      const count = (status: string) => rows.find((row) => row.status === status)?.count ?? 0;
      return {
        queued: count("queued"),
        running: count("running"),
        done: count("done"),
        failed: count("failed"),
      };
    }),
  );
  return {
    vectors,
    deleteVectorsForMessages,
    deferFetch: (job: DerivedJob, now: number) => release(job, now + 60_000),
    paused,
    chunks,
    claim,
    complete,
    retry,
    release,
    counts,
    renew: (job: DerivedJob, now: number) =>
      run(
        sql`UPDATE ${jobs} SET claimed_at=${now} WHERE message_id=${job.message_id} AND claim=${job.claim}`,
      ),
    setPaused: (value: boolean) =>
      run(sql`INSERT INTO prefs(key,value_json) VALUES('indexingPaused',${JSON.stringify(value)})
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json`),
  };
}

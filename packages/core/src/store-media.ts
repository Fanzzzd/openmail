import { Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { DerivedChunk } from "./media.js";
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

export function makeMediaStore(sql: SqlClient.SqlClient) {
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
          yield* run(sql`UPDATE derived_jobs SET status='queued', claim=NULL, claimed_at=NULL, attempts=0, retry_at=0
        WHERE pipeline_version != ${version} AND status IN ('done','failed')`);
          yield* run(sql`UPDATE derived_jobs SET status='queued', claim=NULL, claimed_at=NULL
        WHERE status='running' AND claimed_at < ${now - 5 * 60_000}`);
          const candidate = yield* first(Schema.Struct({ message_id: Schema.String }))(
            sql`SELECT j.message_id FROM derived_jobs j JOIN messages m ON m.id=j.message_id
        WHERE j.status='queued' AND j.retry_at <= ${now}
        AND (${images ? 1 : 0}=1 OR (m.body_html NOT LIKE '%cid:%' AND NOT EXISTS(
          SELECT 1 FROM json_each(m.attachments_json) WHERE lower(json_extract(value,'$.mimeType')) LIKE 'image/%')))
        ORDER BY j.retry_at, m.date DESC LIMIT 1`,
          );
          if (Option.isNone(candidate)) return Option.none<DerivedJob>();
          return yield* first(
            Job,
          )(sql`UPDATE derived_jobs SET status='running', claim=${token}, claimed_at=${now}, pipeline_version=${version}
        WHERE message_id=${candidate.value.message_id} RETURNING message_id,generation,claim`);
        }),
      )
      .pipe(Effect.orDie);
  });
  const complete = Effect.fn("MediaStore.complete")(function* (
    job: DerivedJob,
    result: readonly DerivedChunk[],
    note: string | null,
  ) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const owner = yield* first(Job)(sql`SELECT message_id,generation,claim FROM derived_jobs
        WHERE message_id=${job.message_id} AND claim=${job.claim} AND generation=${job.generation}`);
          if (Option.isNone(owner)) return false;
          yield* run(sql`DELETE FROM derived_chunks WHERE message_id=${job.message_id}`);
          for (const chunk of result)
            yield* run(sql`INSERT INTO derived_chunks(message_id,text,provenance_json)
        VALUES(${job.message_id},${chunk.text},${JSON.stringify(chunk)})`);
          yield* run(
            sql`UPDATE derived_jobs SET status='done', claim=NULL, claimed_at=NULL, note=${note}, attempts=0 WHERE message_id=${job.message_id}`,
          );
          return true;
        }),
      )
      .pipe(Effect.orDie);
  });
  const retry = (job: DerivedJob, now: number) =>
    run(sql`UPDATE derived_jobs SET
    status=CASE WHEN attempts>=4 THEN 'failed' ELSE 'queued' END,
    attempts=attempts+1, retry_at=${now + 60_000}, claim=NULL, claimed_at=NULL, note='Media extraction failed'
    WHERE message_id=${job.message_id} AND generation=${job.generation} AND claim=${job.claim}`);
  const release = (job: DerivedJob) =>
    run(sql`UPDATE derived_jobs SET status='queued',claim=NULL,claimed_at=NULL
    WHERE message_id=${job.message_id} AND claim=${job.claim}`);
  const counts = all(Counts)(
    sql`SELECT status,COUNT(*) AS count FROM derived_jobs GROUP BY status`,
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
    paused,
    chunks,
    claim,
    complete,
    retry,
    release,
    counts,
    renew: (job: DerivedJob, now: number) =>
      run(
        sql`UPDATE derived_jobs SET claimed_at=${now} WHERE message_id=${job.message_id} AND claim=${job.claim}`,
      ),
    setPaused: (value: boolean) =>
      run(sql`INSERT INTO prefs(key,value_json) VALUES('indexingPaused',${JSON.stringify(value)})
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json`),
  };
}

import { SEMANTIC_MAX_DISTANCE } from "./semantic-distance.js";
import type { ThreadQuery } from "./domain.js";
import type { Fragment } from "effect/sql/Statement";
import { Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { DerivedChunk, type VectorItem } from "./media.js";
import { makeMediaStore, type DerivedJob } from "./store-media.js";
import { all, first, run } from "./sql-rows.js";

const Flag = Schema.Struct({ value_json: Schema.fromJsonString(Schema.Boolean) });
export function makeSemanticStore(
  sql: SqlClient.SqlClient,
  vectors: boolean,
  filter: (query: ThreadQuery) => Fragment,
) {
  const queue = makeMediaStore(sql, vectors, "semantic_jobs");
  const enabled = first(Flag)(sql`SELECT value_json FROM prefs WHERE key='onDeviceModels'`).pipe(
    Effect.map((row) => Option.isSome(row) && row.value.value_json),
  );
  const complete = (job: DerivedJob, items: readonly VectorItem[], version: string) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const owner = yield* first(Schema.Struct({ message_id: Schema.String }))(
            sql`SELECT message_id FROM semantic_jobs WHERE message_id=${job.message_id} AND generation=${job.generation} AND claim=${job.claim}`,
          );
          if (Option.isNone(owner)) return false;
          yield* queue.deleteVectorsForMessages(sql`m.id=${job.message_id}`);
          yield* run(sql`DELETE FROM vector_items WHERE message_id=${job.message_id}`);
          for (const item of items) {
            const [row] = yield* all(
              Schema.Struct({ id: Schema.Number }),
            )(sql`INSERT INTO vector_items(message_id,kind,version,provenance_json)
        VALUES(${job.message_id},${item.kind},${version},${JSON.stringify(item.provenance)}) RETURNING id`);
            if (!row) return yield* Effect.die(new Error("Vector item insert failed"));
            const data = new Uint8Array(new Float32Array(item.vector).buffer);
            yield* run(
              item.kind === "text"
                ? sql`INSERT INTO derived_text_vectors(rowid,embedding) VALUES(${BigInt(row.id)},${data})`
                : sql`INSERT INTO derived_image_vectors(rowid,embedding) VALUES(${BigInt(row.id)},${data})`,
            );
          }
          yield* run(
            sql`UPDATE semantic_jobs SET status='done',claim=NULL,claimed_at=NULL,attempts=0,note=NULL WHERE message_id=${job.message_id}`,
          );
          return true;
        }),
      )
      .pipe(Effect.orDie);
  const neighbors = (
    kind: "text" | "image",
    vector: readonly number[],
    version: string,
    query: ThreadQuery = {},
  ) => {
    const table = sql.literal(kind === "text" ? "derived_text_vectors" : "derived_image_vectors");
    return all(
      Schema.Struct({
        provenance_json: Schema.fromJsonString(DerivedChunk),
        distance: Schema.Number,
      }),
    )(
      sql`SELECT i.provenance_json,v.distance FROM ${table} v JOIN vector_items i ON i.id=v.rowid
        WHERE v.embedding MATCH ${new Uint8Array(new Float32Array(vector).buffer)} AND v.k=200 AND v.rowid IN (
          SELECT item.id FROM vector_items item JOIN messages m ON m.id=item.message_id
          WHERE item.version=${version} AND ${filter(query)}
          AND (${query.criteria?.attachmentText ? 1 : 0}=0 OR json_extract(item.provenance_json,'$.source.kind')!='body')
        ) AND v.distance <= ${SEMANTIC_MAX_DISTANCE[kind]} ORDER BY v.distance`,
    ).pipe(Effect.map((rows) => rows.map((row) => row.provenance_json)));
  };
  return {
    vectors,
    enabled,
    complete,
    neighbors,
    claim: queue.claim,
    retry: queue.retry,
    release: queue.release,
    deferFetch: queue.deferFetch,
    renew: queue.renew,
    counts: queue.counts,
    setEnabled: (value: boolean) =>
      run(
        sql`INSERT INTO prefs(key,value_json) VALUES('onDeviceModels',${JSON.stringify(value)}) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json`,
      ),
  };
}

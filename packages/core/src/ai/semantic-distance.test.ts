import { assert, it } from "@effect/vitest";
import { readFileSync } from "node:fs";
import { Schema } from "effect";
import { SEMANTIC_MAX_DISTANCE } from "./semantic-distance.js";
const Query = Schema.Struct({
  expected: Schema.String,
  ranking: Schema.Array(Schema.Struct({ id: Schema.String, score: Schema.Number })),
});
const Scores = Schema.Struct({
  e5: Schema.Struct({ queries: Schema.Array(Query) }),
  clip: Schema.Struct({ queries: Schema.Array(Query) }),
});
it("cutoffs retain spike text positives and confident image positives instead of padding every route", () => {
  const spike = Schema.decodeUnknownSync(Schema.fromJsonString(Scores))(
    readFileSync(
      new URL("../../../../spikes/media/artifacts/embeddings-hybrid.json", import.meta.url),
      "utf8",
    ),
  );
  const kept = (queries: typeof spike.e5.queries, cutoff: number) =>
    queries.reduce(
      (sum, query) =>
        sum +
        (query.ranking.some(
          (row) => row.id === query.expected && Math.sqrt(2 - 2 * row.score) <= cutoff,
        )
          ? 1
          : 0),
      0,
    );
  assert.strictEqual(kept(spike.e5.queries, SEMANTIC_MAX_DISTANCE.text), 8);
  assert.strictEqual(kept(spike.clip.queries, SEMANTIC_MAX_DISTANCE.image), 3);
  assert.ok(SEMANTIC_MAX_DISTANCE.text < Math.SQRT2);
  assert.ok(SEMANTIC_MAX_DISTANCE.image < Math.SQRT2);
});

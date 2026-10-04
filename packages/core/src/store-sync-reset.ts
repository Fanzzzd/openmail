import { Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import type { Fragment } from "effect/sql/Statement";
import { all, first, run } from "./sql-rows.js";
import { ResetCandidate, type ResetChange } from "./sync-reset.js";
import type { ImapFolderIdentity } from "./services.js";

const StaleSweepState = Schema.Struct({
  checkedAt: Schema.Number,
  after: Schema.String,
  verified: Schema.optionalKey(Schema.Record(Schema.String, Schema.Number)),
});
const VERIFIED_TTL = 86_400_000;
const pruneVerified = (verified: typeof StaleSweepState.Type.verified, now: number) =>
  Object.fromEntries(Object.entries(verified ?? {}).filter(([, at]) => now - at < VERIFIED_TTL));
const staleKey = (account: string) => `sync-stale:${account}`;
const key = (account: string) => `sync-reset:${account}`;

export function makeSyncResetStore(
  sql: SqlClient.SqlClient,
  hasLabel: (label: string) => Fragment,
  imapFolder: (folder: ImapFolderIdentity) => Fragment,
) {
  const pendingResetCandidates = (account: string) =>
    first(
      Schema.Struct({
        value_json: Schema.fromJsonString(Schema.Array(ResetCandidate)),
      }),
    )(sql`SELECT value_json FROM prefs WHERE key=${key(account)}`).pipe(
      Effect.map((row) => (Option.isSome(row) ? row.value.value_json : [])),
    );
  return {
    pendingResetCandidates,
    claimStaleSweep: (account: string, now: number) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const row = yield* first(
              Schema.Struct({ value_json: Schema.fromJsonString(StaleSweepState) }),
            )(sql`SELECT value_json FROM prefs WHERE key=${staleKey(account)}`);
            if (Option.isSome(row) && now - row.value.value_json.checkedAt < 3_600_000)
              return Option.none<typeof StaleSweepState.Type>();
            const state = {
              checkedAt: now,
              after: Option.isSome(row) ? row.value.value_json.after : "",
              verified: pruneVerified(
                Option.isSome(row) ? row.value.value_json.verified : undefined,
                now,
              ),
            };
            yield* run(
              sql`INSERT INTO prefs(key,value_json) VALUES(${staleKey(account)},${JSON.stringify(state)}) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json`,
            );
            return Option.some(state);
          }),
        )
        .pipe(Effect.orDie),
    saveStaleSweepPosition: (account: string, after: string) =>
      run(
        sql`UPDATE prefs SET value_json=json_set(value_json,'$.after',${after}) WHERE key=${staleKey(account)}`,
      ),
    saveStaleSweepVerified: (account: string, fingerprints: readonly string[], now: number) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const row = yield* first(
              Schema.Struct({ value_json: Schema.fromJsonString(StaleSweepState) }),
            )(sql`SELECT value_json FROM prefs WHERE key=${staleKey(account)}`);
            if (Option.isNone(row)) return;
            const state = row.value.value_json;
            const verified = pruneVerified(state.verified, now);
            for (const fingerprint of fingerprints) verified[fingerprint] = now;
            yield* run(
              sql`UPDATE prefs SET value_json=${JSON.stringify({ ...state, verified })} WHERE key=${staleKey(account)}`,
            );
          }),
        )
        .pipe(Effect.orDie),
    staleCandidates: (
      account: string,
      scopes: readonly string[],
      imap: boolean,
      after: string,
      limit: number,
    ) => {
      const path = sql.literal(
        "substr(m.provider_id, instr(m.provider_id, ':') + instr(substr(m.provider_id, instr(m.provider_id, ':') + 1), ':') + 1)",
      );
      const Candidate = Schema.Struct({
        ...ResetCandidate.fields,
        draftOnly: Schema.BooleanFromBit,
        labels: Schema.fromJsonString(Schema.Array(Schema.String)),
      });
      // The old boolean ORDER BY sorted the entire account on every page.
      // Seek each indexed source, merge its bounded page, then wrap only if needed.
      const page = (wrap: boolean, size: number) =>
        Effect.gen(function* () {
          const messageScopes = imap
            ? [...new Set(scopes)].map((scope) => sql`${path}=${scope}`)
            : [
                sql`EXISTS(SELECT 1 FROM json_each(m.labels_json) WHERE value IN ${sql.in(scopes)})`,
              ];
          const rows: (typeof Candidate.Type)[] = [];
          for (const within of messageScopes) {
            rows.push(
              ...(yield* all(Candidate)(sql`
            SELECT m.provider_id AS providerId,m.rfc_message_id AS rfcMessageId,m.labels_json AS labels,0 AS draftOnly
            FROM messages m WHERE m.account_id=${account} AND ${within}
              AND ${wrap ? sql`m.provider_id<=${after}` : sql`m.provider_id>${after}`}
            ORDER BY m.provider_id LIMIT ${size}`)),
            );
          }
          if (scopes.includes("DRAFT") && !imap)
            rows.push(
              ...(yield* all(Candidate)(sql`
            SELECT DISTINCT d.remote_message_id AS providerId,NULL AS rfcMessageId,'["DRAFT"]' AS labels,1 AS draftOnly
            FROM drafts d WHERE d.account_id=${account} AND d.remote_message_id IS NOT NULL AND d.local_only=0 AND d.sync_error IS NULL
              AND ${wrap ? sql`d.remote_message_id<=${after}` : sql`d.remote_message_id>${after}`}
              AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.account_id=d.account_id AND m.provider_id=d.remote_message_id)
            ORDER BY d.remote_message_id LIMIT ${size}`)),
            );
          // SQLite BINARY compares UTF-8 bytes, including supplementary characters.
          const encoder = new TextEncoder();
          return rows
            .map((row) => ({ row, key: encoder.encode(row.providerId) }))
            .toSorted((a, b) => {
              for (let i = 0; i < Math.min(a.key.length, b.key.length); i++) {
                const difference = (a.key[i] ?? 0) - (b.key[i] ?? 0);
                if (difference) return difference;
              }
              return a.key.length - b.key.length;
            })
            .slice(0, size)
            .map(({ row }) => row);
        });
      return Effect.gen(function* () {
        if (!scopes.length || limit === 0) return [];
        const rows = yield* page(false, limit);
        if (rows.length < limit) rows.push(...(yield* page(true, limit - rows.length)));
        return rows;
      });
    },
    saveResetCandidates: (account: string, candidates: readonly ResetCandidate[]) =>
      candidates.length
        ? run(
            sql`INSERT INTO prefs(key,value_json) VALUES(${key(account)},${JSON.stringify(candidates)}) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json`,
          )
        : run(sql`DELETE FROM prefs WHERE key=${key(account)}`),
    resetCandidates: (account: string, change: ResetChange) =>
      Effect.gen(function* () {
        const folderScope =
          change._tag === "DeleteLabel"
            ? hasLabel(change.label)
            : change._tag === "RebuildFolder"
              ? imapFolder(change.previous)
              : sql.literal("1");
        const scope =
          change.since === undefined
            ? folderScope
            : sql`${folderScope} AND m.date>=${change.since}`;
        const rows = yield* all(
          Schema.Struct({
            providerId: Schema.String,
            rfcMessageId: Schema.NullOr(Schema.String),
            labels: Schema.fromJsonString(Schema.Array(Schema.String)),
          }),
        )(
          sql`SELECT provider_id AS providerId,rfc_message_id AS rfcMessageId,labels_json AS labels FROM messages AS m WHERE m.account_id=${account} AND ${scope}`,
        );
        const keep = new Set(change.keep ?? []);
        const swept =
          change._tag === "RebuildFolder" && change.candidates
            ? new Set(change.candidates)
            : undefined;
        return {
          local: rows.length,
          candidates: rows.filter(
            (row) => !keep.has(row.providerId) && (!swept || swept.has(row.providerId)),
          ),
        };
      }),
  };
}

import { Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import {
  AiAccountSettings,
  AiModelName,
  AiSummary,
  AiTriageContent,
  type AiTriage,
} from "../ai/ai.js";

const decode =
  <S extends Schema.Constraint>(schema: S) =>
  (rows: readonly unknown[]) =>
    Schema.decodeUnknownEffect(Schema.Array(schema))(rows).pipe(Effect.orDie);
const run = (query: Effect.Effect<unknown, unknown>) => query.pipe(Effect.orDie, Effect.asVoid);
export function makeAiStore(sql: SqlClient.SqlClient) {
  return {
    accounts: sql`SELECT a.id AS accountId, COALESCE(s.allowed,0)=1 AS allowed,
      COALESCE(s.auto_summaries,0)=1 AS autoSummaries, COALESCE(s.auto_triage,0)=1 AS autoTriage FROM accounts a
      LEFT JOIN ai_accounts s ON a.id=s.account_id`.pipe(
      Effect.flatMap(
        decode(
          Schema.Struct({
            accountId: Schema.String,
            allowed: Schema.Number,
            autoSummaries: Schema.Number,
            autoTriage: Schema.Number,
          }),
        ),
      ),
      Effect.map((rows) =>
        rows.map((r) => ({
          ...r,
          allowed: r.allowed === 1,
          autoSummaries: r.autoSummaries === 1,
          autoTriage: r.autoTriage === 1,
        })),
      ),
      Effect.orDie,
    ),
    setAccount: (input: AiAccountSettings) =>
      run(sql`INSERT INTO ai_accounts(account_id,allowed,auto_summaries,auto_triage)
      VALUES(${input.accountId},${input.allowed ? 1 : 0},${input.allowed && input.autoSummaries ? 1 : 0},${input.allowed && input.autoTriage ? 1 : 0})
      ON CONFLICT(account_id) DO UPDATE SET allowed=excluded.allowed, auto_summaries=excluded.auto_summaries,auto_triage=excluded.auto_triage`),
    model: sql`SELECT model FROM ai_config WHERE id=1`.pipe(
      Effect.flatMap(decode(Schema.Struct({ model: AiModelName }))),
      Effect.map((rows) => rows[0]?.model ?? "claude-sonnet-5-5"),
      Effect.orDie,
    ),
    setModel: (model: AiModelName) =>
      run(
        sql`INSERT INTO ai_config(id,model) VALUES(1,${model}) ON CONFLICT(id) DO UPDATE SET model=excluded.model`,
      ),
    summary: (threadId: string) =>
      sql`SELECT thread_id AS threadId,model,prompt_version AS promptVersion,
      input_hash AS inputHash,text FROM derived WHERE thread_id=${threadId} AND kind='summary'`.pipe(
        Effect.flatMap(decode(AiSummary)),
        Effect.map((rows) => Option.fromNullishOr(rows[0])),
        Effect.orDie,
      ),
    putSummary: (accountId: string, summary: AiSummary) =>
      run(sql`INSERT INTO derived(account_id,thread_id,kind,model,prompt_version,input_hash,text)
      VALUES(${accountId},${summary.threadId},'summary',${summary.model},${summary.promptVersion},${summary.inputHash},${summary.text})
      ON CONFLICT(thread_id,kind) DO UPDATE SET model=excluded.model,prompt_version=excluded.prompt_version,input_hash=excluded.input_hash,text=excluded.text`),
    deleteSummary: (threadId: string) =>
      run(sql`DELETE FROM derived WHERE thread_id=${threadId} AND kind='summary'`),
    triage: (threadId: string) =>
      sql`SELECT thread_id AS threadId,model,prompt_version AS promptVersion,input_hash AS inputHash,text FROM derived WHERE thread_id=${threadId} AND kind='triage'`.pipe(
        Effect.flatMap(decode(AiSummary)),
        Effect.flatMap((rows) => {
          const row = rows[0];
          return row
            ? Schema.decodeUnknownEffect(Schema.fromJsonString(AiTriageContent))(row.text).pipe(
                Effect.map((content) => Option.some({ ...row, ...content })),
              )
            : Effect.succeed(Option.none<AiTriage>());
        }),
        Effect.orDie,
      ),
    putTriage: (accountId: string, row: AiTriage) =>
      run(sql`INSERT INTO derived(account_id,thread_id,kind,model,prompt_version,input_hash,text)
      VALUES(${accountId},${row.threadId},'triage',${row.model},${row.promptVersion},${row.inputHash},${JSON.stringify({ action: row.action, reason: row.reason, status: row.status })})
      ON CONFLICT(thread_id,kind) DO UPDATE SET model=excluded.model,prompt_version=excluded.prompt_version,input_hash=excluded.input_hash,text=excluded.text`),
    deleteTriage: (threadId: string) =>
      run(sql`DELETE FROM derived WHERE thread_id=${threadId} AND kind='triage'`),
    deleteAccountTriage: (accountId: string) =>
      run(sql`DELETE FROM derived WHERE account_id=${accountId} AND kind='triage'`),
    /**
     * Counts one automatic summary against `day`'s cap. False once `cap` were claimed that day;
     * a new day starts again at one. One statement, so app windows and processes share the count.
     */
    claimAutoSummary: (day: string, cap: number) =>
      sql`INSERT INTO prefs(key,value_json) VALUES('ai-auto-summaries',json_object('day',${day},'count',1))
      ON CONFLICT(key) DO UPDATE SET value_json=CASE WHEN json_extract(value_json,'$.day')=${day}
        THEN json_object('day',${day},'count',json_extract(value_json,'$.count')+1)
        ELSE json_object('day',${day},'count',1) END
      WHERE json_extract(value_json,'$.day') IS NOT ${day} OR json_extract(value_json,'$.count')<${cap}
      RETURNING value_json`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orDie,
      ),
    deleteAccountResults: (accountId: string) =>
      run(sql`DELETE FROM derived WHERE account_id=${accountId}`),
  };
}

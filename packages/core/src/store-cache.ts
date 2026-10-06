import { makeCompactionStore } from "./store-compaction.js";
import { Clock, Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { BackfillState, type CacheWindowInput, DEFAULT_CACHE_WINDOWS, keepBody } from "./cache.js";
import { all, first, run } from "./sql-rows.js";

const WindowRow = Schema.Struct({
  account_id: Schema.String,
  label: Schema.String,
  days: Schema.NullOr(Schema.Number),
});
const StateRow = Schema.Struct({
  account_id: Schema.String,
  cursor: Schema.NullOr(Schema.String),
  before_date: Schema.Number,
  fetched: Schema.Number,
  paused: Schema.BooleanFromBit,
  done: Schema.BooleanFromBit,
  last_error: Schema.NullOr(Schema.String),
  next_run_at: Schema.Number,
});
const toState = (r: typeof StateRow.Type): BackfillState => ({
  accountId: r.account_id,
  cursor: r.cursor,
  before: r.before_date,
  fetched: r.fetched,
  paused: r.paused,
  done: r.done,
  lastError: r.last_error,
  nextRunAt: r.next_run_at,
});

export function makeCacheStore(
  sql: SqlClient.SqlClient,
  maintenance: import("./platform/cache-storage.js").CacheMaintenanceService,
) {
  const cacheWindows = all(WindowRow)(sql`SELECT * FROM cache_windows`).pipe(
    Effect.map((rows) =>
      rows.map((r) => ({ accountId: r.account_id, label: r.label, days: r.days })),
    ),
  );
  const setCacheWindow = (w: CacheWindowInput) =>
    w.days === undefined
      ? run(sql`DELETE FROM cache_windows WHERE account_id=${w.accountId} AND label=${w.label}`)
      : run(sql`INSERT INTO cache_windows VALUES (${w.accountId}, ${w.label}, ${w.days})
    ON CONFLICT(account_id,label) DO UPDATE SET days=excluded.days`);
  const windowsFor = (account: string) =>
    cacheWindows.pipe(
      Effect.map((windows) => {
        const custom = windows.filter((w) => w.accountId === account);
        return [
          ...DEFAULT_CACHE_WINDOWS.filter((w) => !custom.some((c) => c.label === w.label)),
          ...custom,
        ];
      }),
    );
  const BodyRow = Schema.Struct({
    id: Schema.String,
    date: Schema.Number,
    is_starred: Schema.BooleanFromBit,
    labels_json: Schema.fromJsonString(Schema.Array(Schema.String)),
  });
  const touchBody = (id: string, now: number) =>
    run(sql`UPDATE messages SET body_opened_at=${now} WHERE id=${id}`);
  const Maintenance = Schema.Struct({ evicted_at: Schema.Number });
  const evictBodies = Effect.fn("Store.evictBodies")(function* (
    account: string,
    now: number,
    force = false,
  ) {
    const last = yield* first(Maintenance)(
      sql`SELECT evicted_at FROM cache_maintenance WHERE account_id=${account}`,
    );
    if (!force && Option.isSome(last) && last.value.evicted_at > now - 86_400_000) return 0;
    const windows = yield* windowsFor(account);
    const finite = windows.flatMap((w) => (w.days === null ? [] : [w.days]));
    const cutoff = now - Math.min(...finite) * 86_400_000;
    let cursor: { date: number; id: string } | undefined;
    let evicted = 0;
    if (finite.length)
      for (;;) {
        const rows = yield* all(BodyRow)(sql`SELECT id,date,is_starred,labels_json FROM messages
        WHERE account_id=${account} AND body_cached=1 AND is_starred=0 AND date < ${cutoff}
          AND NOT EXISTS (SELECT 1 FROM drafts WHERE account_id=messages.account_id AND remote_message_id=messages.provider_id)
          AND (body_opened_at IS NULL OR body_opened_at < ${now - 86_400_000})
          ${cursor ? sql`AND (date > ${cursor.date} OR (date=${cursor.date} AND id > ${cursor.id}))` : sql.literal("")}
        ORDER BY date,id LIMIT 200`);
        if (!rows.length) break;
        const ids = rows
          .filter(
            (r) =>
              !keepBody(
                { date: r.date, labels: r.labels_json, isStarred: r.is_starred },
                windows,
                now,
              ),
          )
          .map((r) => r.id);
        if (ids.length) {
          yield* run(
            sql`UPDATE messages SET body_text='',body_html='',body_cached=0 WHERE id IN ${sql.in(ids)}`,
          );
          evicted += ids.length;
        }
        const tail = rows.at(-1);
        if (tail) cursor = { date: tail.date, id: tail.id };
      }
    yield* run(sql`INSERT INTO cache_maintenance VALUES (${account},${now})
      ON CONFLICT(account_id) DO UPDATE SET evicted_at=excluded.evicted_at`);
    return evicted;
  });
  const ProviderId = Schema.Struct({ provider_id: Schema.String });
  const backfillCandidates = Effect.fn("Store.backfillCandidates")(function* (
    account: string,
    ids: readonly string[],
  ) {
    if (!ids.length) return [];
    const cached = yield* all(ProviderId)(
      sql`SELECT provider_id FROM messages WHERE account_id=${account} AND provider_id IN ${sql.in(ids)}`,
    );
    const pending = yield* all(
      ProviderId,
    )(sql`SELECT provider_id FROM pending_ops WHERE account_id=${account}
      UNION SELECT json_extract(op_json,'$.remote.messageId') AS provider_id FROM pending_ops
        WHERE account_id=${account} AND json_extract(op_json,'$.remote.messageId') IS NOT NULL`);
    const excluded = new Set([...cached, ...pending].map((r) => r.provider_id));
    return ids.filter((id) => !excluded.has(id));
  });
  const backfillStates = all(StateRow)(sql`SELECT * FROM backfill ORDER BY account_id`).pipe(
    Effect.map((rows) => rows.map(toState)),
  );
  const getBackfillState = Effect.fn("Store.getBackfillState")(function* (accountId: string) {
    const now = yield* Clock.currentTimeMillis;
    yield* run(
      sql`INSERT INTO backfill(account_id,before_date) VALUES (${accountId},COALESCE((SELECT MIN(date) FROM messages WHERE account_id=${accountId}),${now})) ON CONFLICT(account_id) DO NOTHING`,
    );
    yield* run(
      sql`UPDATE backfill SET before_date=COALESCE((SELECT MIN(date) FROM messages WHERE account_id=${accountId}),before_date) WHERE account_id=${accountId} AND cursor IS NULL`,
    );
    const row = yield* first(StateRow)(sql`SELECT * FROM backfill WHERE account_id=${accountId}`);
    return toState(Option.getOrThrow(row));
  });
  const saveBackfillState = (s: BackfillState) =>
    run(sql`UPDATE backfill SET cursor=${s.cursor}, before_date=${s.before},
    fetched=${s.fetched},done=${s.done ? 1 : 0},last_error=${s.lastError},next_run_at=${s.nextRunAt} WHERE account_id=${s.accountId}`);
  const resetBackfill = (accountId: string) =>
    run(
      sql`UPDATE backfill SET cursor=NULL,fetched=0,done=0,last_error=NULL,next_run_at=0 WHERE account_id=${accountId}`,
    );
  const setBackfillPaused = Effect.fn("Store.setBackfillPaused")(function* (
    accountId: string,
    paused: boolean,
  ) {
    yield* getBackfillState(accountId);
    yield* run(
      sql`UPDATE backfill SET paused=${paused ? 1 : 0},next_run_at=0,last_error=NULL WHERE account_id=${accountId}`,
    );
  });
  const bodySizes = all(Schema.Struct({ account_id: Schema.String, bytes: Schema.Number }))(
    sql`SELECT account_id, COALESCE(SUM(body_bytes),0) AS bytes FROM messages GROUP BY account_id`,
  ).pipe(Effect.map((rows) => rows.map((r) => ({ accountId: r.account_id, bytes: r.bytes }))));
  const Budget = Schema.Struct({
    total_bytes: Schema.Number,
    evicted_at: Schema.NullOr(Schema.Number),
  });
  const Candidate = Schema.Struct({
    id: Schema.String,
    account_id: Schema.String,
    date: Schema.Number,
    body_bytes: Schema.Number,
    is_starred: Schema.BooleanFromBit,
    labels_json: Schema.fromJsonString(Schema.Array(Schema.String)),
    opened_at: Schema.Number,
  });
  const evictBodyBudget = Effect.fn("Store.evictBodyBudget")(function* (
    maxBytes: number,
    force = false,
    enabled = maxBytes > 0,
  ) {
    // Zero means no budget. Retention windows still govern the daily expiry pass.
    if (!enabled) return 0;
    const now = yield* Clock.currentTimeMillis;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const budget = Option.getOrThrow(
            yield* first(Budget)(
              sql`SELECT total_bytes,evicted_at FROM body_cache_budget WHERE id=1`,
            ),
          );
          if (!force && budget.evicted_at !== null && budget.evicted_at > now - 3_600_000) return 0;
          const custom = yield* cacheWindows;
          const effective = new Map<string, ReturnType<typeof DEFAULT_CACHE_WINDOWS.slice>>();
          let remaining = budget.total_bytes;
          let count = 0;
          let cursor: { time: number; id: string } | undefined;
          while (remaining > maxBytes) {
            const rows = yield* all(
              Candidate,
            )(sql`SELECT id,account_id,date,body_bytes,is_starred,labels_json,COALESCE(body_opened_at,date) AS opened_at FROM messages
          WHERE body_cached=1 AND body_bytes>0 AND is_starred=0
            AND NOT EXISTS(SELECT 1 FROM drafts WHERE drafts.account_id=messages.account_id AND drafts.remote_message_id=messages.provider_id)
            ${cursor ? sql`AND COALESCE(body_opened_at,date)>=${cursor.time} AND (COALESCE(body_opened_at,date),id)>(${cursor.time},${cursor.id})` : sql.literal("")}
          ORDER BY COALESCE(body_opened_at,date),id LIMIT 100`);
            if (!rows.length) break;
            const ids: string[] = [];
            for (const row of rows) {
              if (remaining <= maxBytes) break;
              let windows = effective.get(row.account_id);
              if (!windows) {
                const accountWindows = custom.filter(
                  (window) => window.accountId === row.account_id,
                );
                windows = [
                  ...DEFAULT_CACHE_WINDOWS.filter(
                    (window) => !accountWindows.some((entry) => entry.label === window.label),
                  ),
                  ...accountWindows,
                ];
                effective.set(row.account_id, windows);
              }
              if (
                keepBody(
                  { date: row.date, labels: row.labels_json, isStarred: row.is_starred },
                  windows,
                  now,
                )
              )
                continue;
              ids.push(row.id);
              remaining -= row.body_bytes;
            }
            if (ids.length) {
              yield* run(
                sql`UPDATE messages SET body_text='',body_html='',body_cached=0 WHERE id IN ${sql.in(ids)}`,
              );
              count += ids.length;
            }
            const last = rows.at(-1);
            if (last) cursor = { time: last.opened_at, id: last.id };
          }
          yield* run(sql`UPDATE body_cache_budget SET evicted_at=${now} WHERE id=1`);
          return count;
        }),
      )
      .pipe(Effect.orDie);
  });
  const cacheDatabaseFile = first(Schema.Struct({ file: Schema.String }))(
    sql`SELECT file FROM pragma_database_list WHERE name='main'`,
  ).pipe(Effect.map((row) => (Option.isSome(row) ? row.value.file : "")));
  const cacheNeedsVacuum = first(Schema.Struct({ auto_vacuum: Schema.Number }))(
    sql`PRAGMA auto_vacuum`,
  ).pipe(Effect.map((row) => Option.isSome(row) && row.value.auto_vacuum === 0));
  const cacheDatabaseSize = Effect.gen(function* () {
    const pageSize = yield* first(Schema.Struct({ page_size: Schema.Number }))(
      sql`PRAGMA page_size`,
    );
    const pageCount = yield* first(Schema.Struct({ page_count: Schema.Number }))(
      sql`PRAGMA page_count`,
    );
    const freePages = yield* first(Schema.Struct({ freelist_count: Schema.Number }))(
      sql`PRAGMA freelist_count`,
    );
    const bytes = Option.getOrThrow(pageSize).page_size;
    return {
      totalBytes: bytes * Option.getOrThrow(pageCount).page_count,
      reusableBytes: bytes * Option.getOrThrow(freePages).freelist_count,
    };
  });
  const clearBodies = (accountId: string) =>
    run(
      sql`UPDATE messages SET body_text='',body_html='',body_cached=0,body_opened_at=NULL WHERE account_id=${accountId} AND NOT EXISTS (SELECT 1 FROM json_each(messages.labels_json) WHERE value='DRAFT')`,
    );
  return {
    ...makeCompactionStore(sql, maintenance),
    cachedBodyBytes: first(Schema.Struct({ total_bytes: Schema.Number }))(
      sql`SELECT total_bytes FROM body_cache_budget WHERE id=1`,
    ).pipe(Effect.map((row) => Option.getOrThrow(row).total_bytes)),
    cacheDatabaseFile,
    cacheNeedsVacuum,
    evictBodyBudget,
    cacheDatabaseSize,
    bodySizes,
    clearBodies,
    cacheWindows,
    setCacheWindow,
    evictBodies,
    touchBody,
    backfillCandidates,
    backfillStates,
    getBackfillState,
    saveBackfillState,
    setBackfillPaused,
    resetBackfill,
  };
}

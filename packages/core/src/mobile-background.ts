import { Effect, Layer, Option, Schema, Context, Clock } from "effect";
import { SqlClient } from "effect/sql";
import { all, run } from "./sql-rows.js";

export const MobileBackgroundPreferences = Schema.Struct({
  refresh: Schema.Boolean,
  badge: Schema.Boolean,
  hideContent: Schema.Boolean,
  accounts: Schema.Array(Schema.String),
});
export type MobileBackgroundPreferences = typeof MobileBackgroundPreferences.Type;
export const DEFAULT_MOBILE_BACKGROUND: MobileBackgroundPreferences = {
  refresh: false,
  badge: false,
  hideContent: true,
  accounts: [],
};
const Row = Schema.Struct({ value_json: Schema.String });
/** Device-local preferences and durable stable-id claims use existing prefs, without a migration. */
export class MobileBackgroundStorage extends Context.Service<
  MobileBackgroundStorage,
  {
    readonly preferences: Effect.Effect<MobileBackgroundPreferences>;
    save(preferences: MobileBackgroundPreferences): Effect.Effect<void>;
    claim(message: { id: string; accountId: string }): Effect.Effect<boolean>;
    readonly prune: Effect.Effect<void>;
  }
>()("openmail/MobileBackgroundStorage") {}
export const MobileBackgroundStorageLive = Layer.effect(
  MobileBackgroundStorage,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const preferences = all(Row)(
      sql`SELECT value_json FROM prefs WHERE key='mobile-background:settings'`,
    ).pipe(
      Effect.map((rows) =>
        Option.getOrElse(
          Schema.decodeUnknownOption(Schema.fromJsonString(MobileBackgroundPreferences))(
            rows[0]?.value_json,
          ),
          () => DEFAULT_MOBILE_BACKGROUND,
        ),
      ),
    );
    const prune = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      // Older installs wrote a boolean. Give those claims one final retention window.
      yield* run(sql`UPDATE prefs SET value_json=json_object('at',${now},'accountId',
        (SELECT a.id FROM accounts a WHERE substr(prefs.key,1,length('mobile-background:notified:')+length(a.id)+1)='mobile-background:notified:'||a.id||'/' ORDER BY length(a.id) DESC LIMIT 1))
        WHERE key LIKE 'mobile-background:notified:%' AND value_json='true'`);
      yield* run(sql`DELETE FROM prefs AS p WHERE p.key LIKE 'mobile-background:notified:%' AND
        (NOT json_valid(p.value_json) OR
          (CASE WHEN json_valid(p.value_json) THEN json_extract(p.value_json,'$.at') END)<${now - 30 * 86400000} OR NOT EXISTS
          (SELECT 1 FROM accounts a WHERE a.id=(CASE WHEN json_valid(p.value_json) THEN json_extract(p.value_json,'$.accountId') END)))`);
    });
    yield* prune;
    return MobileBackgroundStorage.of({
      prune,
      preferences,
      save: (value) =>
        run(
          sql`INSERT INTO prefs (key,value_json) VALUES ('mobile-background:settings',${JSON.stringify(value)}) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json`,
        ),
      // Claim before OS submission. An interrupted submission may omit one alert but never repeats it.
      claim: ({ id, accountId }) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const rows = yield* all(Row)(
            sql`INSERT INTO prefs (key,value_json) VALUES (${`mobile-background:notified:${id}`},${JSON.stringify({ at: now, accountId })}) ON CONFLICT(key) DO NOTHING RETURNING value_json`,
          );
          return rows.length > 0;
        }),
    });
  }),
);

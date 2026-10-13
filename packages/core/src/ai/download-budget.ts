import { Clock, Effect } from "effect";
/** A shared reservation budget for both OCR and semantic attachment backfills. */
export const makeDownloadBudget = Effect.gen(function* () {
  let started = yield* Clock.currentTimeMillis;
  let reserved = 0;
  return Effect.fnUntraced(function* (bytes: number) {
    const charge = Math.min(Math.max(bytes, 1), 32 * 1024 * 1024);
    for (;;) {
      const now = yield* Clock.currentTimeMillis;
      if (now - started >= 60_000) {
        started = now;
        reserved = 0;
      }
      if (reserved + charge <= 32 * 1024 * 1024) {
        reserved += charge;
        return;
      }
      yield* Effect.sleep("1 second");
    }
  });
});

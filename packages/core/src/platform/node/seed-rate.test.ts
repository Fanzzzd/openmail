import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { Store } from "../../store/service.js";
import { StoreLive } from "../../store/store.js";
import { MemoryPlatform } from "./platform-memory.js";
import { fixtureAccounts, fixtureMessage } from "./fixtures/performance-mailbox.js";
import { perfBudget } from "../../../test-support/perf-budget.js";
import { perfCalibration } from "../../../test-support/perf-calibration.js";
import { scaledMs } from "../../../test-support/test-time.js";

// Regression guard: the on-open PRAGMA optimize recorded statistics for the empty FTS5 tables
// (fixed in d5194310). Every later insert planned the index lookups as scans, and seeding the
// 100k performance mailbox went from 5 s to 4 minutes per 10k messages. Only the weekly perf job
// noticed. The default suite checks the growth bound only, which holds under load. The absolute
// budget runs on CI and with OPENMAIL_PERF=1. See docs/testing.md#tests-under-load.
const MESSAGES = 10_000;
const CHUNK = 2_000;
/**
 * 10k messages take about 3.7 s on the reference machine (perf-calibration.ts), and 12.8 s with
 * the regression put back. The budget grows with the calibration ratio on slower runners.
 */
const BUDGET_MS = 6_000;
/**
 * Inserts stay about as fast while the indexes grow (1.1x here). With the regression the last
 * 2k took 4.9x as long as the first, on any machine.
 */
const MAX_GROWTH = 2.5;
/**
 * A slice of the CPU calibration loop (a third of perf-calibration.ts's, 11 ms on the reference
 * machine), timed before and after each chunk. Load that starts mid-run slows the loop as much as
 * the seeding, so a chunk's time divided by its ratio no longer depends on the load.
 */
const SLICE_ITERATIONS = 10_000_000;
const SLICE_REFERENCE_MS = 11;
const sliceRatio = () => {
  const samples = [0, 1, 2].map(() => {
    const start = performance.now();
    let hash = 2166136261;
    for (let i = 0; i < SLICE_ITERATIONS; i++) hash = Math.imul(hash ^ (i & 0xff), 16777619) >>> 0;
    const ms = performance.now() - start;
    // Keeps the loop from being optimized away.
    if (hash === 0.5) throw new Error("unreachable");
    return ms;
  });
  return (samples.toSorted((a, b) => a - b)[1] ?? 1) / SLICE_REFERENCE_MS;
};
/** The absolute budget needs a quiet machine, so only CI and the perf runs assert it. */
const ASSERT_BUDGET = Boolean(process.env.CI) || process.env.OPENMAIL_PERF === "1";

it(
  "seeding 10k messages into a file database stays within its insert budget",
  async () => {
    // Before the seeding, so its garbage does not slow the fixed work down.
    const before = perfCalibration();
    const directory = mkdtempSync(join(tmpdir(), "openmail-seed-rate-"));
    try {
      const ratios: number[] = [];
      const normalised: number[] = [];
      const chunksMs = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Store;
          for (const [a, provider] of (["gmail", "outlook", "imap"] as const).entries())
            yield* store.upsertAccount(provider, `perf${a}@example.com`);
          const chunks: number[] = [];
          let ratioBefore = sliceRatio();
          for (let chunk = 0; chunk < MESSAGES; chunk += CHUNK) {
            const start = performance.now();
            for (let batch = chunk; batch < chunk + CHUNK; batch += 500)
              yield* store.transaction(
                Effect.forEach(
                  Array.from({ length: 500 }, (_, i) => fixtureMessage(batch + i)),
                  (message) =>
                    store.upsertMessage(
                      fixtureAccounts[Number(message.threadId.slice(6)) % 3] ?? "",
                      message,
                    ),
                  { discard: true },
                ),
              );
            const elapsed = performance.now() - start;
            const ratioAfter = sliceRatio();
            const ratio = Math.max(1, ratioBefore, ratioAfter);
            chunks.push(elapsed);
            ratios.push(ratio);
            normalised.push(elapsed / ratio);
            ratioBefore = ratioAfter;
          }
          return chunks;
        }).pipe(
          // The real open path on a new file: migrations, then the on-open planner refresh.
          Effect.provide(
            StoreLive.pipe(
              Layer.provideMerge(MemoryPlatform({ database: join(directory, "mail.db") })),
            ),
          ),
        ),
      );
      const { ratio: startRatio, cpuMs, sqliteMs } = before;
      const ratio = Math.max(startRatio, ...ratios);
      const totalMs = chunksMs.reduce((sum, ms) => sum + ms, 0);
      const budgetMs = perfBudget(BUDGET_MS) * Math.max(1, ratio);
      const growth = (normalised.at(-1) ?? 0) / (normalised[0] ?? 1);
      const summary = `seed-rate budget, see docs/testing.md#tests-under-load (OPENMAIL_PERF_FACTOR=2 relaxes it locally): seeding ${MESSAGES} messages took ${Math.round(totalMs)} ms (budget ${Math.round(budgetMs)} ms at calibration ratio ${ratio.toFixed(2)}: CPU ${cpuMs.toFixed(1)} ms, SQLite ${sqliteMs.toFixed(1)} ms); per ${CHUNK}: ${chunksMs.map((ms) => Math.round(ms)).join(", ")} ms; per chunk ratio ${ratios.map((r) => r.toFixed(2)).join(", ")}`;
      process.stdout.write(`${summary}\n`);
      if (ASSERT_BUDGET) expect(totalMs, summary).toBeLessThan(budgetMs);
      expect(
        growth,
        `last ${CHUNK} over first ${CHUNK}: ${growth.toFixed(2)}x; ${summary}`,
      ).toBeLessThan(MAX_GROWTH);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  scaledMs(60_000),
);

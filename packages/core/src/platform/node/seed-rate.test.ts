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

// Round 9: the on-open PRAGMA optimize recorded statistics for the empty FTS5 tables, every
// later insert planned the index lookups as scans, and seeding the 100k performance mailbox went
// from 5 s to 4 minutes per 10k messages. Only the weekly perf job noticed. This runs in Check.
const MESSAGES = 10_000;
const CHUNK = 2_000;
/**
 * 10k messages take about 3.7 s on the reference machine (perf-calibration.ts), and 12.8 s with
 * the round 9 bug put back. The budget grows with the calibration ratio on slower runners.
 */
const BUDGET_MS = 6_000;
/**
 * Inserts stay about as fast while the indexes grow (1.1x here). With the round 9 bug the last
 * 2k took 4.9x as long as the first, on any machine.
 */
const MAX_GROWTH = 2.5;

it("seeding 10k messages into a file database stays within its insert budget", async () => {
  // Before the seeding, so its garbage does not slow the fixed work down.
  const calibration = perfCalibration();
  const directory = mkdtempSync(join(tmpdir(), "openmail-seed-rate-"));
  try {
    const chunksMs = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store;
        for (const [a, provider] of (["gmail", "outlook", "imap"] as const).entries())
          yield* store.upsertAccount(provider, `perf${a}@example.com`);
        const chunks: number[] = [];
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
          chunks.push(performance.now() - start);
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
    const { ratio, cpuMs, sqliteMs } = calibration;
    const totalMs = chunksMs.reduce((sum, ms) => sum + ms, 0);
    const budgetMs = perfBudget(BUDGET_MS) * Math.max(1, ratio);
    const growth = (chunksMs.at(-1) ?? 0) / (chunksMs[0] ?? 1);
    const summary = `seeding ${MESSAGES} messages took ${Math.round(totalMs)} ms (budget ${Math.round(budgetMs)} ms at calibration ratio ${ratio.toFixed(2)}: CPU ${cpuMs.toFixed(1)} ms, SQLite ${sqliteMs.toFixed(1)} ms); per ${CHUNK}: ${chunksMs.map((ms) => Math.round(ms)).join(", ")} ms`;
    process.stdout.write(`${summary}\n`);
    expect(totalMs, summary).toBeLessThan(budgetMs);
    expect(
      growth,
      `last ${CHUNK} over first ${CHUNK}: ${growth.toFixed(2)}x; ${summary}`,
    ).toBeLessThan(MAX_GROWTH);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);

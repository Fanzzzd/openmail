import { existsSync, rmSync, writeFileSync } from "node:fs";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { Store } from "../../services.js";
import { StoreLive } from "../../store.js";
import { SearchProfile } from "../../search-profile.js";
import { MemoryPlatform } from "./platform-memory.js";
import { fixtureNow, seedMailbox, traceQueries } from "./fixtures/performance-mailbox.js";

const defaultDatabase = "/tmp/openmail-search-profile.db";

type Timing = { step: string; inclusiveMs: number; exclusiveMs: number };
const median = (values: readonly number[]) =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

it.effect.skipIf(process.env.OPENMAIL_SEARCH_PROFILE !== "1")(
  "profiles every SQL and memory step of the 100k mixed search",
  () => {
    const database = process.env.OPENMAIL_PROFILE_DATABASE ?? defaultDatabase;
    const output = process.env.OPENMAIL_PROFILE_REPORT ?? "/tmp/openmail-search-profile.json";
    const samples: { totalMs: number; timings: Timing[] }[] = [];
    let active = false;
    const timings: Timing[] = [];
    const stack: { step: string; start: number; childMs: number }[] = [];
    const begin = (step: string) => {
      if (!active)
        return () => {
          // Plan capture and warmups do not record timings.
        };
      const frame = { step, start: performance.now(), childMs: 0 };
      stack.push(frame);
      return () => {
        const elapsed = performance.now() - frame.start;
        assert.strictEqual(stack.pop(), frame);
        const parent = stack.at(-1);
        if (parent) parent.childMs += elapsed;
        timings.push({ step, inclusiveMs: elapsed, exclusiveMs: elapsed - frame.childMs });
      };
    };
    const queryIds = new Map<string, number>();
    const trace = traceQueries((query, phase) => {
      let id = queryIds.get(query);
      if (id === undefined) {
        id = queryIds.size + 1;
        queryIds.set(query, id);
      }
      return begin(`SQL ${id} ${phase}`);
    });
    return Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      yield* TestClock.setTime(fixtureNow);
      const [count] = yield* sql`SELECT COUNT(*) AS n FROM messages`;
      if (count?.n === 0) yield* seedMailbox(100_000);
      else assert.strictEqual(count?.n, 100_000);
      yield* sql`PRAGMA cache_size=-8192`;
      yield* sql`ANALYZE`;
      const query = store.listThreads({ search: "weekly", limit: 200 });
      queryIds.clear();
      trace.start();
      yield* query;
      const plans = trace.stop();
      for (let i = 0; i < 2; i++) yield* query;
      for (let i = 0; i < 7; i++) {
        timings.length = 0;
        active = true;
        const started = performance.now();
        const rows = yield* query;
        const totalMs = performance.now() - started;
        active = false;
        assert.strictEqual(stack.length, 0);
        timings.push({
          step: "other orchestration",
          inclusiveMs: totalMs - timings.reduce((sum, timing) => sum + timing.exclusiveMs, 0),
          exclusiveMs: totalMs - timings.reduce((sum, timing) => sum + timing.exclusiveMs, 0),
        });
        assert.strictEqual(rows.length, 200);
        assert.isTrue(
          rows.every((row) => row.searchMatches?.some((match) => match.source !== "attachment")),
        );
        assert.isTrue(
          rows.some((row) => row.searchMatches?.some((match) => match.source === "attachment")),
        );
        samples.push({ totalMs, timings: [...timings] });
      }
      const steps = [
        ...new Set([
          ...samples.flatMap((sample) => sample.timings.map((timing) => timing.step)),
          ...plans.map((plan) => `SQL ${queryIds.get(plan.sql)} prepare`),
          "exact phrase check",
        ]),
      ].map((step) => ({
        step,
        medianInclusiveMs: median(
          samples.map((sample) =>
            sample.timings
              .filter((timing) => timing.step === step)
              .reduce((sum, timing) => sum + timing.inclusiveMs, 0),
          ),
        ),
        medianExclusiveMs: median(
          samples.map((sample) =>
            sample.timings
              .filter((timing) => timing.step === step)
              .reduce((sum, timing) => sum + timing.exclusiveMs, 0),
          ),
        ),
        calls: samples.map(
          (sample) => sample.timings.filter((timing) => timing.step === step).length,
        ),
      }));
      const report = {
        node: process.version,
        database,
        messages: 100_000,
        limit: 200,
        medianMs: median(samples.map((sample) => sample.totalMs)),
        queries: plans.map((plan) => ({ id: queryIds.get(plan.sql), ...plan })),
        steps,
        samples,
      };
      writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
      process.stdout.write(
        `Mixed search median: ${report.medianMs.toFixed(2)} ms; report: ${output}\n`,
      );
      assert.isAtMost(report.medianMs, 100);
    }).pipe(
      Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform({ database })))),
      Effect.provideService(SearchProfile, { begin }),
      Effect.scoped,
      Effect.ensuring(
        Effect.sync(() => {
          trace.restore();
          if (database === defaultDatabase) {
            for (const suffix of ["", "-wal", "-shm", "-journal"])
              rmSync(`${database}${suffix}`, { force: true });
            assert.isFalse(existsSync(database));
          }
        }),
      ),
    );
  },
  { timeout: 1_200_000 },
);

import { availableParallelism, loadavg } from "node:os";

/**
 * Local multiplier from the one-minute load average per CPU, between 1 and 3. An idle laptop
 * gets 1; one running several suites, builds and agents at once gets up to 3.
 */
const loadScale = () => {
  const perCpu = (loadavg()[0] ?? 0) / availableParallelism();
  return Math.min(3, Math.max(1, Math.round(perCpu * 10) / 10));
};

/**
 * Multiplier for the real-time limits tests wait under: polls, child process start-up and
 * per-test timeouts. Shared CI runners and loaded laptops run the same work several times
 * slower, so a limit tuned on an idle machine flakes there. CI gets 3; elsewhere the load
 * average sets it once, when the Vitest config first loads this module, and the value goes to
 * the workers through OPENMAIL_TEST_TIME_SCALE, so every file of a run uses the same number.
 * Set OPENMAIL_TEST_TIME_SCALE yourself to override. Virtual time (TestClock, fake timers)
 * never scales.
 */
export const testTimeScale =
  Number(process.env.OPENMAIL_TEST_TIME_SCALE) || (process.env.CI ? 3 : loadScale());
if (!Number(process.env.OPENMAIL_TEST_TIME_SCALE))
  process.env.OPENMAIL_TEST_TIME_SCALE = String(testTimeScale);

/** A real-time limit stretched by `testTimeScale`. */
export const scaledMs = (ms: number) => Math.round(ms * testTimeScale);

/**
 * Options for `vi.waitFor` and `expect.poll`, whose own default gives up after one second. A
 * wait that passes returns at once, so the generous limit only matters when a test fails.
 */
export const waitLimit = { timeout: scaledMs(10_000) };

/** The `expect.poll` defaults for a Vitest config: the same scaled limit as `waitLimit`. */
export const pollDefaults = { poll: waitLimit };

/**
 * Per-test and per-hook timeouts for every Vitest config. Vitest's own 5 and 10 seconds are
 * shorter than `waitLimit` and fail tests that only ran slowly on a loaded machine.
 */
export const testTimeouts = { testTimeout: scaledMs(30_000), hookTimeout: scaledMs(60_000) };

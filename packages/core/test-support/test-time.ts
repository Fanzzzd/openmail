/**
 * Multiplier for the real-time limits tests wait under: polls, child process start-up and
 * per-test timeouts. Shared CI runners and loaded laptops run the same work several times
 * slower, so a limit tuned on an idle machine flakes there. CI gets 3; set
 * OPENMAIL_TEST_TIME_SCALE to override. Virtual time (TestClock, fake timers) never scales.
 */
export const testTimeScale =
  Number(process.env.OPENMAIL_TEST_TIME_SCALE) || (process.env.CI ? 3 : 1);

/** A real-time limit stretched by `testTimeScale`. */
export const scaledMs = (ms: number) => Math.round(ms * testTimeScale);

/** Options for `vi.waitFor` and `expect.poll`, whose own default gives up after one second. */
export const waitLimit = { timeout: scaledMs(2_000) };

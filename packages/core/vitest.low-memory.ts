/** Opt-in for resource-constrained local verification; normal runs retain isolation. */
export const lowMemoryTests =
  process.env.OPENMAIL_LOW_MEMORY_TESTS === "1"
    ? {
        maxWorkers: 1,
        fileParallelism: false,
        isolate: false,
        testTimeout: 60_000,
        hookTimeout: 60_000,
      }
    : {};

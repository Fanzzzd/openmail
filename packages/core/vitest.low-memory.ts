import { globSync, readFileSync } from "node:fs";
import path from "node:path";
import { testTimeouts } from "./test-support/test-time.js";

/** Opt-in for resource-constrained local verification. */
export const lowMemory = process.env.OPENMAIL_LOW_MEMORY_TESTS === "1";

export const lowMemoryTests = lowMemory
  ? {
      maxWorkers: 1,
      fileParallelism: false,
      testTimeout: Math.max(60_000, testTimeouts.testTimeout),
      hookTimeout: Math.max(60_000, testTimeouts.hookTimeout),
    }
  : {};

/**
 * Test files that replace modules with vi.mock or vi.doMock. In a shared module graph they would
 * get whichever copy an earlier file loaded, so they run with isolation.
 */
export const mockingTests = (root: string, pattern: string) =>
  globSync(pattern, { cwd: root }).filter((file) =>
    /\bvi\.(mock|doMock)\(/.test(readFileSync(path.join(root, file), "utf8")),
  );

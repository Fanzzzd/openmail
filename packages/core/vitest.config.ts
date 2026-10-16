import { defineConfig } from "vitest/config";
import { lowMemory, lowMemoryTests, mockingTests } from "./vitest.low-memory.js";
import { testTimeouts } from "./test-support/test-time.js";

const include = ["src/**/*.test.ts"];
const exclude =
  process.env.OPENMAIL_PERF === "1" ? [] : ["src/platform/node/performance-large.test.ts"];
const mocking = lowMemory ? mockingTests(import.meta.dirname, "src/**/*.test.ts") : [];

// Tests run from source; the build (tsconfig.build.json) leaves them out of dist.
export default defineConfig({
  test: {
    ...testTimeouts,
    ...lowMemoryTests,
    environment: "node",
    globalSetup: ["./test-support/temp-directory.ts"],
    // Low-memory runs share one module graph, except for files that mock modules.
    ...(lowMemory
      ? {
          projects: [
            {
              extends: true,
              test: { name: "shared", isolate: false, include, exclude: [...exclude, ...mocking] },
            },
            { extends: true, test: { name: "mocking", include: mocking, exclude } },
          ],
        }
      : { include, exclude }),
  },
});

import { defineConfig } from "vitest/config";
import { lowMemoryTests } from "./vitest.low-memory.js";

// Tests run from source; the build (tsconfig.build.json) leaves them out of dist.
export default defineConfig({
  test: {
    ...lowMemoryTests,
    environment: "node",
    globalSetup: ["./test-support/temp-directory.ts"],
    include: ["src/**/*.test.ts"],
    exclude:
      process.env.OPENMAIL_PERF === "1" ? [] : ["src/platform/node/performance-large.test.ts"],
  },
});

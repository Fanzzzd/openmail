import { defineConfig } from "vitest/config";
import { testTimeouts } from "../../packages/core/test-support/test-time.js";

export default defineConfig({
  test: {
    ...testTimeouts,
    environment: "node",
    globalSetup: ["../../packages/core/test-support/temp-directory.ts"],
    include: ["src/**/*.test.ts"],
    maxWorkers: 1,
    fileParallelism: false,
    // Load the built core natively instead of transforming its dist for every file.
    server: { deps: { external: [/packages\/core\/dist\//] } },
  },
});

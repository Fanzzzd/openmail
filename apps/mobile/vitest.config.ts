import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["../../packages/core/test-support/temp-directory.ts"],
    include: ["src/**/*.test.ts"],
    maxWorkers: 1,
    fileParallelism: false,
    // Load the built core natively instead of transforming its dist for every file.
    server: { deps: { external: [/packages\/core\/dist\//] } },
  },
});

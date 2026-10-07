import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["../../packages/core/test-support/temp-directory.ts"],
    include: ["src/**/*.test.ts"],
    maxWorkers: 1,
    fileParallelism: false,
  },
});

import { defineConfig } from "vitest/config";
import config from "./vitest.config";
import { scaledMs } from "../../packages/core/test-support/test-time.js";

export default defineConfig({
  ...config,
  test: {
    ...config.test,
    environment: "jsdom",
    include: ["src/renderer/src/e2e/*.test.ts"],
    exclude: [],
    setupFiles: ["src/renderer/src/e2e/setup.ts"],
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: scaledMs(20_000),
    hookTimeout: scaledMs(20_000),
  },
});
